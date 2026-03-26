import type { RoutingPreferences } from '$lib/domain/routing';
import { env } from '$env/dynamic/private';
import type { GeoPoint } from '$lib/domain/traffic';
import { analyzeRouteMetrics, type RouteStepInput } from './route-personalization';
import { haversineMeters } from './geo';

export interface ProviderRoute {
	providerRouteId?: string;
	label: string;
	geometry: GeoPoint[];
	distanceMeters: number;
	durationSec: number;
	steps: RouteStepInput[];
	metrics: ReturnType<typeof analyzeRouteMetrics>;
}

interface MapboxDirectionsResponse {
	routes: Array<{
		geometry: {
			coordinates: [number, number][];
		};
		distance: number;
		duration: number;
		weight_name?: string;
		weight?: number;
		legs?: Array<{
			steps?: Array<{
				distance: number;
				name?: string;
				maneuver?: {
					type?: string;
					modifier?: string;
				};
			}>;
		}>;
	}>;
}

const getMapboxProfile = (mode: RoutingPreferences['mode']) => {
	switch (mode) {
		case 'bike':
			return 'cycling';
		case 'pedestrian':
			return 'walking';
		case 'gas_car':
		case 'diesel_car':
		case 'electric_car':
		case 'car':
		case 'scooter':
		case 'heavy_vehicle':
		default:
			return 'driving-traffic';
	}
};

const getFallbackSpeedMetersPerSecond = (mode: RoutingPreferences['mode']) => {
	switch (mode) {
		case 'pedestrian':
			return 1.4;
		case 'bike':
			return 4.8;
		case 'heavy_vehicle':
			return 5.5;
		case 'scooter':
			return 7.5;
		case 'gas_car':
		case 'diesel_car':
		case 'electric_car':
		case 'car':
		default:
			return 8.5;
	}
};

const makeFallbackRoutes = (
	origin: GeoPoint,
	destination: GeoPoint,
	mode: RoutingPreferences['mode']
): ProviderRoute[] => {
	const midpoint = {
		lat: (origin.lat + destination.lat) / 2,
		lng: (origin.lng + destination.lng) / 2
	};
	const distance = haversineMeters(origin, destination);
	const directDuration = Math.round(distance / getFallbackSpeedMetersPerSecond(mode));

	const routes = [
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

	return routes.map((route, index) => {
		const steps: RouteStepInput[] = [
			{
				distanceMeters: route.distanceMeters * 0.52,
				roadName:
					index === 2 && mode !== 'heavy_vehicle'
						? 'Shortcut lane'
						: index === 1
							? 'Central boulevard'
							: 'Main road',
				maneuverType: 'turn',
				maneuverModifier: index === 1 ? 'left' : 'straight'
			},
			{
				distanceMeters: route.distanceMeters * 0.48,
				roadName: index === 0 ? 'Ring road' : index === 1 ? 'University avenue' : 'Service lane',
				maneuverType: index === 2 ? 'turn' : 'arrive',
				maneuverModifier: index === 2 ? 'right' : undefined
			}
		];

		return {
			...route,
			steps,
			metrics: analyzeRouteMetrics(steps, route.distanceMeters)
		};
	});
};

const normalizeRoutes = (routes: MapboxDirectionsResponse['routes']): ProviderRoute[] =>
	routes.slice(0, 3).map((route, index) => {
		const steps =
			route.legs?.flatMap((leg) =>
				(leg.steps ?? []).map(
					(step): RouteStepInput => ({
						distanceMeters: step.distance,
						roadName: step.name,
						maneuverType: step.maneuver?.type,
						maneuverModifier: step.maneuver?.modifier
					})
				)
			) ?? [];

		return {
			providerRouteId: `${route.weight_name ?? 'mapbox'}-${index + 1}`,
			label: index === 0 ? 'Fastest' : index === 1 ? 'Safer' : 'Shortcut',
			geometry: route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
			distanceMeters: route.distance,
			durationSec: route.duration,
			steps,
			metrics: analyzeRouteMetrics(steps, route.distance)
		};
	});

export const fetchDirections = async ({
	origin,
	destination,
	preferences
}: {
	origin: GeoPoint;
	destination: GeoPoint;
	preferences: RoutingPreferences;
}) => {
	try {
		const token = env.MAPBOX_ACCESS_TOKEN;
		const profile = getMapboxProfile(preferences.mode);

		if (!token) {
			return makeFallbackRoutes(origin, destination, preferences.mode);
		}

		const url = new URL(
			`https://api.mapbox.com/directions/v5/mapbox/${profile}/${origin.lng},${origin.lat};${destination.lng},${destination.lat}`
		);
		url.searchParams.set('alternatives', 'true');
		url.searchParams.set('geometries', 'geojson');
		url.searchParams.set('overview', 'full');
		url.searchParams.set('steps', 'true');
		url.searchParams.set('access_token', token);

		const response = await fetch(url);

		if (!response.ok) {
			return makeFallbackRoutes(origin, destination, preferences.mode);
		}

		const data = (await response.json()) as MapboxDirectionsResponse;

		if (!data.routes?.length) {
			return makeFallbackRoutes(origin, destination, preferences.mode);
		}

		return normalizeRoutes(data.routes);
	} catch {
		return makeFallbackRoutes(origin, destination, preferences.mode);
	}
};
