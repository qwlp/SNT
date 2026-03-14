<script lang="ts">
	import { env } from '$env/dynamic/public';
	import 'mapbox-gl/dist/mapbox-gl.css';
	import { onMount } from 'svelte';
	import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
	import type { GeoPoint } from '$lib/domain/traffic';
	import type { TrafficLevel } from '$lib/services/route-planner';
	import {
		INCIDENT_LABELS,
		PHNOM_PENH_BOUNDS,
		PHNOM_PENH_CENTER,
		type IncidentType
	} from '$lib/domain/traffic';
	import { boundsFromPoints, expandBounds } from '$lib/services/geo';

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
	const INCIDENT_LAYER_ID = 'incident-circles';
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
		navigationMode = false,
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
		navigationMode?: boolean;
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

	const mapboxToken = env.PUBLIC_MAPBOX_ACCESS_TOKEN?.trim() ?? '';
	const hasMapboxToken = mapboxToken.length > 0;
	const mapboxStyleId = env.PUBLIC_MAPBOX_STYLE_ID?.trim() || 'mapbox/standard';
	const mapboxStyleUrl = mapboxStyleId.startsWith('mapbox://styles/')
		? mapboxStyleId
		: `mapbox://styles/${mapboxStyleId}`;

	const getPitch = () => (navigationMode || !isThreeD ? 0 : 58);
	const getBearing = () => (navigationMode || !isThreeD ? 0 : -18);
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
			activeRouteId,
			incidentIds: (incidents ?? []).map((incident: IncidentMarker) => incident._id),
			routeIds: (routes ?? []).map((route: RouteLine) => route.routeId),
			destination: destination
				? [Number(destination.lat.toFixed(4)), Number(destination.lng.toFixed(4))]
				: null,
			points: points.map((point) => [Number(point.lat.toFixed(4)), Number(point.lng.toFixed(4))])
		});

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
					label: getIncidentLabel(incident.type).en,
					confidencePercent: Math.round(incident.confidenceScore * 100)
				}
			})
		)
	});

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
				pitch: navigationMode ? 0 : isThreeD ? 60 : 0,
				bearing: navigationMode ? 0 : isThreeD ? -20 : 0,
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
				isThreeD
					? {
							source: TERRAIN_SOURCE_ID,
							exaggeration: 1.18
						}
					: null
			);
		}

		if (shouldAnimate) {
			map.easeTo({
				pitch: navigationMode ? 0 : isThreeD ? 60 : 0,
				bearing: navigationMode ? 0 : isThreeD ? -20 : 0,
				duration: 800
			});
			return;
		}

		map.jumpTo({
			pitch: navigationMode ? 0 : isThreeD ? 60 : 0,
			bearing: navigationMode ? 0 : isThreeD ? -20 : 0
		});
	};

	const findLabelLayerId = () => {
		if (!map) return undefined;

		return map
			.getStyle()
			.layers?.find((layer) => layer.type === 'symbol' && layer.layout?.['text-field'])?.id;
	};

	const installMapLayers = () => {
		if (!map) return;

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

		if (!map.getLayer(INCIDENT_LAYER_ID)) {
			map.addLayer({
				id: INCIDENT_LAYER_ID,
				type: 'circle',
				source: INCIDENT_SOURCE_ID,
				paint: {
					'circle-radius': 8,
					'circle-color': '#b86042',
					'circle-stroke-color': '#fff7ef',
					'circle-stroke-width': 2,
					'circle-opacity': 0.95
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
					'circle-stroke-color': '#fffdf8',
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
						'fill-extrusion-opacity': 0.55
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

		applyThreeDMode(false);
	};

	const buildPopupNode = (title: string, detail: string) => {
		const wrapper = document.createElement('div');
		wrapper.className = 'space-y-1';

		const heading = document.createElement('p');
		heading.className = 'text-sm font-semibold text-[#241f17]';
		heading.textContent = title;

		const body = document.createElement('p');
		body.className = 'text-xs text-[#5d584d]';
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

		const interactiveLayerIds = [
			ACTIVE_ROUTE_LAYER_ID,
			INACTIVE_ROUTE_LAYER_ID,
			INCIDENT_LAYER_ID,
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

		const handleMapDoubleClick = (event: MapboxMapMouseEvent) => {
			onDestinationPick?.({
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

				onDestinationPick({
					lat: point.lat,
					lng: point.lng
				});
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

		for (const layerId of interactiveLayerIds) {
			map.on('mouseenter', layerId, handleMouseEnter);
			map.on('mouseleave', layerId, handleMouseLeave);
		}

		map.on('click', ACTIVE_ROUTE_LAYER_ID, handleRouteClick);
		map.on('click', INACTIVE_ROUTE_LAYER_ID, handleRouteClick);
		map.on('click', INCIDENT_LAYER_ID, handleIncidentClick);
		map.on('click', LOCATION_CENTER_LAYER_ID, handleLocationClick);
		map.on('click', DESTINATION_CENTER_LAYER_ID, handleDestinationClick);
		map.on('dblclick', handleMapDoubleClick);
		canvasContainer.addEventListener('touchstart', handleTouchStart, { passive: true });
		canvasContainer.addEventListener('touchmove', handleTouchMove, { passive: true });
		canvasContainer.addEventListener('touchend', handleTouchEnd, { passive: true });
		canvasContainer.addEventListener('touchcancel', handleTouchEnd, { passive: true });

		return () => {
			for (const layerId of interactiveLayerIds) {
				map?.off('mouseenter', layerId, handleMouseEnter);
				map?.off('mouseleave', layerId, handleMouseLeave);
			}

			map?.off('click', ACTIVE_ROUTE_LAYER_ID, handleRouteClick);
			map?.off('click', INACTIVE_ROUTE_LAYER_ID, handleRouteClick);
			map?.off('click', INCIDENT_LAYER_ID, handleIncidentClick);
			map?.off('click', LOCATION_CENTER_LAYER_ID, handleLocationClick);
			map?.off('click', DESTINATION_CENTER_LAYER_ID, handleDestinationClick);
			map?.off('dblclick', handleMapDoubleClick);
			canvasContainer.removeEventListener('touchstart', handleTouchStart);
			canvasContainer.removeEventListener('touchmove', handleTouchMove);
			canvasContainer.removeEventListener('touchend', handleTouchEnd);
			canvasContainer.removeEventListener('touchcancel', handleTouchEnd);
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
		if (navigationMode) {
			return;
		}

		isThreeD = !isThreeD;
		applyThreeDMode();
		syncViewport();
	};

	onMount(() => {
		if (!hasMapboxToken || !mapHost) return;

		let cancelled = false;
		let removeInteractionHandlers = () => {};

		isThreeD = !navigationMode;

		const initMap = async () => {
			const mapboxImport = await import('mapbox-gl');
			mapbox = mapboxImport.default;
			if (cancelled || !mapHost) return;

			mapbox.accessToken = mapboxToken;

			map = new mapbox.Map({
				container: mapHost,
				style: mapboxStyleUrl,
				center: [PHNOM_PENH_CENTER.lng, PHNOM_PENH_CENTER.lat],
				zoom: 12.2,
				pitch: navigationMode ? 0 : 60,
				bearing: navigationMode ? 0 : -20,
				attributionControl: false,
				antialias: true
			});

			popup = new mapbox.Popup({
				closeButton: false,
				closeOnClick: true,
				offset: 14,
				maxWidth: '240px'
			});

			map.addControl(
				new mapbox.NavigationControl({
					showCompass: true,
					showZoom: true,
					visualizePitch: true
				}),
				'bottom-right'
			);
			map.addControl(new mapbox.FullscreenControl(), 'top-right');
			map.addControl(new mapbox.ScaleControl({ unit: 'metric' }), 'bottom-left');

			map.dragRotate.enable();
			map.touchZoomRotate.enableRotation();
			map.doubleClickZoom.disable();

			map.on('load', () => {
				if (!map || cancelled) return;

				styleReady = true;
				installMapLayers();
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

		void initMap();

		return () => {
			cancelled = true;
			removeInteractionHandlers();
			popup?.remove();
			popup = null;
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
		if (!map || !styleReady) return;

		const palette = getDestinationPalette(destinationTone);
		map.setPaintProperty(DESTINATION_HALO_LAYER_ID, 'circle-color', palette.halo);
		map.setPaintProperty(DESTINATION_CENTER_LAYER_ID, 'circle-color', palette.center);
		map.setPaintProperty(DESTINATION_CENTER_LAYER_ID, 'circle-stroke-color', palette.stroke);
	});

	$effect(() => {
		if (!navigationMode) return;

		isThreeD = false;
		applyThreeDMode(false);
		syncViewport();
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
				class={`absolute rounded-[14px] border border-white/10 bg-[rgba(17,18,22,0.76)] px-3 py-2 text-xs text-[var(--map-text)] shadow-[0_18px_48px_rgba(0,0,0,0.28)] backdrop-blur ${
					fullscreen ? 'top-20 right-3 hidden sm:top-20 sm:right-5 sm:block' : 'top-3 left-3'
				}`}
			>
				<div class="flex items-center gap-2">
					{#if !navigationMode}
						<button
							type="button"
							onclick={toggleThreeD}
							class="rounded-full border border-white/10 bg-white/8 px-2.5 py-1 font-medium text-[var(--map-text)] transition hover:border-white/25 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
							disabled={!mapReady}
						>
							{isThreeD ? '3D' : '2D'}
						</button>
					{:else}
						<span class="rounded-full border border-white/10 bg-white/8 px-2.5 py-1">
							Live traffic
						</span>
					{/if}
				</div>
				{#if !fullscreen}
					<p class="mt-2 font-medium">{isThreeD ? '3D scene enabled' : '2D scene enabled'}</p>
					<p class="mt-1 text-white/65">Rotate, pitch, and zoom with native Mapbox controls.</p>
				{/if}
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
		background: #232821;
		font-family: inherit;
	}

	:global(.mapboxgl-ctrl-group),
	:global(.mapboxgl-ctrl-scale),
	:global(.mapboxgl-ctrl-attrib) {
		border-color: rgba(255, 255, 255, 0.08);
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
		background: rgba(35, 40, 33, 0.92);
		color: #edf1ea;
	}

	:global(.mapboxgl-ctrl button .mapboxgl-ctrl-icon) {
		filter: invert(1);
	}

	:global(.mapboxgl-popup-content) {
		border: 1px solid rgba(36, 31, 23, 0.08);
		border-radius: 10px;
		box-shadow: 0 2px 10px rgba(36, 31, 23, 0.12);
		background: #fffdf8;
		padding: 10px 12px;
	}

	:global(.mapboxgl-popup-tip) {
		border-top-color: #fffdf8;
		border-bottom-color: #fffdf8;
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
