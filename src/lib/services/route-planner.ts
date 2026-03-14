import { env } from '$env/dynamic/public';
import type { Doc } from '../../convex/_generated/dataModel';
import { INCIDENT_LABELS, INCIDENT_ROUTE_PENALTY, type GeoPoint } from '$lib/domain/traffic';
import {
	distancePointToPolylineMeters,
	distancePolylineToPolylineMeters,
	haversineMeters
} from './geo';

export type TrafficLevel = 'clear' | 'light' | 'moderate' | 'heavy' | 'severe';

export interface TrafficSegment {
	geometry: GeoPoint[];
	level: TrafficLevel;
	distanceMeters: number;
}

export interface NavigationCue {
	modifier:
		| 'straight'
		| 'slight right'
		| 'right'
		| 'sharp right'
		| 'slight left'
		| 'left'
		| 'sharp left'
		| 'uturn'
		| 'arrive';
	instruction: string;
	roadName: string;
	distanceMeters: number;
}

interface ProviderRoute {
	providerRouteId?: string;
	label: string;
	geometry: GeoPoint[];
	distanceMeters: number;
	durationSec: number;
	trafficSegments: TrafficSegment[];
	trafficLevel: TrafficLevel;
	trafficSummary: string;
	navigationCue: NavigationCue;
}

export interface RankedClientRoute {
	routeId: string;
	providerRouteId?: string;
	label: string;
	geometry: GeoPoint[];
	distanceMeters: number;
	durationSec: number;
	adjustedScore: number;
	explanationChips: string[];
	incidentIds: Doc<'incidents'>['_id'][];
	shortcutIds: Doc<'shortcutSegments'>['_id'][];
	trafficLevel: TrafficLevel;
	trafficSummary: string;
	trafficSegments: TrafficSegment[];
	trafficEnabled: boolean;
	arrivalTime: number;
	navigationCue: NavigationCue;
}

export interface RankedClientRouteResult {
	routes: RankedClientRoute[];
	generatedAt: number;
	incidentsConsidered: number;
	shortcutsConsidered: number;
}

interface MapboxDirectionsResponse {
	routes: Array<{
		geometry: {
			coordinates: [number, number][];
		};
		distance: number;
		duration: number;
		weight_name?: string;
		legs?: Array<{
			annotation?: {
				congestion?: string[];
				distance?: number[];
			};
			steps?: Array<{
				distance: number;
				name?: string;
				maneuver?: {
					type?: string;
					modifier?: string;
					instruction?: string;
				};
			}>;
		}>;
	}>;
}

const FALLBACK_MODIFIERS: NavigationCue['modifier'][] = ['right', 'left', 'straight'];

const formatDistanceLabel = (distanceMeters: number) =>
	distanceMeters >= 1000
		? `${(distanceMeters / 1000).toFixed(distanceMeters >= 10_000 ? 0 : 1)} km`
		: `${Math.max(20, Math.round(distanceMeters / 10) * 10)} m`;

const normalizeTrafficLevel = (value?: string): TrafficLevel => {
	switch (value?.toLowerCase()) {
		case 'low':
			return 'light';
		case 'moderate':
			return 'moderate';
		case 'heavy':
			return 'heavy';
		case 'severe':
			return 'severe';
		case 'unknown':
			return 'light';
		default:
			return 'clear';
	}
};

const normalizeModifier = (modifier?: string, type?: string): NavigationCue['modifier'] => {
	if (type === 'arrive') return 'arrive';
	if (modifier === 'uturn') return 'uturn';
	if (modifier === 'sharp right') return 'sharp right';
	if (modifier === 'slight right') return 'slight right';
	if (modifier === 'right') return 'right';
	if (modifier === 'sharp left') return 'sharp left';
	if (modifier === 'slight left') return 'slight left';
	if (modifier === 'left') return 'left';
	return 'straight';
};

const buildInstruction = ({
	modifier,
	roadName
}: {
	modifier: NavigationCue['modifier'];
	roadName: string;
}) => {
	if (modifier === 'arrive') {
		return 'Arrive at destination';
	}

	if (modifier === 'uturn') {
		return `Make a U-turn${roadName ? ` onto ${roadName}` : ''}`;
	}

	if (modifier === 'straight') {
		return `Continue on ${roadName}`;
	}

	return `Turn ${modifier}${roadName ? ` onto ${roadName}` : ''}`;
};

const createTrafficSummary = (segments: TrafficSegment[]) => {
	const severeDistance = segments
		.filter((segment) => segment.level === 'severe')
		.reduce((sum, segment) => sum + segment.distanceMeters, 0);
	const heavyDistance = segments
		.filter((segment) => segment.level === 'heavy')
		.reduce((sum, segment) => sum + segment.distanceMeters, 0);
	const moderateDistance = segments
		.filter((segment) => segment.level === 'moderate')
		.reduce((sum, segment) => sum + segment.distanceMeters, 0);

	if (severeDistance > 250) {
		return `Severe slowdown for ${formatDistanceLabel(severeDistance)}`;
	}

	if (heavyDistance > 350) {
		return `Heavy traffic for ${formatDistanceLabel(heavyDistance)}`;
	}

	if (moderateDistance > 500) {
		return `Moderate congestion for ${formatDistanceLabel(moderateDistance)}`;
	}

	return 'Traffic is moving well';
};

const getDominantTrafficLevel = (segments: TrafficSegment[]): TrafficLevel => {
	if (segments.some((segment) => segment.level === 'severe')) return 'severe';
	if (segments.some((segment) => segment.level === 'heavy')) return 'heavy';
	if (segments.some((segment) => segment.level === 'moderate')) return 'moderate';
	if (segments.some((segment) => segment.level === 'light')) return 'light';
	return 'clear';
};

const createTrafficSegments = (
	geometry: GeoPoint[],
	congestionLevels: string[] | undefined,
	distances: number[] | undefined
) => {
	const segments: TrafficSegment[] = [];

	for (let index = 0; index < geometry.length - 1; index += 1) {
		const start = geometry[index];
		const end = geometry[index + 1];

		segments.push({
			geometry: [start, end],
			level: normalizeTrafficLevel(congestionLevels?.[index]),
			distanceMeters: distances?.[index] ?? haversineMeters(start, end)
		});
	}

	return segments;
};

const createFallbackTrafficSegments = (geometry: GeoPoint[], variant: number): TrafficSegment[] =>
	geometry.slice(0, -1).map(
		(point, index): TrafficSegment => ({
			geometry: [point, geometry[index + 1]],
			level:
				variant === 0
					? index === 0
						? 'light'
						: 'clear'
					: variant === 1
						? index === 1
							? 'moderate'
							: 'light'
						: index === 1
							? 'heavy'
							: 'moderate',
			distanceMeters: haversineMeters(point, geometry[index + 1])
		})
	);

const createFallbackCue = (
	variant: number,
	destinationDistance: number,
	destinationName = 'campus approach'
): NavigationCue => {
	const modifier = FALLBACK_MODIFIERS[variant] ?? 'straight';
	const roadName =
		variant === 0 ? 'Main approach' : variant === 1 ? 'Inner connector' : 'Shortcut lane';

	return {
		modifier,
		roadName,
		distanceMeters: Math.max(120, destinationDistance * (variant === 2 ? 0.18 : 0.25)),
		instruction: buildInstruction({
			modifier,
			roadName: `${roadName} toward ${destinationName}`
		})
	};
};

const makeFallbackRoutes = (origin: GeoPoint, destination: GeoPoint): ProviderRoute[] => {
	const midpoint = {
		lat: (origin.lat + destination.lat) / 2,
		lng: (origin.lng + destination.lng) / 2
	};
	const distance = haversineMeters(origin, destination);
	const directDuration = Math.round((distance / 7.5) * 3.6);

	const candidates = [
		{
			providerRouteId: 'fallback-fastest',
			label: 'Fastest',
			geometry: [origin, midpoint, destination],
			distanceMeters: distance * 1.04,
			durationSec: directDuration
		},
		{
			providerRouteId: 'fallback-safer',
			label: 'Safer',
			geometry: [origin, { lat: midpoint.lat + 0.01, lng: midpoint.lng - 0.008 }, destination],
			distanceMeters: distance * 1.12,
			durationSec: Math.round(directDuration * 1.08)
		},
		{
			providerRouteId: 'fallback-shortcut',
			label: 'Shortcut',
			geometry: [origin, { lat: midpoint.lat - 0.008, lng: midpoint.lng + 0.01 }, destination],
			distanceMeters: distance * 0.96,
			durationSec: Math.round(directDuration * 0.94)
		}
	];

	return candidates.map((candidate, index) => {
		const trafficSegments = createFallbackTrafficSegments(candidate.geometry, index);

		return {
			...candidate,
			trafficSegments,
			trafficLevel: getDominantTrafficLevel(trafficSegments),
			trafficSummary: createTrafficSummary(trafficSegments),
			navigationCue: createFallbackCue(index, candidate.distanceMeters)
		};
	});
};

const normalizeRoutes = (routes: MapboxDirectionsResponse['routes']): ProviderRoute[] =>
	routes.slice(0, 3).map((route, index) => {
		const geometry = route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
		const firstLeg = route.legs?.[0];
		const congestionLevels = route.legs?.flatMap((leg) => leg.annotation?.congestion ?? []) ?? [];
		const distances = route.legs?.flatMap((leg) => leg.annotation?.distance ?? []) ?? [];
		const trafficSegments = createTrafficSegments(geometry, congestionLevels, distances);
		const cueStep =
			route.legs
				?.flatMap((leg) => leg.steps ?? [])
				.find((step) => step.distance > 25 && (step.name || step.maneuver?.type !== 'depart')) ??
			firstLeg?.steps?.[0];
		const modifier = normalizeModifier(cueStep?.maneuver?.modifier, cueStep?.maneuver?.type);
		const roadName = cueStep?.name?.trim() || 'current road';

		return {
			providerRouteId: `${route.weight_name ?? 'mapbox'}-${index + 1}`,
			label: index === 0 ? 'Fastest' : index === 1 ? 'Safer' : 'Shortcut',
			geometry,
			distanceMeters: route.distance,
			durationSec: route.duration,
			trafficSegments,
			trafficLevel: getDominantTrafficLevel(trafficSegments),
			trafficSummary: createTrafficSummary(trafficSegments),
			navigationCue: {
				modifier,
				roadName,
				distanceMeters: cueStep?.distance ?? Math.max(80, route.distance * 0.15),
				instruction:
					cueStep?.maneuver?.instruction ??
					buildInstruction({
						modifier,
						roadName
					})
			}
		};
	});

const fetchDirections = async ({
	origin,
	destination
}: {
	origin: GeoPoint;
	destination: GeoPoint;
}) => {
	try {
		const token = env.PUBLIC_MAPBOX_ACCESS_TOKEN?.trim();

		if (!token) {
			return makeFallbackRoutes(origin, destination);
		}

		const url = new URL(
			`https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${origin.lng},${origin.lat};${destination.lng},${destination.lat}`
		);
		url.searchParams.set('alternatives', 'true');
		url.searchParams.set('geometries', 'geojson');
		url.searchParams.set('overview', 'full');
		url.searchParams.set('steps', 'true');
		url.searchParams.set('annotations', 'congestion,distance');
		url.searchParams.set('access_token', token);

		const response = await fetch(url);

		if (!response.ok) {
			return makeFallbackRoutes(origin, destination);
		}

		const data = (await response.json()) as MapboxDirectionsResponse;

		if (!data.routes?.length) {
			return makeFallbackRoutes(origin, destination);
		}

		return normalizeRoutes(data.routes);
	} catch {
		return makeFallbackRoutes(origin, destination);
	}
};

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

export const planRankedRoutes = async ({
	origin,
	destination,
	incidents,
	shortcuts
}: {
	origin: GeoPoint;
	destination: GeoPoint;
	incidents: Doc<'incidents'>[];
	shortcuts: Doc<'shortcutSegments'>[];
}) => {
	const providerRoutes = await fetchDirections({ origin, destination });
	const generatedAt = Date.now();

	const routes = providerRoutes
		.map((route, index) => {
			const incidentMatch = findRouteIncidents(route, incidents);
			const shortcutMatch = findRouteShortcuts(route, shortcuts);
			const adjustedScore = route.durationSec + incidentMatch.penalty - shortcutMatch.bonus;

			return {
				routeId: `route-${index + 1}`,
				providerRouteId: route.providerRouteId,
				label: route.label,
				geometry: route.geometry,
				distanceMeters: route.distanceMeters,
				durationSec: route.durationSec,
				adjustedScore,
				explanationChips: [
					route.trafficSummary,
					...new Set([...incidentMatch.explanationChips, ...shortcutMatch.explanationChips])
				],
				incidentIds: incidentMatch.incidentIds,
				shortcutIds: shortcutMatch.shortcutIds,
				trafficLevel: route.trafficLevel,
				trafficSummary: route.trafficSummary,
				trafficSegments: route.trafficSegments,
				trafficEnabled: true,
				arrivalTime: generatedAt + route.durationSec * 1000,
				navigationCue: route.navigationCue
			} satisfies RankedClientRoute;
		})
		.sort((left, right) => left.adjustedScore - right.adjustedScore)
		.slice(0, 3)
		.map((route, index) => ({
			...route,
			label:
				index === 0
					? 'Best overall'
					: route.shortcutIds.length > 0
						? 'Shortcut option'
						: 'Alternative'
		}));

	return {
		routes,
		generatedAt,
		incidentsConsidered: incidents.length,
		shortcutsConsidered: shortcuts.length
	} satisfies RankedClientRouteResult;
};
