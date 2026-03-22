<script lang="ts">
	import { env } from '$env/dynamic/public';
	import 'mapbox-gl/dist/mapbox-gl.css';
	import { onMount } from 'svelte';
	import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
	import type { GeoPoint } from '$lib/domain/traffic';
	import type { TrafficLevel } from '$lib/services/route-planner';
	import {
		INCIDENT_LABELS,
		INCIDENT_TYPES,
		PHNOM_PENH_BOUNDS,
		PHNOM_PENH_CENTER,
		type IncidentType
	} from '$lib/domain/traffic';
	import { boundsFromPoints, expandBounds, haversineMeters } from '$lib/services/geo';

	interface IncidentMarker {
		_id: string;
		type: IncidentType;
		location: GeoPoint;
		confidenceScore: number;
	}

	interface RouteLine {
		routeId: string;
		label: string;
		geometry: GeoPoint[];
		trafficLevel?: TrafficLevel;
		trafficSummary?: string;
		trafficSegments?: Array<{
			geometry: GeoPoint[];
			level: TrafficLevel;
			distanceMeters: number;
		}>;
	}

	type MapboxModule = typeof import('mapbox-gl').default;
	type MapboxMap = import('mapbox-gl').Map;
	type MapboxPopup = import('mapbox-gl').Popup;
	type MapboxBounds = import('mapbox-gl').LngLatBoundsLike;
	type MapboxGeoJSONSource = import('mapbox-gl').GeoJSONSource;
	type MapboxMapLayerMouseEvent = import('mapbox-gl').MapLayerMouseEvent;
	type MapboxMapMouseEvent = import('mapbox-gl').MapMouseEvent;

	type RouteFeature = Feature<
		LineString,
		{
			routeId: string;
			label: string;
			active: boolean;
			level: TrafficLevel;
		}
	>;

	type IncidentFeature = Feature<
		Point,
		{
			id: string;
			type: IncidentType;
			label: string;
			confidencePercent: number;
		}
	>;

	type LocationFeature = Feature<Point, { label: string }>;
	type DestinationFeature = Feature<Point, { label: string }>;
	type TrackedRouteFeature = Feature<LineString, { active: boolean }>;
	type DestinationTone = 'destination' | 'report';

	const ROUTE_SOURCE_ID = 'route-lines';
	const TRACKED_ROUTE_SOURCE_ID = 'tracked-route';
	const INCIDENT_SOURCE_ID = 'incident-points';
	const LOCATION_SOURCE_ID = 'current-location';
	const DESTINATION_SOURCE_ID = 'destination-point';
	const TRAFFIC_SOURCE_ID = 'mapbox-traffic';
	const TERRAIN_SOURCE_ID = 'mapbox-dem';

	const ACTIVE_ROUTE_LAYER_ID = 'route-active';
	const ACTIVE_ROUTE_CASING_LAYER_ID = 'route-active-casing';
	const TRACKED_ROUTE_LAYER_ID = 'tracked-route-line';
	const TRACKED_ROUTE_CASING_LAYER_ID = 'tracked-route-casing';
	const INACTIVE_ROUTE_LAYER_ID = 'route-inactive';
	const TRAFFIC_LAYER_ID = 'traffic-flow';
	const TRAFFIC_CLOSURE_LAYER_ID = 'traffic-closure';
	const INCIDENT_HALO_LAYER_ID = 'incident-halos';
	const LOCATION_HALO_LAYER_ID = 'current-location-halo';
	const LOCATION_CENTER_LAYER_ID = 'current-location-center';
	const DESTINATION_HALO_LAYER_ID = 'destination-halo';
	const DESTINATION_CENTER_LAYER_ID = 'destination-center';
	const BUILDINGS_LAYER_ID = 'mapbox-3d-buildings';
	const LONG_PRESS_MS = 460;
	const LONG_PRESS_MOVE_TOLERANCE_PX = 18;

	let {
		currentLocation,
		incidents,
		routes,
		trackedRoute = null,
		destination = null,
		destinationLabel = 'Pinned destination',
		destinationTone = 'destination',
		destinationMoveHint = 'Double-click again anywhere to move this destination.',
		activeRouteId,
		activeRouteStyle = 'traffic',
		focusPoints = [],
		onRouteSelect,
		onDestinationPick,
		liveNavigation = false,
		followUser = false,
		fullscreen = false,
		showHeader = !fullscreen
	} = $props<{
		currentLocation?: GeoPoint | null;
		incidents?: IncidentMarker[];
		routes?: RouteLine[];
		trackedRoute?: GeoPoint[] | null;
		destination?: GeoPoint | null;
		destinationLabel?: string;
		destinationTone?: DestinationTone;
		destinationMoveHint?: string;
		activeRouteId?: string | null;
		activeRouteStyle?: 'traffic' | 'navigation';
		focusPoints?: GeoPoint[];
		onRouteSelect?: (routeId: string) => void;
		onDestinationPick?: (point: GeoPoint) => void;
		liveNavigation?: boolean;
		followUser?: boolean;
		fullscreen?: boolean;
		showHeader?: boolean;
	}>();

	let mapHost = $state<HTMLDivElement | null>(null);
	let map: MapboxMap | null = null;
	let mapbox: MapboxModule | null = null;
	let popup: MapboxPopup | null = null;
	let viewportSignature = '';
	let mapReady = $state(false);
	let styleReady = false;
	let isThreeD = $state(false);
	let isSatellite = $state(false);
	let showTraffic = $state(true);
	let reloadMapStyle: (() => void) | null = null;
	let lastNavigationBearing = $state(-18);

	const mapboxToken = env.PUBLIC_MAPBOX_ACCESS_TOKEN?.trim() ?? '';
	const hasMapboxToken = mapboxToken.length > 0;
	const mapboxStyleId = env.PUBLIC_MAPBOX_STYLE_ID?.trim() || 'mapbox/standard';
	const mapboxStyleUrl = mapboxStyleId.startsWith('mapbox://styles/')
		? mapboxStyleId
		: `mapbox://styles/${mapboxStyleId}`;
	const mapboxSatelliteStyleUrl = 'mapbox://styles/mapbox/satellite-streets-v12';
	const getMapStyleUrl = () => (isSatellite ? mapboxSatelliteStyleUrl : mapboxStyleUrl);

	const getPitch = () => (liveNavigation ? 72 : followUser ? 70 : !isThreeD ? 0 : 58);
	const getBearing = () =>
		liveNavigation || followUser ? lastNavigationBearing : !isThreeD ? 0 : -18;
	const getDestinationPalette = (tone: DestinationTone) =>
		tone === 'report'
			? {
					halo: '#ff9b61',
					center: '#ff7a45',
					stroke: '#fff6ee'
				}
			: {
					halo: '#f1deba',
					center: '#f1deba',
					stroke: '#1f1710'
				};

	const getIncidentLabel = (type: IncidentType) => INCIDENT_LABELS[type];
	const getIncidentIconId = (type: IncidentType) => `incident-${type}`;
	const getIncidentLayerId = (type: IncidentType) => `incident-icon-${type}`;
	const incidentIconSvg: Record<IncidentType, string> = {
		roadblock: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="#ffffff"/><circle cx="32" cy="32" r="29" fill="none" stroke="#1a1a1a" stroke-width="2.5"/><path d="M32 14 48 45.5A3.5 3.5 0 0 1 44.9 50H19.1A3.5 3.5 0 0 1 16 45.5L32 14Z" fill="#FFD54A" stroke="#1a1a1a" stroke-width="3.5" stroke-linejoin="round"/><path d="M32 25v11" stroke="#1a1a1a" stroke-width="4" stroke-linecap="round"/><circle cx="32" cy="41.5" r="2.8" fill="#1a1a1a"/></svg>`,
		vip: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="#ffffff"/><circle cx="32" cy="32" r="29" fill="none" stroke="#1a1a1a" stroke-width="2.5"/><path d="m18 39 4-15 10 7 10-7 4 15H18Z" fill="#FFD451" stroke="#1a1a1a" stroke-width="3" stroke-linejoin="round"/><path d="M22 24 16 18l9 2 7-6 7 6 9-2-6 6" fill="#FFE389" stroke="#1a1a1a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 45h20" stroke="#1a1a1a" stroke-width="3" stroke-linecap="round"/></svg>`,
		wedding: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="#ffffff"/><circle cx="32" cy="32" r="29" fill="none" stroke="#1a1a1a" stroke-width="2.5"/><circle cx="25" cy="36" r="8.5" fill="#FFC8DA" stroke="#1a1a1a" stroke-width="3"/><circle cx="39" cy="36" r="8.5" fill="#FFE3A6" stroke="#1a1a1a" stroke-width="3"/><path d="M32 22.5c1.5-2.9 5.7-4.6 8.8-1.8 2.7 2.4 2.5 6.4-.3 8.9L32 38l-8.5-8.4c-2.8-2.5-3-6.5-.3-8.9 3.1-2.8 7.3-1.1 8.8 1.8Z" fill="#FF6B81" stroke="#1a1a1a" stroke-width="2.6" stroke-linejoin="round"/></svg>`,
		flood: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="#ffffff"/><circle cx="32" cy="32" r="29" fill="none" stroke="#1a1a1a" stroke-width="2.5"/><path d="M32 15c6.3 7.4 12 13.7 12 19.7a12 12 0 1 1-24 0C20 28.7 25.7 22.4 32 15Z" fill="#6EC8FF" stroke="#1a1a1a" stroke-width="3.2" stroke-linejoin="round"/><path d="M17 43.5c2.5 2.1 5 2.1 7.5 0s5-2.1 7.5 0 5 2.1 7.5 0 5-2.1 7.5 0" stroke="#1a1a1a" stroke-width="3" stroke-linecap="round"/><path d="M20 50c2.5 2.1 5 2.1 7.5 0s5-2.1 7.5 0 5 2.1 7.5 0" stroke="#1a1a1a" stroke-width="3" stroke-linecap="round"/></svg>`,
		accident: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="#ffffff"/><circle cx="32" cy="32" r="29" fill="none" stroke="#1a1a1a" stroke-width="2.5"/><path d="m20 38 5-8 8-2 5 2 4 8v6H18v-3l2-3Z" fill="#FF8A3D" stroke="#1a1a1a" stroke-width="3" stroke-linejoin="round"/><path d="m33 40 5-7 8-1 4 2.5 2 6-2.5 2.5H33v-3Z" fill="#FF5D5D" stroke="#1a1a1a" stroke-width="3" stroke-linejoin="round"/><circle cx="24" cy="44" r="3" fill="#1a1a1a"/><circle cx="36" cy="44" r="3" fill="#1a1a1a"/><circle cx="42.5" cy="44" r="3" fill="#1a1a1a"/><circle cx="49" cy="44" r="3" fill="#1a1a1a"/><path d="m32 16 2.3 4.6 5.1.7-3.7 3.5.9 5-4.6-2.4-4.6 2.4.9-5-3.7-3.5 5.1-.7L32 16Z" fill="#FFE066" stroke="#1a1a1a" stroke-width="2.6" stroke-linejoin="round"/></svg>`,
		police: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="#ffffff"/><circle cx="32" cy="32" r="29" fill="none" stroke="#1a1a1a" stroke-width="2.5"/><path d="M32 15 45 20v9c0 9.2-5.3 17-13 21.8C24.3 46 19 38.2 19 29v-9l13-5Z" fill="#7AB8FF" stroke="#1a1a1a" stroke-width="3.2" stroke-linejoin="round"/><path d="M32 24.5 34 28.5l4.5.6-3.2 3.1.8 4.4-4.1-2.2-4.1 2.2.8-4.4-3.2-3.1 4.5-.6 2-4Z" fill="#FFE373" stroke="#1a1a1a" stroke-width="2.6" stroke-linejoin="round"/></svg>`
	};

	const getViewportPoints = () => {
		if (focusPoints.length > 0) {
			return focusPoints;
		}

		const routePoints = (routes ?? []).flatMap((route: RouteLine) => route.geometry);
		const incidentPoints = (incidents ?? []).map((incident: IncidentMarker) => incident.location);

		return [
			...routePoints,
			...incidentPoints,
			...(currentLocation ? [currentLocation] : []),
			...(destination ? [destination] : [])
		];
	};

	const buildViewportSignature = (points: GeoPoint[]) =>
		JSON.stringify({
			precision: liveNavigation ? 5 : 4,
			activeRouteId,
			liveNavigation,
			incidentIds: (incidents ?? []).map((incident: IncidentMarker) => incident._id),
			routeIds: (routes ?? []).map((route: RouteLine) => route.routeId),
			destination: destination
				? [
						Number(destination.lat.toFixed(liveNavigation ? 5 : 4)),
						Number(destination.lng.toFixed(liveNavigation ? 5 : 4))
					]
				: null,
			points: points.map((point) => [
				Number(point.lat.toFixed(liveNavigation ? 5 : 4)),
				Number(point.lng.toFixed(liveNavigation ? 5 : 4))
			])
		});

	const getActiveNavigationPath = () => {
		if (trackedRoute && trackedRoute.length >= 2) {
			return trackedRoute;
		}

		const activeRoute = (routes ?? []).find((route: RouteLine) => route.routeId === activeRouteId);
		return activeRoute?.geometry ?? null;
	};

	const getHeadingBetweenPoints = (from: GeoPoint, to: GeoPoint) => {
		const startLat = (from.lat * Math.PI) / 180;
		const endLat = (to.lat * Math.PI) / 180;
		const deltaLng = ((to.lng - from.lng) * Math.PI) / 180;

		const y = Math.sin(deltaLng) * Math.cos(endLat);
		const x =
			Math.cos(startLat) * Math.sin(endLat) -
			Math.sin(startLat) * Math.cos(endLat) * Math.cos(deltaLng);

		return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
	};

	const interpolateHeading = (from: number, to: number, smoothing: number) => {
		const delta = ((((to - from) % 360) + 540) % 360) - 180;
		return (from + delta * smoothing + 360) % 360;
	};

	const interpolatePoint = (from: GeoPoint, to: GeoPoint, amount: number): GeoPoint => ({
		lat: from.lat + (to.lat - from.lat) * amount,
		lng: from.lng + (to.lng - from.lng) * amount
	});

	const getNavigationLookAheadPoint = (
		location: GeoPoint,
		path: GeoPoint[] | null,
		fallbackDestination: GeoPoint | null | undefined
	) => {
		if (!path || path.length === 0) {
			return fallbackDestination ?? null;
		}

		let nearestIndex = 0;
		let nearestDistance = Number.POSITIVE_INFINITY;

		for (const [index, point] of path.entries()) {
			const distance = haversineMeters(location, point);
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearestIndex = index;
			}
		}

		for (let index = nearestIndex + 1; index < path.length; index += 1) {
			const point = path[index];
			if (point && haversineMeters(location, point) >= 40) {
				return point;
			}
		}

		return path[Math.min(path.length - 1, nearestIndex + 1)] ?? fallbackDestination ?? null;
	};

	const createRouteFeatureCollection = (
		nextRoutes: RouteLine[],
		nextActiveRouteId: string | null | undefined
	): FeatureCollection<LineString, RouteFeature['properties']> => ({
		type: 'FeatureCollection',
		features: nextRoutes.flatMap((route) => {
			if (route.geometry.length < 2) {
				return [];
			}

			const isActive = route.routeId === nextActiveRouteId;
			const segmentedRoute =
				isActive && route.trafficSegments && route.trafficSegments.length > 0
					? route.trafficSegments.filter((segment) => segment.geometry.length >= 2)
					: null;

			if (segmentedRoute) {
				return segmentedRoute.map(
					(segment): RouteFeature => ({
						type: 'Feature',
						geometry: {
							type: 'LineString',
							coordinates: segment.geometry.map((point) => [point.lng, point.lat])
						},
						properties: {
							routeId: route.routeId,
							label: route.label,
							active: true,
							level: segment.level
						}
					})
				);
			}

			return [
				{
					type: 'Feature',
					geometry: {
						type: 'LineString',
						coordinates: route.geometry.map((point) => [point.lng, point.lat])
					},
					properties: {
						routeId: route.routeId,
						label: route.label,
						active: isActive,
						level: route.trafficLevel ?? 'clear'
					}
				}
			];
		})
	});

	const createIncidentFeatureCollection = (
		nextIncidents: IncidentMarker[]
	): FeatureCollection<Point, IncidentFeature['properties']> => ({
		type: 'FeatureCollection',
		features: nextIncidents.map(
			(incident): IncidentFeature => ({
				type: 'Feature',
				geometry: {
					type: 'Point',
					coordinates: [incident.location.lng, incident.location.lat]
				},
				properties: {
					id: incident._id,
					type: incident.type,
					label: getIncidentLabel(incident.type).en,
					confidencePercent: Math.round(incident.confidenceScore * 100)
				}
			})
		)
	});

	const svgToDataUrl = (svg: string) =>
		`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

	const loadMapImage = (src: string) =>
		new Promise<HTMLImageElement>((resolve, reject) => {
			const image = new Image();
			image.onload = () => resolve(image);
			image.onerror = () => reject(new Error(`Unable to load map image: ${src}`));
			image.src = src;
		});

	const ensureIncidentImages = async () => {
		if (!map) return;

		await Promise.all(
			INCIDENT_TYPES.map(async (type) => {
				const imageId = getIncidentIconId(type);
				if (!map || map.hasImage(imageId)) return;

				const image = await loadMapImage(svgToDataUrl(incidentIconSvg[type]));
				if (!map || map.hasImage(imageId)) return;
				map.addImage(imageId, image, {
					pixelRatio: 2
				});
			})
		);
	};

	const createTrackedRouteFeatureCollection = (
		nextTrackedRoute: GeoPoint[] | null | undefined
	): FeatureCollection<LineString, TrackedRouteFeature['properties']> => ({
		type: 'FeatureCollection',
		features:
			nextTrackedRoute && nextTrackedRoute.length >= 2
				? [
						{
							type: 'Feature',
							geometry: {
								type: 'LineString',
								coordinates: nextTrackedRoute.map((point) => [point.lng, point.lat])
							},
							properties: {
								active: true
							}
						}
					]
				: []
	});

	const createLocationFeatureCollection = (
		nextCurrentLocation: GeoPoint | null | undefined
	): FeatureCollection<Point, LocationFeature['properties']> => ({
		type: 'FeatureCollection',
		features: nextCurrentLocation
			? [
					{
						type: 'Feature',
						geometry: {
							type: 'Point',
							coordinates: [nextCurrentLocation.lng, nextCurrentLocation.lat]
						},
						properties: {
							label: 'Current location'
						}
					}
				]
			: []
	});

	const createDestinationFeatureCollection = (
		nextDestination: GeoPoint | null | undefined,
		label: string
	): FeatureCollection<Point, DestinationFeature['properties']> => ({
		type: 'FeatureCollection',
		features: nextDestination
			? [
					{
						type: 'Feature',
						geometry: {
							type: 'Point',
							coordinates: [nextDestination.lng, nextDestination.lat]
						},
						properties: {
							label
						}
					}
				]
			: []
	});

	const getGeoJSONSource = (sourceId: string) => {
		if (!map) return null;

		const source = map.getSource(sourceId);
		return source && 'setData' in source ? (source as MapboxGeoJSONSource) : null;
	};

	const updateMapSourceData = (
		nextCurrentLocation: GeoPoint | null | undefined,
		nextIncidents: IncidentMarker[],
		nextRoutes: RouteLine[],
		nextTrackedRoute: GeoPoint[] | null | undefined,
		nextDestination: GeoPoint | null | undefined,
		nextActiveRouteId: string | null | undefined
	) => {
		if (!map || !styleReady) return;

		getGeoJSONSource(ROUTE_SOURCE_ID)?.setData(
			createRouteFeatureCollection(nextRoutes, nextActiveRouteId)
		);
		getGeoJSONSource(TRACKED_ROUTE_SOURCE_ID)?.setData(
			createTrackedRouteFeatureCollection(nextTrackedRoute)
		);
		getGeoJSONSource(INCIDENT_SOURCE_ID)?.setData(createIncidentFeatureCollection(nextIncidents));
		getGeoJSONSource(LOCATION_SOURCE_ID)?.setData(
			createLocationFeatureCollection(nextCurrentLocation)
		);
		getGeoJSONSource(DESTINATION_SOURCE_ID)?.setData(
			createDestinationFeatureCollection(nextDestination, destinationLabel)
		);
	};

	const syncViewport = () => {
		if (!map || !styleReady) return;

		const points = getViewportPoints();
		const nextSignature = buildViewportSignature(points);

		if (viewportSignature === nextSignature) return;
		viewportSignature = nextSignature;

		if ((liveNavigation || followUser) && currentLocation) {
			const navigationPath = getActiveNavigationPath();
			const lookAheadPoint = getNavigationLookAheadPoint(
				currentLocation,
				navigationPath,
				destination
			);

			if (lookAheadPoint) {
				const nextBearing = getHeadingBetweenPoints(currentLocation, lookAheadPoint);
				lastNavigationBearing = interpolateHeading(lastNavigationBearing, nextBearing, 0.22);
			}

			const cameraTarget = liveNavigation
				? lookAheadPoint
					? interpolatePoint(currentLocation, lookAheadPoint, 0.18)
					: currentLocation
				: lookAheadPoint
					? interpolatePoint(currentLocation, lookAheadPoint, 0.08)
					: currentLocation;

			map.easeTo({
				center: [cameraTarget.lng, cameraTarget.lat],
				zoom: liveNavigation ? 18.35 : 18.85,
				pitch: getPitch(),
				bearing: getBearing(),
				padding: {
					top: liveNavigation ? 104 : 96,
					right: 48,
					bottom: liveNavigation ? 312 : 280,
					left: 48
				},
				duration: 850,
				essential: true
			});
			return;
		}

		if (points.length === 0) {
			const defaultBounds: MapboxBounds = [
				[PHNOM_PENH_BOUNDS.west, PHNOM_PENH_BOUNDS.south],
				[PHNOM_PENH_BOUNDS.east, PHNOM_PENH_BOUNDS.north]
			];

			map.fitBounds(defaultBounds, {
				padding: 48,
				duration: 900,
				pitch: getPitch(),
				bearing: getBearing()
			});
			return;
		}

		if (points.length === 1) {
			const center = points[0] ?? PHNOM_PENH_CENTER;

			map.easeTo({
				center: [center.lng, center.lat],
				zoom: 14.5,
				pitch: getPitch(),
				bearing: getBearing(),
				duration: 900
			});
			return;
		}

		const bounds = expandBounds(boundsFromPoints(points), 0.01);
		map.fitBounds(
			[
				[bounds.west, bounds.south],
				[bounds.east, bounds.north]
			],
			{
				padding: 48,
				maxZoom: 15.5,
				duration: 900,
				pitch: getPitch(),
				bearing: getBearing()
			}
		);
	};

	const applyThreeDMode = (shouldAnimate = true) => {
		if (!map || !styleReady) return;

		if (map.getSource(TERRAIN_SOURCE_ID)) {
			map.setTerrain(
				isThreeD || liveNavigation
					? {
							source: TERRAIN_SOURCE_ID,
							exaggeration: 1.18
						}
					: null
			);
		}

		if (shouldAnimate) {
			map.easeTo({
				pitch: getPitch(),
				bearing: getBearing(),
				duration: 800
			});
			return;
		}

		map.jumpTo({
			pitch: getPitch(),
			bearing: getBearing()
		});
	};

	const applyTrafficVisibility = () => {
		if (!map || !styleReady) return;

		for (const layerId of [TRAFFIC_LAYER_ID, TRAFFIC_CLOSURE_LAYER_ID]) {
			if (!map.getLayer(layerId)) continue;
			map.setLayoutProperty(layerId, 'visibility', showTraffic ? 'visible' : 'none');
		}
	};

	const findLabelLayerId = () => {
		if (!map) return undefined;

		return map
			.getStyle()
			.layers?.find((layer) => layer.type === 'symbol' && layer.layout?.['text-field'])?.id;
	};

	const installMapLayers = async () => {
		if (!map) return;

		await ensureIncidentImages();

		if (!map.getSource(ROUTE_SOURCE_ID)) {
			map.addSource(ROUTE_SOURCE_ID, {
				type: 'geojson',
				data: createRouteFeatureCollection(routes ?? [], activeRouteId)
			});
		}

		if (!map.getSource(TRACKED_ROUTE_SOURCE_ID)) {
			map.addSource(TRACKED_ROUTE_SOURCE_ID, {
				type: 'geojson',
				data: createTrackedRouteFeatureCollection(trackedRoute)
			});
		}

		if (!map.getSource(INCIDENT_SOURCE_ID)) {
			map.addSource(INCIDENT_SOURCE_ID, {
				type: 'geojson',
				data: createIncidentFeatureCollection(incidents ?? [])
			});
		}

		if (!map.getSource(LOCATION_SOURCE_ID)) {
			map.addSource(LOCATION_SOURCE_ID, {
				type: 'geojson',
				data: createLocationFeatureCollection(currentLocation)
			});
		}

		if (!map.getSource(DESTINATION_SOURCE_ID)) {
			map.addSource(DESTINATION_SOURCE_ID, {
				type: 'geojson',
				data: createDestinationFeatureCollection(destination, destinationLabel)
			});
		}

		if (!map.getSource(TRAFFIC_SOURCE_ID)) {
			map.addSource(TRAFFIC_SOURCE_ID, {
				type: 'vector',
				url: 'mapbox://mapbox.mapbox-traffic-v1'
			});
		}

		if (!map.getLayer(INACTIVE_ROUTE_LAYER_ID)) {
			map.addLayer({
				id: INACTIVE_ROUTE_LAYER_ID,
				type: 'line',
				source: ROUTE_SOURCE_ID,
				filter: ['==', ['get', 'active'], false],
				layout: {
					'line-cap': 'round',
					'line-join': 'round'
				},
				paint: {
					'line-color': '#c7ccd1',
					'line-width': 5,
					'line-opacity': 0.46
				}
			});
		}

		if (!map.getLayer(TRAFFIC_LAYER_ID)) {
			map.addLayer(
				{
					id: TRAFFIC_LAYER_ID,
					type: 'line',
					source: TRAFFIC_SOURCE_ID,
					'source-layer': 'traffic',
					filter: ['!=', ['get', 'closed'], 'yes'],
					layout: {
						'line-cap': 'round',
						'line-join': 'round'
					},
					paint: {
						'line-color': [
							'match',
							['get', 'congestion'],
							'severe',
							'#981b25',
							'heavy',
							'#ff0015',
							'moderate',
							'#ff8c1a',
							'low',
							'#39c66d',
							'#39c66d'
						],
						'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 12, 2.5, 15, 4],
						'line-opacity': 0.8,
						'line-offset': 1.5
					}
				},
				findLabelLayerId()
			);
		}

		if (!map.getLayer(TRAFFIC_CLOSURE_LAYER_ID)) {
			map.addLayer(
				{
					id: TRAFFIC_CLOSURE_LAYER_ID,
					type: 'line',
					source: TRAFFIC_SOURCE_ID,
					'source-layer': 'traffic',
					filter: ['==', ['get', 'closed'], 'yes'],
					layout: {
						'line-cap': 'round',
						'line-join': 'round'
					},
					paint: {
						'line-color': '#1b1b1b',
						'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2, 12, 3, 15, 5],
						'line-opacity': 0.85,
						'line-dasharray': [1.4, 1.1]
					}
				},
				findLabelLayerId()
			);
		}

		if (!map.getLayer(ACTIVE_ROUTE_CASING_LAYER_ID)) {
			map.addLayer({
				id: ACTIVE_ROUTE_CASING_LAYER_ID,
				type: 'line',
				source: ROUTE_SOURCE_ID,
				filter: ['==', ['get', 'active'], true],
				layout: {
					'line-cap': 'round',
					'line-join': 'round'
				},
				paint: {
					'line-color': activeRouteStyle === 'navigation' ? '#d6e4ff' : '#ffffff',
					'line-width': activeRouteStyle === 'navigation' ? 12 : 10,
					'line-opacity': activeRouteStyle === 'navigation' ? 0.92 : 0.8
				}
			});
		}

		if (!map.getLayer(ACTIVE_ROUTE_LAYER_ID)) {
			map.addLayer({
				id: ACTIVE_ROUTE_LAYER_ID,
				type: 'line',
				source: ROUTE_SOURCE_ID,
				filter: ['==', ['get', 'active'], true],
				layout: {
					'line-cap': 'round',
					'line-join': 'round'
				},
				paint: {
					'line-color':
						activeRouteStyle === 'navigation'
							? '#2f7bff'
							: [
									'match',
									['get', 'level'],
									'severe',
									'#ff4d4f',
									'heavy',
									'#ff8f1f',
									'moderate',
									'#ffd45a',
									'light',
									'#67d46c',
									'#3c82f6'
								],
					'line-width': activeRouteStyle === 'navigation' ? 8.5 : 7,
					'line-opacity': 0.98
				}
			});
		}

		if (!map.getLayer(TRACKED_ROUTE_CASING_LAYER_ID)) {
			map.addLayer({
				id: TRACKED_ROUTE_CASING_LAYER_ID,
				type: 'line',
				source: TRACKED_ROUTE_SOURCE_ID,
				layout: {
					'line-cap': 'round',
					'line-join': 'round'
				},
				paint: {
					'line-color': '#d6e4ff',
					'line-width': 13,
					'line-opacity': 0.98
				}
			});
		}

		if (!map.getLayer(TRACKED_ROUTE_LAYER_ID)) {
			map.addLayer({
				id: TRACKED_ROUTE_LAYER_ID,
				type: 'line',
				source: TRACKED_ROUTE_SOURCE_ID,
				layout: {
					'line-cap': 'round',
					'line-join': 'round'
				},
				paint: {
					'line-color': '#1f6dff',
					'line-width': 8.5,
					'line-opacity': 0.99
				}
			});
		}

		if (!map.getLayer(INCIDENT_HALO_LAYER_ID)) {
			map.addLayer({
				id: INCIDENT_HALO_LAYER_ID,
				type: 'circle',
				source: INCIDENT_SOURCE_ID,
				paint: {
					'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 16],
					'circle-color': '#ffffff',
					'circle-opacity': 0.94,
					'circle-stroke-color': '#d7dde8',
					'circle-stroke-width': 1.5
				}
			});
		}

		for (const type of INCIDENT_TYPES) {
			const layerId = getIncidentLayerId(type);
			if (map.getLayer(layerId)) continue;

			map.addLayer({
				id: layerId,
				type: 'symbol',
				source: INCIDENT_SOURCE_ID,
				filter: ['==', ['get', 'type'], type],
				layout: {
					'icon-image': getIncidentIconId(type),
					'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.52, 14, 0.72],
					'icon-allow-overlap': true,
					'icon-ignore-placement': true
				}
			});
		}

		if (!map.getLayer(LOCATION_HALO_LAYER_ID)) {
			map.addLayer({
				id: LOCATION_HALO_LAYER_ID,
				type: 'circle',
				source: LOCATION_SOURCE_ID,
				paint: {
					'circle-radius': 18,
					'circle-color': '#7fc7ae',
					'circle-opacity': 0.18
				}
			});
		}

		if (!map.getLayer(LOCATION_CENTER_LAYER_ID)) {
			map.addLayer({
				id: LOCATION_CENTER_LAYER_ID,
				type: 'circle',
				source: LOCATION_SOURCE_ID,
				paint: {
					'circle-radius': 9,
					'circle-color': '#7fc7ae',
					'circle-stroke-color': '#ffffff',
					'circle-stroke-width': 3
				}
			});
		}

		if (!map.getLayer(DESTINATION_HALO_LAYER_ID)) {
			const palette = getDestinationPalette(destinationTone);

			map.addLayer({
				id: DESTINATION_HALO_LAYER_ID,
				type: 'circle',
				source: DESTINATION_SOURCE_ID,
				paint: {
					'circle-radius': 18,
					'circle-color': palette.halo,
					'circle-opacity': 0.22
				}
			});
		}

		if (!map.getLayer(DESTINATION_CENTER_LAYER_ID)) {
			const palette = getDestinationPalette(destinationTone);

			map.addLayer({
				id: DESTINATION_CENTER_LAYER_ID,
				type: 'circle',
				source: DESTINATION_SOURCE_ID,
				paint: {
					'circle-radius': 9,
					'circle-color': palette.center,
					'circle-stroke-color': palette.stroke,
					'circle-stroke-width': 3
				}
			});
		}

		if (!map.getSource(TERRAIN_SOURCE_ID)) {
			map.addSource(TERRAIN_SOURCE_ID, {
				type: 'raster-dem',
				url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
				tileSize: 512,
				maxzoom: 14
			});
		}

		if (!map.getLayer(BUILDINGS_LAYER_ID) && map.getSource('composite')) {
			map.addLayer(
				{
					id: BUILDINGS_LAYER_ID,
					source: 'composite',
					'source-layer': 'building',
					filter: ['==', ['get', 'extrude'], 'true'],
					type: 'fill-extrusion',
					minzoom: 14,
					paint: {
						'fill-extrusion-color': '#d4b07f',
						'fill-extrusion-height': ['get', 'height'],
						'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
						'fill-extrusion-opacity': liveNavigation ? 0.82 : 0.55
					}
				},
				findLabelLayerId()
			);
		}

		map.setFog({
			color: 'rgb(237, 241, 234)',
			'high-color': 'rgb(77, 98, 108)',
			'horizon-blend': 0.15
		});

		applyTrafficVisibility();
		applyThreeDMode(false);
	};

	const buildPopupNode = (title: string, detail: string) => {
		const wrapper = document.createElement('div');
		wrapper.className = 'space-y-1';

		const heading = document.createElement('p');
		heading.className = 'text-sm font-semibold text-[var(--text)]';
		heading.textContent = title;

		const body = document.createElement('p');
		body.className = 'text-xs text-[var(--muted)]';
		body.textContent = detail;

		wrapper.append(heading, body);
		return wrapper;
	};

	const showPopup = (coordinates: [number, number], title: string, detail: string) => {
		if (!popup || !map) return;

		popup.setLngLat(coordinates).setDOMContent(buildPopupNode(title, detail)).addTo(map);
	};

	const installInteractionHandlers = () => {
		if (!map || !mapbox) return () => {};
		const canvasContainer = map.getCanvasContainer();
		let longPressTimeoutId: number | null = null;
		let touchStartPoint: { x: number; y: number } | null = null;
		let lastDestinationPickAt = 0;

		const interactiveLayerIds = [
			ACTIVE_ROUTE_LAYER_ID,
			INACTIVE_ROUTE_LAYER_ID,
			...INCIDENT_TYPES.map(getIncidentLayerId),
			LOCATION_CENTER_LAYER_ID,
			DESTINATION_CENTER_LAYER_ID
		] as const;

		const handleMouseEnter = () => {
			if (!map) return;
			map.getCanvas().style.cursor = 'pointer';
		};

		const handleMouseLeave = () => {
			if (!map) return;
			map.getCanvas().style.cursor = '';
		};

		const handleRouteClick = (event: MapboxMapLayerMouseEvent) => {
			const feature = event.features?.[0];
			if (!feature || feature.geometry.type !== 'LineString') return;

			const [lng, lat] = event.lngLat.toArray();
			const label =
				typeof feature.properties?.label === 'string' ? feature.properties.label : 'Route';
			const routeId =
				typeof feature.properties?.routeId === 'string' ? feature.properties.routeId : null;

			if (routeId) {
				onRouteSelect?.(routeId);
			}

			showPopup([lng, lat], label, 'Selected on the map. Start trip to lock this route in.');
		};

		const handleIncidentClick = (event: MapboxMapLayerMouseEvent) => {
			const feature = event.features?.[0];
			if (!feature || feature.geometry.type !== 'Point') return;

			const label =
				typeof feature.properties?.label === 'string' ? feature.properties.label : 'Incident';
			const confidence = Number(feature.properties?.confidencePercent ?? 0);
			const coordinates = feature.geometry.coordinates.slice(0, 2) as [number, number];

			showPopup(coordinates, label, `Confidence ${confidence.toFixed(0)}%`);
		};

		const handleLocationClick = (event: MapboxMapLayerMouseEvent) => {
			const feature = event.features?.[0];
			if (!feature || feature.geometry.type !== 'Point') return;

			const coordinates = feature.geometry.coordinates.slice(0, 2) as [number, number];
			showPopup(coordinates, 'Current location', 'Live GPS fix used for route planning.');
		};

		const handleDestinationClick = (event: MapboxMapLayerMouseEvent) => {
			const feature = event.features?.[0];
			if (!feature || feature.geometry.type !== 'Point') return;

			const label =
				typeof feature.properties?.label === 'string'
					? feature.properties.label
					: 'Pinned destination';
			const coordinates = feature.geometry.coordinates.slice(0, 2) as [number, number];

			showPopup(coordinates, label, destinationMoveHint);
		};

		const pickDestination = (point: GeoPoint) => {
			if (!onDestinationPick) return;

			const now = Date.now();
			if (now - lastDestinationPickAt < 400) {
				return;
			}

			lastDestinationPickAt = now;
			onDestinationPick(point);
		};

		const handleMapDoubleClick = (event: MapboxMapMouseEvent) => {
			pickDestination({
				lat: event.lngLat.lat,
				lng: event.lngLat.lng
			});
		};

		const clearLongPressTimeout = () => {
			if (longPressTimeoutId !== null) {
				window.clearTimeout(longPressTimeoutId);
				longPressTimeoutId = null;
			}
		};

		const handleTouchStart = (event: TouchEvent) => {
			if (!onDestinationPick || event.touches.length !== 1) return;

			const touch = event.touches[0];
			if (!touch) return;

			touchStartPoint = { x: touch.clientX, y: touch.clientY };
			clearLongPressTimeout();

			longPressTimeoutId = window.setTimeout(() => {
				if (!map || !touchStartPoint) return;

				const bounds = canvasContainer.getBoundingClientRect();
				const point = map.unproject([
					touchStartPoint.x - bounds.left,
					touchStartPoint.y - bounds.top
				]);

				pickDestination({
					lat: point.lat,
					lng: point.lng
				});
				touchStartPoint = null;
				clearLongPressTimeout();
			}, LONG_PRESS_MS);
		};

		const handleTouchMove = (event: TouchEvent) => {
			if (!touchStartPoint) return;

			const touch = event.touches[0];
			if (!touch) {
				clearLongPressTimeout();
				touchStartPoint = null;
				return;
			}

			const deltaX = touch.clientX - touchStartPoint.x;
			const deltaY = touch.clientY - touchStartPoint.y;
			if (Math.hypot(deltaX, deltaY) > LONG_PRESS_MOVE_TOLERANCE_PX) {
				clearLongPressTimeout();
				touchStartPoint = null;
			}
		};

		const handleTouchEnd = () => {
			clearLongPressTimeout();
			touchStartPoint = null;
		};

		const handleContextMenu = (event: MouseEvent) => {
			if (!onDestinationPick || Date.now() - lastDestinationPickAt > 900) return;
			event.preventDefault();
		};

		for (const layerId of interactiveLayerIds) {
			map.on('mouseenter', layerId, handleMouseEnter);
			map.on('mouseleave', layerId, handleMouseLeave);
		}

		map.on('click', ACTIVE_ROUTE_LAYER_ID, handleRouteClick);
		map.on('click', INACTIVE_ROUTE_LAYER_ID, handleRouteClick);
		for (const type of INCIDENT_TYPES) {
			map.on('click', getIncidentLayerId(type), handleIncidentClick);
		}
		map.on('click', LOCATION_CENTER_LAYER_ID, handleLocationClick);
		map.on('click', DESTINATION_CENTER_LAYER_ID, handleDestinationClick);
		map.on('dblclick', handleMapDoubleClick);
		canvasContainer.addEventListener('touchstart', handleTouchStart, { passive: true });
		canvasContainer.addEventListener('touchmove', handleTouchMove, { passive: true });
		canvasContainer.addEventListener('touchend', handleTouchEnd, { passive: true });
		canvasContainer.addEventListener('touchcancel', handleTouchEnd, { passive: true });
		canvasContainer.addEventListener('contextmenu', handleContextMenu);

		return () => {
			for (const layerId of interactiveLayerIds) {
				map?.off('mouseenter', layerId, handleMouseEnter);
				map?.off('mouseleave', layerId, handleMouseLeave);
			}

			map?.off('click', ACTIVE_ROUTE_LAYER_ID, handleRouteClick);
			map?.off('click', INACTIVE_ROUTE_LAYER_ID, handleRouteClick);
			for (const type of INCIDENT_TYPES) {
				map?.off('click', getIncidentLayerId(type), handleIncidentClick);
			}
			map?.off('click', LOCATION_CENTER_LAYER_ID, handleLocationClick);
			map?.off('click', DESTINATION_CENTER_LAYER_ID, handleDestinationClick);
			map?.off('dblclick', handleMapDoubleClick);
			canvasContainer.removeEventListener('touchstart', handleTouchStart);
			canvasContainer.removeEventListener('touchmove', handleTouchMove);
			canvasContainer.removeEventListener('touchend', handleTouchEnd);
			canvasContainer.removeEventListener('touchcancel', handleTouchEnd);
			canvasContainer.removeEventListener('contextmenu', handleContextMenu);
			clearLongPressTimeout();
		};
	};

	const syncMapState = (
		nextCurrentLocation: GeoPoint | null | undefined,
		nextIncidents: IncidentMarker[],
		nextRoutes: RouteLine[],
		nextTrackedRoute: GeoPoint[] | null | undefined,
		nextDestination: GeoPoint | null | undefined,
		nextActiveRouteId: string | null | undefined
	) => {
		updateMapSourceData(
			nextCurrentLocation,
			nextIncidents,
			nextRoutes,
			nextTrackedRoute,
			nextDestination,
			nextActiveRouteId
		);
		syncViewport();
	};

	const toggleThreeD = () => {
		if (liveNavigation) {
			return;
		}

		isThreeD = !isThreeD;
		applyThreeDMode();
		syncViewport();
	};

	const toggleSatellite = () => {
		if (!mapReady) {
			return;
		}

		isSatellite = !isSatellite;
		reloadMapStyle?.();
	};

	const toggleTraffic = () => {
		showTraffic = !showTraffic;
		applyTrafficVisibility();
	};

	onMount(() => {
		if (!hasMapboxToken || !mapHost) return;

		let cancelled = false;
		let removeInteractionHandlers = () => {};

		isThreeD = !liveNavigation && !followUser;

		const initMap = async () => {
			const mapboxImport = await import('mapbox-gl');
			mapbox = mapboxImport.default;
			if (cancelled || !mapHost) return;

			mapbox.accessToken = mapboxToken;

			map = new mapbox.Map({
				container: mapHost,
				style: getMapStyleUrl(),
				center: [PHNOM_PENH_CENTER.lng, PHNOM_PENH_CENTER.lat],
				zoom: 12.2,
				pitch: getPitch(),
				bearing: getBearing(),
				attributionControl: false,
				antialias: true
			});

			popup = new mapbox.Popup({
				closeButton: false,
				closeOnClick: true,
				offset: 14,
				maxWidth: '240px'
			});

			map.addControl(new mapbox.ScaleControl({ unit: 'metric' }), 'bottom-left');

			map.dragRotate.enable();
			map.touchZoomRotate.enableRotation();
			map.doubleClickZoom.disable();

			const handleStyleLoad = () => {
				if (!map || cancelled) return;

				styleReady = true;
				void installMapLayers().then(() => {
					if (!map || cancelled) return;

					removeInteractionHandlers();
					removeInteractionHandlers = installInteractionHandlers();
					syncMapState(
						currentLocation,
						incidents ?? [],
						routes ?? [],
						trackedRoute,
						destination,
						activeRouteId
					);
					mapReady = true;
				});
			};

			map.on('style.load', handleStyleLoad);

			reloadMapStyle = () => {
				if (!map) return;

				mapReady = false;
				styleReady = false;
				viewportSignature = '';
				popup?.remove();
				removeInteractionHandlers();
				map.setStyle(getMapStyleUrl());
			};
		};

		void initMap();

		return () => {
			cancelled = true;
			removeInteractionHandlers();
			popup?.remove();
			popup = null;
			reloadMapStyle = null;
			map?.remove();
			map = null;
			mapReady = false;
			styleReady = false;
		};
	});

	$effect(() => {
		syncMapState(
			currentLocation,
			incidents ?? [],
			routes ?? [],
			trackedRoute,
			destination,
			activeRouteId
		);
	});

	$effect(() => {
		if (!map || !styleReady) return;

		map.setPaintProperty(
			ACTIVE_ROUTE_CASING_LAYER_ID,
			'line-color',
			activeRouteStyle === 'navigation' ? '#d6e4ff' : '#ffffff'
		);
		map.setPaintProperty(
			ACTIVE_ROUTE_CASING_LAYER_ID,
			'line-width',
			activeRouteStyle === 'navigation' ? 12 : 10
		);
		map.setPaintProperty(
			ACTIVE_ROUTE_CASING_LAYER_ID,
			'line-opacity',
			activeRouteStyle === 'navigation' ? 0.92 : 0.8
		);
		map.setPaintProperty(
			ACTIVE_ROUTE_LAYER_ID,
			'line-color',
			activeRouteStyle === 'navigation'
				? '#2f7bff'
				: [
						'match',
						['get', 'level'],
						'severe',
						'#ff4d4f',
						'heavy',
						'#ff8f1f',
						'moderate',
						'#ffd45a',
						'light',
						'#67d46c',
						'#3c82f6'
					]
		);
		map.setPaintProperty(
			ACTIVE_ROUTE_LAYER_ID,
			'line-width',
			activeRouteStyle === 'navigation' ? 8.5 : 7
		);
	});

	$effect(() => {
		if (!map || !styleReady || !map.getLayer(BUILDINGS_LAYER_ID)) return;

		map.setPaintProperty(
			BUILDINGS_LAYER_ID,
			'fill-extrusion-opacity',
			liveNavigation ? 0.82 : 0.55
		);
	});

	$effect(() => {
		if (!map || !styleReady) return;

		const palette = getDestinationPalette(destinationTone);
		map.setPaintProperty(DESTINATION_HALO_LAYER_ID, 'circle-color', palette.halo);
		map.setPaintProperty(DESTINATION_CENTER_LAYER_ID, 'circle-color', palette.center);
		map.setPaintProperty(DESTINATION_CENTER_LAYER_ID, 'circle-stroke-color', palette.stroke);
	});

	$effect(() => {
		if (!liveNavigation && !followUser) return;

		isThreeD = true;
		applyThreeDMode(false);
		syncViewport();
	});

	$effect(() => {
		applyTrafficVisibility();
	});
</script>

<div
	class={`overflow-hidden bg-[var(--map-bg)] ${fullscreen ? 'h-full w-full' : 'rounded-[10px] border border-[var(--map-border)]'}`}
>
	{#if showHeader}
		<div
			class="flex flex-col gap-3 border-b border-white/10 px-4 py-3 text-sm text-[var(--map-text)] sm:flex-row sm:items-center sm:justify-between"
		>
			<div>
				<p class="font-medium">Phnom Penh map</p>
				<p class="text-xs text-white/65">
					Mapbox GL scene with live routes, incidents, terrain, and 3D buildings
				</p>
			</div>
			<div class="flex items-center gap-2 self-start text-xs text-white/75 sm:self-auto">
				<span class="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">Mapbox GL</span>
				<button
					type="button"
					onclick={toggleThreeD}
					class="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 font-medium text-[var(--map-text)] transition hover:border-white/25 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
					disabled={!mapReady}
				>
					{isThreeD ? '3D on' : '2D mode'}
				</button>
				<span class="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
					{routes?.length ?? 0} routes
				</span>
				<span class="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
					{incidents?.length ?? 0} incidents
				</span>
			</div>
		</div>
	{/if}

	<div
		class={`relative w-full bg-[var(--map-bg)] ${fullscreen ? 'h-full min-h-[100svh]' : 'aspect-[16/10]'}`}
	>
		{#if hasMapboxToken}
			<div bind:this={mapHost} class="h-full w-full"></div>

			<div
				class={`absolute z-20 ${
					fullscreen ? 'top-[4.4rem] right-2 hidden sm:block' : 'top-3 right-3'
				}`}
			>
				<div
					class="flex flex-col gap-2 rounded-[28px] border border-[var(--border)] bg-white/90 p-2 shadow-[var(--shadow-panel)] backdrop-blur-xl"
				>
					<button
						type="button"
						onclick={toggleThreeD}
						class={`flex h-11 w-11 items-center justify-center rounded-[18px] border transition disabled:cursor-not-allowed disabled:opacity-45 ${
							isThreeD || liveNavigation
								? 'border-[#8bb7ff] bg-[#eaf3ff] text-[#2357a6]'
								: 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--primary-soft)]'
						}`}
						disabled={!mapReady || liveNavigation}
						aria-label={liveNavigation
							? '3D follow camera is active during live navigation'
							: isThreeD
								? 'Switch to 2D view'
								: 'Switch to 3D view'}
						aria-pressed={isThreeD || liveNavigation}
						title={liveNavigation
							? '3D follow camera is active during live navigation'
							: isThreeD
								? 'Switch to 2D view'
								: 'Switch to 3D view'}
					>
						{#if isThreeD || liveNavigation}
							<svg
								viewBox="0 0 24 24"
								class="h-5 w-5"
								fill="none"
								stroke="currentColor"
								stroke-width="1.9"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="m12 3 7 4-7 4-7-4 7-4Z" />
								<path d="m5 7 7 4 7-4" />
								<path d="M5 7v8l7 4 7-4V7" />
								<path d="M12 11v8" />
							</svg>
						{:else}
							<svg
								viewBox="0 0 24 24"
								class="h-5 w-5"
								fill="none"
								stroke="currentColor"
								stroke-width="1.9"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<rect x="4" y="5" width="16" height="14" rx="2.5" />
								<path d="M4 10h16" />
								<path d="M9 19V10" />
							</svg>
						{/if}
						<span class="sr-only"
							>{isThreeD || liveNavigation ? '3D view enabled' : '2D view enabled'}</span
						>
					</button>

					<button
						type="button"
						onclick={toggleSatellite}
						class={`flex h-11 w-11 items-center justify-center rounded-[18px] border transition disabled:cursor-not-allowed disabled:opacity-45 ${
							isSatellite
								? 'border-[#cda967] bg-[#fff3da] text-[#7a5a1d]'
								: 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--primary-soft)]'
						}`}
						disabled={!mapReady}
						aria-label={isSatellite ? 'Switch to street map' : 'Switch to satellite map'}
						aria-pressed={isSatellite}
						title={isSatellite ? 'Switch to street map' : 'Switch to satellite map'}
					>
						<svg
							viewBox="0 0 24 24"
							class="h-5 w-5"
							fill="none"
							stroke="currentColor"
							stroke-width="1.9"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<path d="M4.5 8.5 9 6l6 2 4.5-2.5v10L15 18l-6-2-4.5 2.5v-10Z" />
							<path d="M9 6v10" />
							<path d="M15 8v10" />
						</svg>
						<span class="sr-only"
							>{isSatellite ? 'Satellite map enabled' : 'Street map enabled'}</span
						>
					</button>

					<button
						type="button"
						onclick={toggleTraffic}
						class={`flex h-11 w-11 items-center justify-center rounded-[18px] border transition disabled:cursor-not-allowed disabled:opacity-45 ${
							showTraffic
								? 'border-[#83d2a8] bg-[#e7f8ef] text-[#1d7754]'
								: 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--primary-soft)]'
						}`}
						disabled={!mapReady}
						aria-label={showTraffic ? 'Hide traffic overlay' : 'Show traffic overlay'}
						aria-pressed={showTraffic}
						title={showTraffic ? 'Hide traffic overlay' : 'Show traffic overlay'}
					>
						<svg
							viewBox="0 0 24 24"
							class="h-5 w-5"
							fill="none"
							stroke="currentColor"
							stroke-width="1.9"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<path d="M4 8h10" />
							<path d="M4 12h16" />
							<path d="M4 16h12" />
							<circle cx="17.5" cy="8" r="1.5" fill="currentColor" stroke="none" />
							<circle cx="19.5" cy="16" r="1.5" fill="currentColor" stroke="none" />
						</svg>
						<span class="sr-only"
							>{showTraffic ? 'Traffic overlay enabled' : 'Traffic overlay hidden'}</span
						>
					</button>
				</div>
			</div>
		{:else}
			<div class="flex h-full items-center justify-center px-6 text-center text-sm text-white/70">
				Add `PUBLIC_MAPBOX_ACCESS_TOKEN` to load the Mapbox scene.
			</div>
		{/if}

		{#if hasMapboxToken && !mapReady}
			<div
				class="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-white/65"
			>
				Loading Mapbox scene...
			</div>
		{/if}
	</div>
</div>

<style>
	:global(.mapboxgl-map) {
		background: var(--map-bg);
		font-family: inherit;
	}

	:global(.mapboxgl-ctrl-group),
	:global(.mapboxgl-ctrl-scale),
	:global(.mapboxgl-ctrl-attrib) {
		border-color: var(--border);
		box-shadow: var(--shadow-soft);
		background: rgb(255 255 255 / 0.94);
		color: var(--text);
	}

	:global(.mapboxgl-ctrl button .mapboxgl-ctrl-icon) {
		filter: none;
	}

	:global(.mapboxgl-popup-content) {
		border: 1px solid rgb(215 226 238 / 0.9);
		border-radius: 10px;
		box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
		background: var(--surface);
		padding: 10px 12px;
	}

	:global(.mapboxgl-popup-tip) {
		border-top-color: var(--surface);
		border-bottom-color: var(--surface);
	}

	@media (max-width: 639px) {
		:global(.mapboxgl-ctrl-top-right) {
			display: none;
		}

		:global(.mapboxgl-ctrl-bottom-right) {
			display: none;
		}

		:global(.mapboxgl-ctrl-scale) {
			display: none;
		}
	}
</style>
