import { Effect } from 'effect';
import { api } from '../../convex/_generated/api';
import type { Doc } from '../../convex/_generated/dataModel';
import { INCIDENT_LABELS, INCIDENT_ROUTE_PENALTY, type GeoPoint } from '$lib/domain/traffic';
import {
	DEFAULT_ROUTING_PREFERENCES,
	normalizeRoutingPreferences,
	type RoutingPreferences
} from '$lib/domain/routing';
import { ConvexPrivateService } from '$lib/services/convex';
import {
	boundsFromPoints,
	distancePointToPolylineMeters,
	distancePolylineToPolylineMeters,
	expandBounds
} from './geo';
import { fetchDirections, type ProviderRoute } from './mapbox';
import { applyRoutingPreferences } from './route-personalization';

export interface RankedRoute {
	routeId: string;
	providerRouteId?: string;
	label: string;
	geometry: GeoPoint[];
	distanceMeters: number;
	durationSec: number;
	adjustedScore: number;
	estimatedFuelLiters: number;
	estimatedTollCostUsd: number;
	explanationChips: string[];
	incidentIds: Doc<'incidents'>['_id'][];
	shortcutIds: Doc<'shortcutSegments'>['_id'][];
}

export interface RankedRouteResult {
	routes: RankedRoute[];
	generatedAt: number;
	incidentsConsidered: number;
	shortcutsConsidered: number;
}

const findRouteIncidents = (route: ProviderRoute, incidents: Doc<'incidents'>[]) => {
	const incidentIds: Doc<'incidents'>['_id'][] = [];
	let penalty = 0;
	const explanationChips = new Set<string>();

	for (const incident of incidents) {
		const distance = distancePointToPolylineMeters(incident.location, route.geometry);

		if (distance > 180) {
			continue;
		}

		incidentIds.push(incident._id);
		const basePenalty = INCIDENT_ROUTE_PENALTY[incident.type];
		penalty += basePenalty * (0.35 + incident.confidenceScore * 0.65);

		if (incident.confidenceScore < 0.55) {
			explanationChips.add('Low confidence report');
		} else {
			explanationChips.add(`Avoids ${INCIDENT_LABELS[incident.type].en.toLowerCase()}`);
		}
	}

	return {
		incidentIds,
		penalty,
		explanationChips: [...explanationChips]
	};
};

const findRouteShortcuts = (route: ProviderRoute, shortcuts: Doc<'shortcutSegments'>[]) => {
	const shortcutIds: Doc<'shortcutSegments'>['_id'][] = [];
	let bonus = 0;
	const explanationChips = new Set<string>();

	for (const shortcut of shortcuts) {
		const distance = distancePolylineToPolylineMeters(route.geometry, shortcut.polyline);

		if (distance > 90) {
			continue;
		}

		shortcutIds.push(shortcut._id);
		bonus += shortcut.weight * 120;
		explanationChips.add('Uses alley shortcut');
	}

	return {
		shortcutIds,
		bonus,
		explanationChips: [...explanationChips]
	};
};

export const requestRankedRoutes = ({
	origin,
	destination,
	preferences = DEFAULT_ROUTING_PREFERENCES
}: {
	origin: GeoPoint;
	destination: GeoPoint;
	preferences?: RoutingPreferences;
}) =>
	Effect.gen(function* () {
		const convex = yield* ConvexPrivateService;
		const viewport = expandBounds(boundsFromPoints([origin, destination]), 0.025);
		const startedAt = Date.now();
		const normalizedPreferences = normalizeRoutingPreferences(preferences);

		yield* convex.mutation({
			func: api.private.incidents.expireStale,
			args: {
				now: startedAt
			}
		});

		const [incidents, shortcuts, providerRoutes] = yield* Effect.all([
			convex.query({
				func: api.private.incidents.listForRouteWindow,
				args: {
					startedAt,
					viewport
				}
			}),
			convex.query({
				func: api.private.shortcuts.listActive,
				args: {}
			}),
			Effect.tryPromise({
				try: () => fetchDirections({ origin, destination, preferences: normalizedPreferences }),
				catch: (cause) =>
					cause instanceof Error ? cause : new Error('Failed to request Mapbox directions')
			})
		]);

		const rankedRoutes = (providerRoutes as ProviderRoute[])
			.map((route: ProviderRoute, index: number) => {
				const incidentMatch = findRouteIncidents(route, incidents);
				const shortcutMatch = findRouteShortcuts(route, shortcuts);
				const preferenceMatch = applyRoutingPreferences({
					baseDurationSec: route.durationSec,
					distanceMeters: route.distanceMeters,
					incidentPenalty: incidentMatch.penalty,
					shortcutBonus: shortcutMatch.bonus,
					shortcutCount: shortcutMatch.shortcutIds.length,
					metrics: route.metrics,
					preferences: normalizedPreferences,
					generatedAt: startedAt
				});

				return {
					routeId: `route-${index + 1}`,
					providerRouteId: route.providerRouteId,
					label: route.label,
					geometry: route.geometry,
					distanceMeters: route.distanceMeters,
					durationSec: route.durationSec,
					adjustedScore: preferenceMatch.adjustedScore,
					estimatedFuelLiters: preferenceMatch.estimatedFuelLiters,
					estimatedTollCostUsd: preferenceMatch.estimatedTollCostUsd,
					explanationChips: [
						...new Set([
							...preferenceMatch.personalizationChips,
							...incidentMatch.explanationChips,
							...shortcutMatch.explanationChips
						])
					],
					incidentIds: incidentMatch.incidentIds,
					shortcutIds: shortcutMatch.shortcutIds
				} satisfies RankedRoute;
			})
			.sort((left: RankedRoute, right: RankedRoute) => left.adjustedScore - right.adjustedScore)
			.slice(0, 3)
			.map((route: RankedRoute, index: number) => ({
				...route,
				label:
					index === 0
						? 'Best overall'
						: route.shortcutIds.length > 0
							? 'Shortcut option'
							: 'Alternative'
			}));

		return {
			routes: rankedRoutes,
			generatedAt: startedAt,
			incidentsConsidered: incidents.length,
			shortcutsConsidered: shortcuts.length
		} satisfies RankedRouteResult;
	});
