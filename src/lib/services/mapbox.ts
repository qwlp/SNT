import { env } from '$env/dynamic/private';
import type { GeoPoint } from '$lib/domain/traffic';
import { haversineMeters } from './geo';

export interface ProviderRoute {
	providerRouteId?: string;
	label: string;
	geometry: GeoPoint[];
	distanceMeters: number;
	durationSec: number;
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
	}>;
}

const makeFallbackRoutes = (origin: GeoPoint, destination: GeoPoint): ProviderRoute[] => {
	const midpoint = {
		lat: (origin.lat + destination.lat) / 2,
		lng: (origin.lng + destination.lng) / 2
	};
	const distance = haversineMeters(origin, destination);
	const directDuration = Math.round((distance / 7.5) * 3.6);

	return [
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
};

const normalizeRoutes = (routes: MapboxDirectionsResponse['routes']): ProviderRoute[] =>
	routes.slice(0, 3).map((route, index) => ({
		providerRouteId: `${route.weight_name ?? 'mapbox'}-${index + 1}`,
		label: index === 0 ? 'Fastest' : index === 1 ? 'Safer' : 'Shortcut',
		geometry: route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
		distanceMeters: route.distance,
		durationSec: route.duration
	}));

export const fetchDirections = async ({
	origin,
	destination
}: {
	origin: GeoPoint;
	destination: GeoPoint;
}) => {
	try {
		const token = env.MAPBOX_ACCESS_TOKEN;

		if (!token) {
			return makeFallbackRoutes(origin, destination);
		}

		const url = new URL(
			`https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${origin.lng},${origin.lat};${destination.lng},${destination.lat}`
		);
		url.searchParams.set('alternatives', 'true');
		url.searchParams.set('geometries', 'geojson');
		url.searchParams.set('overview', 'full');
		url.searchParams.set('steps', 'false');
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
