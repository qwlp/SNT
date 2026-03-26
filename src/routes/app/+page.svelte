<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onDestroy, untrack } from 'svelte';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { makeFunctionReference, type FunctionReference } from 'convex/server';
	import MapSurface from '$lib/components/MapSurface.svelte';
	import IncidentTypeIcon from '$lib/components/IncidentTypeIcon.svelte';
	import { getClerkContext } from '$lib/stores/clerk.svelte';
	import type { WeatherSnapshot } from '$lib/domain/weather';
	import {
		DEFAULT_ROUTING_PREFERENCES,
		ROUTING_COST_PRIORITIES,
		ROUTING_MODES,
		normalizeRoutingPreferences,
		type RoutingCostPriority,
		type RoutingMode,
		type RoutingPreferences
	} from '$lib/domain/routing';
	import {
		INCIDENT_LABELS,
		INCIDENT_TYPES,
		PHNOM_PENH_CENTER,
		UNIVERSITY_SEEDS,
		type GeoPoint,
		type IncidentType,
		type UniversitySeed
	} from '$lib/domain/traffic';
	import { haversineMeters, isNearDestination } from '$lib/services/geo';
	import { searchPlaces, type PlaceSearchResult } from '$lib/services/place-search';
	import {
		planRankedRoutes,
		type RankedClientRouteResult,
		type TrafficLevel
	} from '$lib/services/route-planner';
	import { api } from '../../convex/_generated/api';
	import type { Id } from '../../convex/_generated/dataModel';

	type AppTab = 'pulse' | 'route' | 'account';
	type DockHref = '/app?tab=pulse' | '/app?tab=route' | '/app?tab=account';
	type TripSyncMode = 'remote' | 'local';
	type ReportSheetState = 'collapsed' | 'half' | 'full';
	type MobileRouteSheetState = 'peek' | 'full';
	type RouteResponse = RankedClientRouteResult;
	type StoredRouteOption = {
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
		incidentIds: Id<'incidents'>[];
		shortcutIds: Id<'shortcutSegments'>[];
	};

	interface ActiveTripSnapshot {
		routeId: string;
		routeLabel: string;
		destination: GeoPoint;
		destinationName: string;
		baselineEtaSec: number;
		startedAt: number;
	}

	interface RouteDestinationState {
		point: GeoPoint;
		label: string;
		detail: string;
		presetId: UniversitySeed['id'] | null;
	}

	type RouteMutationArgs = {
		origin: GeoPoint;
		destination: GeoPoint;
		baselineEtaSec: number;
		selectedRoute: StoredRouteOption;
		alternativeRoutes: StoredRouteOption[];
		incidentIds: Id<'incidents'>[];
		shortcutIds: Id<'shortcutSegments'>[];
		preferenceSnapshot: RoutingPreferences;
		startedAt: number;
	};

	type RouteSampleMutationArgs = {
		routeSessionId: Id<'routeSessions'>;
		location: GeoPoint;
		recordedAt: number;
	};
	type RouteSessionResult = {
		_id: Id<'routeSessions'>;
		actualDurationSec?: number;
		arrivedAt?: number;
	} | null;

	type RouteSessionMutationRef = FunctionReference<
		'mutation',
		'public',
		RouteMutationArgs,
		RouteSessionResult
	>;
	type AppendRouteSampleMutationRef = FunctionReference<
		'mutation',
		'public',
		RouteSampleMutationArgs,
		{ locationSamplesCount: number }
	>;
	type CompleteRouteSessionMutationRef = FunctionReference<
		'mutation',
		'public',
		RouteSampleMutationArgs,
		RouteSessionResult
	>;

	const createRouteSessionMutation = makeFunctionReference<
		'mutation',
		RouteMutationArgs,
		RouteSessionResult
	>('authed/routes:createSession') as RouteSessionMutationRef;
	const appendRouteSampleMutation = makeFunctionReference<
		'mutation',
		RouteSampleMutationArgs,
		{ locationSamplesCount: number }
	>('authed/routes:appendSample') as AppendRouteSampleMutationRef;
	const completeRouteSessionMutation = makeFunctionReference<
		'mutation',
		RouteSampleMutationArgs,
		RouteSessionResult
	>('authed/routes:completeSession') as CompleteRouteSessionMutationRef;

	const clerkContext = getClerkContext();
	const convex = useConvexClient();

	const meQuery = useQuery(api.authed.users.me, () => (clerkContext.currentUser ? {} : 'skip'));
	const incidentsQuery = useQuery(api.authed.incidents.listActive, () =>
		clerkContext.currentUser ? {} : 'skip'
	);
	const myIncidentsQuery = useQuery(api.authed.incidents.listMine, () =>
		clerkContext.currentUser ? {} : 'skip'
	);
	const shortcutsQuery = useQuery(api.authed.shortcuts.listActive, () =>
		clerkContext.currentUser ? {} : 'skip'
	);

	const dockItems: Array<{ id: AppTab; label: string; href: DockHref }> = [
		{ id: 'pulse', label: 'Report', href: '/app?tab=pulse' },
		{ id: 'route', label: 'Route', href: '/app?tab=route' },
		{ id: 'account', label: 'Account', href: '/app?tab=account' }
	];

	const panelCopy: Record<AppTab, { title: string; subtitle: string }> = {
		pulse: {
			title: 'Report a place',
			subtitle: 'Pin it, describe it, publish it'
		},
		route: {
			title: 'Route planner',
			subtitle: 'Plan and track'
		},
		account: {
			title: 'My account',
			subtitle: 'Trust and history'
		}
	};
	const REPORT_TYPE_LABELS: Record<IncidentType, string> = {
		roadblock: 'Hazard',
		flood: 'Flooding',
		accident: 'Crash',
		vip: 'Closure',
		wedding: 'Event',
		police: 'Police'
	};

	const formatMinutes = (durationSec: number) => `${Math.max(1, Math.round(durationSec / 60))} min`;
	const formatDistance = (distanceMeters: number) =>
		`${(distanceMeters / 1000).toFixed(distanceMeters >= 10_000 ? 0 : 1)} km`;
	const formatNavDistance = (distanceMeters: number) =>
		distanceMeters >= 1000
			? `${(distanceMeters / 1000).toFixed(distanceMeters >= 10_000 ? 0 : 1)} km`
			: `${Math.max(20, Math.round(distanceMeters / 10) * 10)} m`;
	const formatError = (error: unknown, fallback: string) =>
		error instanceof Error ? error.message : fallback;
	const formatArrivalTime = (timestamp: number) =>
		new Date(timestamp).toLocaleTimeString('en-US', {
			hour: 'numeric',
			minute: '2-digit'
		});
	const getTrafficBadgeClass = (level: TrafficLevel) => {
		if (level === 'severe') return 'border border-[#fecaca] bg-[#fff1f2] text-[#b42318]';
		if (level === 'heavy') return 'border border-[#f6c78e] bg-[#fff2e2] text-[#9a4d00]';
		if (level === 'moderate')
			return 'border border-[var(--warning-border)] bg-[var(--warning-soft)] text-[var(--warning)]';
		if (level === 'light') return 'border border-[#b7e6d4] bg-[#eefbf5] text-[#166534]';
		return 'border border-[#b6dcff] bg-[#edf6ff] text-[#0f5fcb]';
	};
	const getTrafficLabel = (level: TrafficLevel) => {
		if (level === 'severe') return 'Severe';
		if (level === 'heavy') return 'Heavy';
		if (level === 'moderate') return 'Moderate';
		if (level === 'light') return 'Light';
		return 'Clear';
	};
	const getRoutingModeLabel = (mode: RoutingMode) => {
		if (mode === 'heavy_vehicle') return 'Heavy vehicle';
		if (mode === 'pedestrian') return 'Pedestrian';
		return mode.charAt(0).toUpperCase() + mode.slice(1);
	};
	const getCostPriorityLabel = (priority: RoutingCostPriority) => {
		if (priority === 'lowest_tolls') return 'Lowest tolls';
		if (priority === 'lowest_fuel') return 'Lowest fuel';
		if (priority === 'fastest') return 'Fastest';
		return 'Balanced';
	};
	const formatFuelEstimate = (liters: number) =>
		liters <= 0 ? 'No fuel' : `${liters.toFixed(liters >= 10 ? 0 : 1)} L`;
	const formatTollEstimate = (usd: number) =>
		usd <= 0.01 ? 'No tolls' : `$${usd.toFixed(usd >= 10 ? 0 : 2)}`;
	const getRoleLabel = (role: 'citizen' | 'campus_rep' | undefined) =>
		role === 'campus_rep' ? 'Campus rep' : 'Citizen';
	const getIncidentStatusClass = (status: 'active' | 'expired') =>
		status === 'active'
			? 'bg-[#e8f7ee] text-[#20593b]'
			: 'bg-[var(--surface-muted)] text-[var(--muted)]';
	const formatShortDate = (timestamp: number) =>
		new Date(timestamp).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric'
		});
	const formatPointLabel = (point: GeoPoint) => `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`;
	const formatTemperature = (value: number) => `${Math.round(value)}°C`;
	const formatWindSpeed = (value: number) => `${Math.round(value)} km/h`;
	const formatRainChance = (snapshot: WeatherSnapshot | null) =>
		snapshot
			? snapshot.isRainingNow
				? 'Raining now'
				: snapshot.willRainSoon
					? snapshot.nextRainEtaHours === 0
						? 'Rain within 1h'
						: `Rain in ${snapshot.nextRainEtaHours}h`
					: 'Dry for now'
			: 'Checking rain';
	const getWeatherSummaryPill = (snapshot: WeatherSnapshot | null) =>
		snapshot
			? `${snapshot.conditionLabel} • ${formatRainChance(snapshot)}`
			: 'Checking local weather';
	const getWeatherIcon = (snapshot: WeatherSnapshot | null) => {
		if (snapshot?.isStormingNow) return 'storm';
		if (snapshot?.isRainingNow) return 'rain';
		if (snapshot?.willRainSoon) return 'watch';
		return 'clear';
	};
	const createRouteDestination = (
		point: GeoPoint,
		override?: Pick<RouteDestinationState, 'label' | 'detail' | 'presetId'>
	): RouteDestinationState => {
		if (override) {
			return {
				point,
				label: override.label,
				detail: override.detail,
				presetId: override.presetId
			};
		}

		const nearestPreset = UNIVERSITY_SEEDS.map((university) => ({
			university,
			distanceMeters: haversineMeters(point, university.campus)
		})).sort((left, right) => left.distanceMeters - right.distanceMeters)[0];

		if (nearestPreset && nearestPreset.distanceMeters <= 180) {
			return {
				point,
				label: nearestPreset.university.shortName,
				detail: nearestPreset.university.name,
				presetId: nearestPreset.university.id
			};
		}

		return {
			point,
			label: 'Pinned destination',
			detail: formatPointLabel(point),
			presetId: null
		};
	};
	const toStoredRoute = (route: RouteResponse['routes'][number]): StoredRouteOption => ({
		routeId: route.routeId,
		providerRouteId: route.providerRouteId,
		label: route.label,
		geometry: route.geometry,
		distanceMeters: route.distanceMeters,
		durationSec: route.durationSec,
		adjustedScore: route.adjustedScore,
		estimatedFuelLiters: route.estimatedFuelLiters,
		estimatedTollCostUsd: route.estimatedTollCostUsd,
		explanationChips: route.explanationChips,
		incidentIds: route.incidentIds,
		shortcutIds: route.shortcutIds
	});
	const setRouteDestination = (
		point: GeoPoint,
		override?: Pick<RouteDestinationState, 'label' | 'detail' | 'presetId'>
	): RouteDestinationState | null => {
		if (tripStatus === 'tracking') {
			tripError = 'Finish the active trip before picking a new destination.';
			routeSheetOpen = true;
			return null;
		}

		const nextDestination = createRouteDestination(point, override);
		routeDestination = nextDestination;
		routeSheetOpen = true;
		routeRequestId += 1;
		pendingRouteRequestCount = 0;
		routeLoading = false;
		routeResult = null;
		selectedRouteId = null;
		routeMessage = null;
		routeError = null;
		tripError = null;
		tripMessage = null;
		return nextDestination;
	};

	const clearRoutePlan = () => {
		if (tripStatus === 'tracking') return;

		routeDestination = null;
		routeSheetOpen = false;
		routeRequestId += 1;
		pendingRouteRequestCount = 0;
		routeLoading = false;
		routeResult = null;
		selectedRouteId = null;
		routeMessage = null;
		routeError = null;
		tripError = null;
		tripMessage = null;
		resetDestinationSearch();
	};
	const resetDestinationSearch = () => {
		searchQuery = '';
		searchLockedQuery = null;
		searchResults = [];
		searchLoading = false;
		searchError = null;
		searchRequestId += 1;
	};

	let selectedType = $state<IncidentType>('roadblock');
	let reportNote = $state('');
	let reportSubmitting = $state(false);
	let reportFeedback = $state<string | null>(null);
	let reportError = $state<string | null>(null);
	let reportLocation = $state<GeoPoint | null>(null);
	let reportLocationMode = $state<'pin' | 'gps' | null>(null);
	let currentLocation = $state<GeoPoint | null>(null);
	let routeResult = $state<RouteResponse | null>(null);
	let routeLoading = $state(false);
	let routeMessage = $state<string | null>(null);
	let routeError = $state<string | null>(null);
	let routeDestination = $state<RouteDestinationState | null>(null);
	let routeSheetOpen = $state(false);
	let activeTripId = $state<Id<'routeSessions'> | null>(null);
	let activeTrip = $state<ActiveTripSnapshot | null>(null);
	let activeTripSyncMode = $state<TripSyncMode>('remote');
	let tripStatus = $state<'idle' | 'tracking'>('idle');
	let tripBusy = $state<'starting' | 'arriving' | null>(null);
	let tripMessage = $state<string | null>(null);
	let tripError = $state<string | null>(null);
	let selectedRouteId = $state<string | null>(null);
	let locationInterval = $state<number | null>(null);
	let reportSheetState = $state<ReportSheetState>('collapsed');
	let accountDrawerExpanded = $state(true);
	let routeRequestId = $state(0);
	let profileSyncRequest: Promise<unknown> | null = null;
	let profileSyncUserId: string | null = null;
	let routePreferencesSaving = $state(false);
	let routePreferencesError = $state<string | null>(null);
	let lastMapRoutePick = $state<{ point: GeoPoint; at: number } | null>(null);
	let searchQuery = $state('');
	let searchLockedQuery = $state<string | null>(null);
	let searchResults = $state<PlaceSearchResult[]>([]);
	let searchLoading = $state(false);
	let searchError = $state<string | null>(null);
	let searchRequestId = $state(0);
	let weather = $state<WeatherSnapshot | null>(null);
	let weatherLoading = $state(false);
	let weatherError = $state<string | null>(null);
	let weatherRequestId = $state(0);
	let pendingRouteRequestCount = 0;
	let mobileRouteSheetState = $state<MobileRouteSheetState>('peek');
	let mobileRouteSheetPointerStartY = 0;
	let mobileRouteSheetPointerStartState: MobileRouteSheetState = 'peek';

	const activeTab = $derived.by((): AppTab => {
		const tab = page.url.searchParams.get('tab');
		if (tab === 'route' || tab === 'account') return tab;
		return 'pulse';
	});

	const incidents = $derived(incidentsQuery.data ?? []);
	const myIncidents = $derived(myIncidentsQuery.data ?? []);
	const shortcuts = $derived(shortcutsQuery.data ?? []);
	const routingPreferences = $derived(
		normalizeRoutingPreferences(meQuery.data?.routingPreferences ?? DEFAULT_ROUTING_PREFERENCES)
	);
	const routeOptions = $derived(routeResult?.routes ?? []);
	const selectedRoute = $derived(
		routeOptions.find((route) => route.routeId === selectedRouteId) ?? routeOptions[0] ?? null
	);
	const navigationRoute = $derived.by(() => {
		const trackingTrip = activeTrip;
		if (tripStatus === 'tracking' && trackingTrip) {
			return routeOptions.find((route) => route.routeId === trackingTrip.routeId) ?? selectedRoute;
		}

		return selectedRoute;
	});
	const isSignedIn = $derived(Boolean(clerkContext.currentUser));
	const reportFocusPoints = $derived.by(() =>
		[reportLocation, currentLocation].filter((point): point is GeoPoint => point !== null)
	);
	const nextCueDistanceLabel = $derived(
		navigationRoute
			? formatNavDistance(navigationRoute.navigationCue.distanceMeters)
			: 'Search route'
	);
	const nextArrivalLabel = $derived(
		navigationRoute ? formatArrivalTime(navigationRoute.arrivalTime) : '--:--'
	);
	const routePanelOriginLabel = $derived(currentLocation ? 'Your location' : 'Locating...');
	const routePanelOriginDetail = $derived(
		currentLocation
			? `${currentLocation.lat.toFixed(4)}, ${currentLocation.lng.toFixed(4)}`
			: 'Waiting for live GPS fix'
	);
	const mobileRouteSheetPreviewLabel = $derived.by(() => {
		if (tripStatus === 'tracking' && navigationRoute) {
			return `Live • ${nextArrivalLabel}`;
		}

		if (selectedRoute) {
			return `${formatMinutes(selectedRoute.durationSec)} • Arrive ${nextArrivalLabel}`;
		}

		if (searchLoading) {
			return 'Searching destinations...';
		}

		return 'Choose a destination';
	});
	const currentCueModifier = $derived(navigationRoute?.navigationCue.modifier ?? 'straight');
	const navigationInstruction = $derived(
		navigationRoute?.navigationCue.instruction ?? 'Trip is live. Follow the highlighted path.'
	);
	const activeRouteLabel = $derived(
		activeTrip?.routeLabel ?? navigationRoute?.label ?? 'Navigation mode'
	);
	const currentRouteDestination = $derived(
		activeTrip?.destination ?? routeDestination?.point ?? null
	);
	const currentRouteDestinationLabel = $derived(
		activeTrip?.destinationName ?? routeDestination?.label ?? 'Pinned destination'
	);
	const navigationRoadLabel = $derived(
		navigationRoute?.navigationCue.roadName ?? currentRouteDestinationLabel
	);
	const currentRouteDestinationDetail = $derived(
		routeDestination?.detail ??
			(currentRouteDestination
				? `${currentRouteDestination.lat.toFixed(4)}, ${currentRouteDestination.lng.toFixed(4)}`
				: 'Search for a destination to load route options.')
	);
	const routeDistanceLabel = $derived.by(() => {
		if (selectedRoute) {
			return formatDistance(selectedRoute.distanceMeters);
		}

		if (currentLocation && currentRouteDestination) {
			return formatDistance(haversineMeters(currentLocation, currentRouteDestination));
		}

		return '--';
	});
	const showRouteHud = $derived(
		Boolean(routeDestination) || tripStatus === 'tracking' || Boolean(activeTrip)
	);
	const drawerExpanded = $derived(
		activeTab === 'pulse'
			? reportSheetState !== 'collapsed'
			: activeTab === 'account'
				? accountDrawerExpanded
				: true
	);
	const mapRoutes = $derived(activeTab === 'route' ? routeOptions : []);
	const mapTrackedRoute = $derived(
		activeTab === 'route' && tripStatus === 'tracking' ? (navigationRoute?.geometry ?? null) : null
	);
	const mapDestination = $derived.by(() => {
		if (activeTab === 'pulse') {
			return reportLocation;
		}

		if (activeTab === 'route') {
			return currentRouteDestination;
		}

		return null;
	});
	const mapDestinationLabel = $derived.by(() => {
		if (activeTab === 'pulse') {
			return reportLocationMode === 'gps' ? 'Live report location' : 'Report pin';
		}

		if (activeTab === 'route') {
			return currentRouteDestinationLabel;
		}

		return 'Pinned destination';
	});
	const mapDestinationTone = $derived(activeTab === 'pulse' ? 'report' : 'destination');
	const mapDestinationMoveHint = $derived.by(() => {
		if (activeTab === 'pulse') {
			return 'Double-click again anywhere to move this report pin.';
		}

		if (activeTab === 'route') {
			return 'Double-click again anywhere to move this destination.';
		}

		return 'Switch to Report or Route to place a pin.';
	});
	const mapActiveRouteStyle = $derived(
		activeTab === 'route' && tripStatus === 'tracking' ? 'navigation' : 'traffic'
	);
	const mapActiveRouteId = $derived.by(() => {
		if (activeTab !== 'route') {
			return null;
		}

		return tripStatus === 'tracking' ? (activeTrip?.routeId ?? selectedRouteId) : selectedRouteId;
	});
	const mapFocusPoints = $derived(activeTab === 'pulse' ? reportFocusPoints : []);
	const mapDestinationPicker = $derived.by(() => {
		if (activeTab === 'pulse') {
			return pickReportLocationFromMap;
		}

		if (activeTab === 'route') {
			return pickRouteDestinationFromMap;
		}

		return undefined;
	});
	const mobileRouteBanner = $derived.by(() => {
		if (tripError) {
			return {
				tone: 'error' as const,
				message: tripError
			};
		}

		if (routeError) {
			return {
				tone: 'error' as const,
				message: routeError
			};
		}

		return null;
	});
	const hasRouteContext = $derived(
		Boolean(routeDestination) ||
			routeLoading ||
			routeOptions.length > 0 ||
			Boolean(routeMessage) ||
			Boolean(routeError) ||
			Boolean(tripMessage) ||
			Boolean(tripError) ||
			tripStatus !== 'idle'
	);
	const routeSearchActive = $derived(activeTab === 'route' && tripStatus !== 'tracking');
	const routeSearchVisible = $derived(routeSearchActive);
	const preferenceSummary = $derived.by(() => {
		const chips = [
			getRoutingModeLabel(routingPreferences.mode),
			getCostPriorityLabel(routingPreferences.costPriority)
		];

		if (routingPreferences.avoidHighways) chips.push('Avoid highways');
		if (routingPreferences.avoidUTurns) chips.push('Avoid U-turns');
		if (routingPreferences.preferWellLitStreets) chips.push('Prefer lit streets');
		if (routingPreferences.preferFewerTurns) chips.push('Fewer turns');

		return chips;
	});
	const weatherTargetLocation = $derived(currentLocation ?? PHNOM_PENH_CENTER);
	const weatherLocationKey = $derived(
		`${weatherTargetLocation.lat.toFixed(2)},${weatherTargetLocation.lng.toFixed(2)}`
	);
	const reportSheetHeightClass = $derived.by(() => {
		if (reportSheetState === 'full') return 'h-[72svh] sm:h-[76svh]';
		if (reportSheetState === 'half') return 'h-[28svh] sm:h-[300px]';
		return 'h-[88px]';
	});
	const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number, message: string) =>
		new Promise<T>((resolve, reject) => {
			const timeoutId = window.setTimeout(() => {
				reject(new Error(message));
			}, timeoutMs);

			void promise.then(
				(value) => {
					window.clearTimeout(timeoutId);
					resolve(value);
				},
				(error: unknown) => {
					window.clearTimeout(timeoutId);
					reject(error);
				}
			);
		});
	const getMobileRouteBannerClass = (tone: 'error' | 'info' | 'success') => {
		if (tone === 'error') {
			return 'border-[#f1b7a4] bg-[#fff0eb] text-[#7d2c1d]';
		}

		if (tone === 'success') {
			return 'border-[#b7e6d4] bg-[#eefbf5] text-[#155544]';
		}

		return 'border-[#f0dfb5] bg-[#fff7e2] text-[#6d5320]';
	};
	const loadWeather = async (location: GeoPoint) => {
		const requestId = weatherRequestId + 1;
		weatherRequestId = requestId;
		weatherLoading = true;
		weatherError = null;

		try {
			const searchParams = new URLSearchParams({
				lat: location.lat.toFixed(4),
				lng: location.lng.toFixed(4)
			});
			const response = await fetch(`/api/weather?${searchParams.toString()}`);

			if (!response.ok) {
				throw new Error('Unable to load weather.');
			}

			const payload = (await response.json()) as WeatherSnapshot;

			if (requestId !== weatherRequestId) {
				return;
			}

			weather = payload;
		} catch (error) {
			if (requestId !== weatherRequestId) {
				return;
			}

			weatherError = formatError(error, 'Unable to load weather.');
		} finally {
			if (requestId === weatherRequestId) {
				weatherLoading = false;
			}
		}
	};
	const runPlaceSearch = async (query = searchQuery) => {
		const trimmedQuery = query.trim();

		if (trimmedQuery.length < 2) {
			searchResults = [];
			searchLoading = false;
			searchError = null;
			return [];
		}

		const requestId = searchRequestId + 1;
		searchRequestId = requestId;
		searchLoading = true;
		searchError = null;

		try {
			const results = await searchPlaces({
				query: trimmedQuery,
				proximity: currentLocation,
				limit: 6
			});

			if (requestId !== searchRequestId) {
				return [];
			}

			searchResults = results;
			searchError = results.length === 0 ? `No places matched "${trimmedQuery}".` : null;
			return results;
		} catch (error) {
			if (requestId !== searchRequestId) {
				return [];
			}

			searchResults = [];
			searchError = formatError(error, 'Unable to search places right now.');
			return [];
		} finally {
			if (requestId === searchRequestId) {
				searchLoading = false;
			}
		}
	};

	const selectSearchResult = (result: PlaceSearchResult) => {
		searchQuery = result.label;
		searchLockedQuery = result.label;
		searchResults = [];
		searchLoading = false;
		searchError = null;

		const nextDestination = setRouteDestination(result.point, {
			label: result.label,
			detail: result.detail,
			presetId: result.presetId
		});
		if (!nextDestination) return;

		void planRoute(nextDestination);
	};

	const submitPlaceSearch = async () => {
		const immediateResult = searchResults[0];
		if (immediateResult) {
			selectSearchResult(immediateResult);
			return;
		}

		const results = await runPlaceSearch();
		if (results[0]) {
			selectSearchResult(results[0]);
			return;
		}

		routeSheetOpen = true;
	};

	const handleSearchInput = (event: Event) => {
		const target = event.currentTarget;
		if (!(target instanceof HTMLInputElement)) return;

		searchQuery = target.value;

		if (searchLockedQuery && target.value.trim() !== searchLockedQuery) {
			searchLockedQuery = null;
		}

		if (target.value.trim().length === 0) {
			searchResults = [];
			searchLoading = false;
			searchError = null;
			searchRequestId += 1;
		}
	};

	const handleSearchKeydown = (event: KeyboardEvent) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			void submitPlaceSearch();
			return;
		}

		if (event.key === 'Escape') {
			searchResults = [];
			searchLoading = false;
			searchError = null;
			searchRequestId += 1;
		}
	};

	const stopTripSampling = () => {
		if (locationInterval) {
			window.clearInterval(locationInterval);
			locationInterval = null;
		}
	};

	const recordSample = async (routeSessionId: Id<'routeSessions'>) => {
		await convex.mutation(appendRouteSampleMutation, {
			routeSessionId,
			location: currentLocation ?? PHNOM_PENH_CENTER,
			recordedAt: Date.now()
		});
	};

	const startLocalTrip = (
		target: RouteDestinationState,
		route: NonNullable<typeof selectedRoute>
	) => {
		activeTripId = null;
		activeTripSyncMode = 'local';
		activeTrip = {
			routeId: route.routeId,
			routeLabel: route.label,
			destination: target.point,
			destinationName: target.label,
			baselineEtaSec: route.durationSec,
			startedAt: Date.now()
		};
		selectedRouteId = route.routeId;
		tripStatus = 'tracking';
		routeSheetOpen = true;
		stopTripSampling();
		tripMessage = null;
	};

	const updateRoutingPreferences = async (patch: Partial<RoutingPreferences>) => {
		if (routePreferencesSaving) return;

		routePreferencesSaving = true;
		routePreferencesError = null;

		const nextPreferences = normalizeRoutingPreferences({
			...routingPreferences,
			...patch
		});

		try {
			await convex.mutation(api.authed.users.updateRoutingPreferences, {
				routingPreferences: nextPreferences
			});

			if (routeDestination && tripStatus !== 'tracking') {
				await planRoute(routeDestination, nextPreferences);
			}
		} catch (error) {
			routePreferencesError = formatError(error, 'Unable to save route preferences.');
		} finally {
			routePreferencesSaving = false;
		}
	};

	const handleRoutingModeChange = (event: Event) => {
		const target = event.currentTarget;
		if (!(target instanceof HTMLSelectElement)) return;
		void updateRoutingPreferences({ mode: target.value as RoutingMode });
	};

	const handleCostPriorityChange = (event: Event) => {
		const target = event.currentTarget;
		if (!(target instanceof HTMLSelectElement)) return;
		void updateRoutingPreferences({ costPriority: target.value as RoutingCostPriority });
	};

	const planRoute = async (
		target = routeDestination,
		preferencesOverride: RoutingPreferences = routingPreferences
	) => {
		if (!target) {
			routeError = 'Search for a destination first.';
			routeSheetOpen = true;
			return;
		}

		const requestId = routeRequestId + 1;
		routeRequestId = requestId;
		pendingRouteRequestCount += 1;
		routeLoading = true;
		routeError = null;
		routeMessage = null;
		tripError = null;

		try {
			const result = await planRankedRoutes({
				origin: currentLocation ?? PHNOM_PENH_CENTER,
				destination: target.point,
				incidents,
				shortcuts,
				preferences: preferencesOverride
			});

			if (requestId !== routeRequestId) {
				return;
			}

			routeResult = result;
			selectedRouteId = result.routes[0]?.routeId ?? null;
			routeSheetOpen = true;
			routeMessage =
				result.routes.length > 0
					? `Loaded ${result.routes.length} live traffic routes to ${target.label}.`
					: `No routes returned for ${target.label}.`;

			if (!currentLocation) {
				routeMessage += ' GPS is still warming up, so the city center fallback was used.';
			}
		} catch (error) {
			if (requestId !== routeRequestId) {
				return;
			}
			routeError = formatError(error, 'Unable to plan route.');
		} finally {
			pendingRouteRequestCount = Math.max(0, pendingRouteRequestCount - 1);
			routeLoading = pendingRouteRequestCount > 0;
		}
	};

	const beginTrip = async () => {
		if (tripStatus === 'tracking' || tripBusy) return;
		if (!selectedRoute) {
			tripError = 'Choose a route first.';
			return;
		}
		if (!routeDestination) {
			tripError = 'Search for where you are going first.';
			routeSheetOpen = true;
			return;
		}

		tripBusy = 'starting';
		tripError = null;
		tripMessage = null;
		activeTripId = null;
		activeTrip = null;
		activeTripSyncMode = 'remote';
		try {
			const session = await withTimeout(
				convex.mutation(createRouteSessionMutation, {
					origin: currentLocation ?? PHNOM_PENH_CENTER,
					destination: routeDestination.point,
					baselineEtaSec: selectedRoute.durationSec,
					selectedRoute: toStoredRoute(selectedRoute),
					alternativeRoutes: routeOptions
						.filter((route) => route.routeId !== selectedRoute.routeId)
						.map(toStoredRoute),
					incidentIds: selectedRoute.incidentIds,
					shortcutIds: selectedRoute.shortcutIds,
					preferenceSnapshot: routingPreferences,
					startedAt: Date.now()
				}),
				10_000,
				'Trip start timed out while waiting for cloud sync.'
			).catch(() => null);

			if (!session) {
				startLocalTrip(routeDestination, selectedRoute);
				return;
			}

			activeTripId = session._id;
			activeTripSyncMode = 'remote';
			activeTrip = {
				routeId: selectedRoute.routeId,
				routeLabel: selectedRoute.label,
				destination: routeDestination.point,
				destinationName: routeDestination.label,
				baselineEtaSec: selectedRoute.durationSec,
				startedAt: Date.now()
			};
			selectedRouteId = selectedRoute.routeId;
			tripStatus = 'tracking';
			routeSheetOpen = true;

			try {
				await recordSample(session._id);
			} catch {
				tripMessage = `Trip started to ${routeDestination.label}. Live sampling will retry in the background.`;
			}

			stopTripSampling();
			locationInterval = window.setInterval(() => {
				if (!session._id) return;
				void recordSample(session._id);
			}, 20_000);

			if (!tripMessage) {
				tripMessage = `Trip started to ${routeDestination.label}.`;
			}
		} catch (error) {
			tripError = formatError(error, 'Unable to start trip.');
		} finally {
			tripBusy = null;
		}
	};

	const markArrived = async () => {
		if (!activeTrip || tripBusy) return;

		tripBusy = 'arriving';
		tripError = null;
		tripMessage = null;

		try {
			if (!activeTripId || activeTripSyncMode === 'local') {
				stopTripSampling();
				tripStatus = 'idle';
				activeTripId = null;
				activeTrip = null;
				activeTripSyncMode = 'remote';
				return;
			}

			const completedSession = await withTimeout(
				convex.mutation(completeRouteSessionMutation, {
					routeSessionId: activeTripId,
					location: currentLocation ?? PHNOM_PENH_CENTER,
					recordedAt: Date.now()
				}),
				8_000,
				'Trip completion timed out while waiting for cloud sync.'
			);

			if (!completedSession) {
				throw new Error('Trip completion failed.');
			}

			stopTripSampling();
			tripStatus = 'idle';
			activeTripId = null;
			activeTrip = null;
			activeTripSyncMode = 'remote';
		} catch (error) {
			tripError = formatError(error, 'Unable to complete trip.');
		} finally {
			tripBusy = null;
		}
	};

	const submitIncident = async (type: IncidentType = selectedType) => {
		if (reportSubmitting) return;
		const location = reportLocation ?? currentLocation;
		const locationMode = reportLocation ? reportLocationMode : currentLocation ? 'gps' : null;

		selectedType = type;

		if (!location || !locationMode) {
			reportError = 'Drop a pin on the map or wait for GPS before reporting.';
			reportFeedback = null;
			reportSheetState = 'half';
			return;
		}

		reportSubmitting = true;
		reportFeedback = null;
		reportError = null;

		try {
			await convex.mutation(api.authed.incidents.create, {
				type,
				location,
				description: reportNote.trim() || undefined
			});

			reportNote = '';
			reportSheetState = 'half';
			reportLocation = null;
			reportLocationMode = null;
			reportFeedback = `${INCIDENT_LABELS[type].en} reported successfully at ${locationMode === 'gps' ? 'your live location' : 'the pinned spot'}.`;
		} catch (error) {
			reportError = formatError(error, 'Unable to send road report.');
		} finally {
			reportSubmitting = false;
		}
	};

	const selectRoute = (routeId: string) => {
		if (tripStatus === 'tracking') return;

		selectedRouteId = routeId;
		routeSheetOpen = true;
		tripMessage = null;
		routeMessage = 'Route selected. Start trip to lock it in.';
	};

	const setReportLocation = (point: GeoPoint, mode: 'pin' | 'gps') => {
		reportLocation = point;
		reportLocationMode = mode;
		reportFeedback = null;
		reportError = null;
		if (reportSheetState === 'collapsed') {
			reportSheetState = 'half';
		}
	};

	const cycleReportSheet = () => {
		if (reportSheetState === 'collapsed') {
			reportSheetState = 'half';
			return;
		}

		if (reportSheetState === 'half') {
			reportSheetState = 'full';
			return;
		}

		reportSheetState = 'collapsed';
	};
	const setReportSheetState = (next: ReportSheetState) => {
		reportSheetState = next;
	};
	const toggleActiveDrawer = () => {
		if (activeTab === 'pulse') {
			cycleReportSheet();
			return;
		}

		if (activeTab === 'account') {
			accountDrawerExpanded = !accountDrawerExpanded;
		}
	};
	const handleQuickReportAction = () => {
		if (activeTab !== 'pulse') return;

		if (reportSheetState === 'collapsed') {
			reportSheetState = 'half';
			return;
		}

		void submitIncident(selectedType);
	};

	const pickReportLocationFromMap = (point: GeoPoint) => {
		setReportLocation(point, 'pin');
	};

	const pickRouteDestinationFromMap = (point: GeoPoint) => {
		if (
			lastMapRoutePick &&
			Date.now() - lastMapRoutePick.at < 500 &&
			haversineMeters(lastMapRoutePick.point, point) < 20
		) {
			return;
		}

		lastMapRoutePick = {
			point,
			at: Date.now()
		};

		const nextDestination = setRouteDestination(point);
		if (!nextDestination) return;

		searchQuery = nextDestination.label;
		searchLockedQuery = nextDestination.label;
		searchResults = [];
		searchError = null;

		void planRoute(nextDestination);
	};

	const choosePresetDestination = (university: UniversitySeed) => {
		const nextDestination = setRouteDestination(university.campus, {
			label: university.shortName,
			detail: university.name,
			presetId: university.id
		});
		if (!nextDestination) return;

		searchQuery = university.shortName;
		searchLockedQuery = university.shortName;
		searchResults = [];
		searchError = null;

		void planRoute(nextDestination);
	};

	const handleTabNavigation = async (href: DockHref) => {
		await goto(resolve(href));
	};

	const setMobileRouteSheetState = (nextState: MobileRouteSheetState) => {
		mobileRouteSheetState = nextState;
	};

	const handleMobileRouteSheetPointerDown = (event: PointerEvent) => {
		mobileRouteSheetPointerStartY = event.clientY;
		mobileRouteSheetPointerStartState = mobileRouteSheetState;
	};

	const handleMobileRouteSheetPointerUp = (event: PointerEvent) => {
		const deltaY = event.clientY - mobileRouteSheetPointerStartY;

		if (Math.abs(deltaY) < 12) {
			mobileRouteSheetState = mobileRouteSheetState === 'peek' ? 'full' : 'peek';
			return;
		}

		if (deltaY < -24) {
			mobileRouteSheetState = 'full';
			return;
		}

		if (deltaY > 24) {
			mobileRouteSheetState = 'peek';
			return;
		}

		mobileRouteSheetState = mobileRouteSheetPointerStartState;
	};

	$effect(() => {
		if (!clerkContext.currentUser) {
			reportFeedback = null;
			reportError = null;
			reportLocation = null;
			reportLocationMode = null;
			reportSheetState = 'collapsed';
			routeDestination = null;
			routeSheetOpen = false;
			routeResult = null;
			routeMessage = null;
			routeError = null;
			tripMessage = null;
			tripError = null;
			resetDestinationSearch();
			selectedRouteId = null;
			activeTripId = null;
			activeTrip = null;
			activeTripSyncMode = 'remote';
			tripStatus = 'idle';
			profileSyncUserId = null;
			profileSyncRequest = null;
			stopTripSampling();
			return;
		}

		if (meQuery.data) {
			profileSyncUserId = clerkContext.currentUser.id;
			return;
		}

		if (profileSyncRequest || profileSyncUserId === clerkContext.currentUser.id) {
			return;
		}

		profileSyncUserId = clerkContext.currentUser.id;
		profileSyncRequest = convex
			.mutation(api.authed.users.ensureProfile, {})
			.catch(() => {})
			.finally(() => {
				profileSyncRequest = null;
			});
	});

	$effect(() => {
		if (reportLocationMode !== 'gps' || !currentLocation) return;

		reportLocation = currentLocation;
	});

	$effect(() => {
		if (!routeSearchActive) {
			untrack(() => {
				const shouldResetSearchState =
					searchResults.length > 0 || searchLoading || searchError !== null;

				searchResults = [];
				searchLoading = false;
				searchError = null;

				if (shouldResetSearchState) {
					searchRequestId += 1;
				}
			});
			return;
		}

		const trimmedQuery = searchQuery.trim();
		if (trimmedQuery.length < 2) {
			untrack(() => {
				searchResults = [];
				searchLoading = false;
				searchError = null;
			});
			return;
		}

		if (searchLockedQuery && trimmedQuery === searchLockedQuery) {
			return;
		}

		const timeoutId = window.setTimeout(() => {
			void runPlaceSearch(trimmedQuery);
		}, 280);

		return () => {
			window.clearTimeout(timeoutId);
		};
	});

	$effect(() => {
		if (!isSignedIn || activeTab !== 'pulse') {
			return;
		}

		const location = weatherTargetLocation;
		const locationKey = weatherLocationKey;

		void locationKey;

		const timeoutId = window.setTimeout(() => {
			void loadWeather(location);
		}, 120);

		return () => {
			window.clearTimeout(timeoutId);
		};
	});

	$effect(() => {
		if (!navigator.geolocation) {
			currentLocation = PHNOM_PENH_CENTER;
			return;
		}

		const watchId = navigator.geolocation.watchPosition(
			(position) => {
				currentLocation = {
					lat: position.coords.latitude,
					lng: position.coords.longitude
				};
			},
			() => {
				currentLocation ??= PHNOM_PENH_CENTER;
			},
			{
				enableHighAccuracy: true,
				maximumAge: 1_500,
				timeout: 10_000
			}
		);

		return () => {
			navigator.geolocation.clearWatch(watchId);
		};
	});

	$effect(() => {
		if (tripStatus !== 'tracking' || !currentLocation || !activeTrip) return;
		if (!isNearDestination(currentLocation, activeTrip.destination, 100)) return;

		void markArrived();
	});

	$effect(() => {
		if (activeTab === 'account' && !accountDrawerExpanded) {
			accountDrawerExpanded = true;
		}
	});

	$effect(() => {
		if (activeTab !== 'route') {
			mobileRouteSheetState = 'peek';
			return;
		}

		if (tripStatus === 'tracking') {
			mobileRouteSheetState = 'peek';
			return;
		}

		if (searchLoading || searchResults.length > 0 || routeError) {
			mobileRouteSheetState = 'full';
		}
	});

	onDestroy(() => {
		stopTripSampling();
	});
</script>

{#if !isSignedIn}
	<div class="min-h-[100svh] bg-[#f7f7f4]">
		<div class="mx-auto flex min-h-[100svh] max-w-md items-center justify-center px-4 py-8 sm:px-6">
			<div
				class="w-full border border-black/8 bg-white p-8 shadow-[0_24px_64px_rgba(17,17,17,0.08)]"
			>
				<p class="text-[2rem] leading-tight font-semibold tracking-[-0.03em] text-[#111111]">
					Entering demo
				</p>
				{#if clerkContext.guestBootstrapFailed}
					<p class="mt-3 text-base leading-7 text-[#8a2f1a]">
						{clerkContext.guestBootstrapFailed}
					</p>
				{:else}
					<p class="mt-3 text-base leading-7 text-[#5f5f5f]">
						Starting an anonymous guest session for this app demo.
					</p>
				{/if}
			</div>
		</div>
	</div>
{:else}
	<div class="relative h-[100svh] overflow-hidden bg-[var(--canvas)] text-[var(--text)]">
		<div class="absolute inset-0">
			{#if activeTab === 'account'}
				<div
					class="h-full w-full bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.98),_rgba(244,247,251,0.95)_32%,_rgba(232,238,244,0.92)_62%,_rgba(221,229,237,0.88)_100%)]"
				>
					<div
						class="absolute inset-0 bg-[linear-gradient(135deg,rgba(30,136,247,0.08),transparent_28%,rgba(127,199,174,0.14)_72%,rgba(255,255,255,0.18))]"
					></div>
					<div
						class="absolute top-[12%] left-[10%] h-40 w-40 rounded-full bg-white/55 blur-3xl"
					></div>
					<div
						class="absolute right-[8%] bottom-[18%] h-56 w-56 rounded-full bg-[#dbe8f6]/70 blur-3xl"
					></div>
				</div>
			{:else}
				<MapSurface
					{currentLocation}
					{incidents}
					routes={mapRoutes}
					trackedRoute={mapTrackedRoute}
					destination={mapDestination}
					destinationLabel={mapDestinationLabel}
					destinationTone={mapDestinationTone}
					destinationMoveHint={mapDestinationMoveHint}
					liveNavigation={activeTab === 'route' && tripStatus === 'tracking'}
					followUser={false}
					activeRouteStyle={mapActiveRouteStyle}
					activeRouteId={mapActiveRouteId}
					focusPoints={mapFocusPoints}
					fullscreen={true}
					showHeader={false}
					onRouteSelect={selectRoute}
					onDestinationPick={mapDestinationPicker}
				/>
			{/if}
		</div>

		<div class="pointer-events-none absolute inset-x-0 top-0 z-20 p-3 sm:px-2 sm:py-3">
			<div class="mx-auto flex max-w-[1440px] items-start justify-end gap-3 sm:mx-0 sm:max-w-none">
				<div
					class={`pointer-events-auto flex items-center gap-2 ${
						activeTab === 'route' && showRouteHud && tripStatus !== 'tracking'
							? 'hidden sm:flex'
							: ''
					}`}
				>
					<div
						class="rounded-full border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[var(--shadow-panel)] sm:[&_button]:scale-110 sm:[&_button]:transform-gpu sm:[&_button]:transition-transform"
						{@attach (element) => {
							clerkContext.clerk.mountUserButton(element);
						}}
					></div>
				</div>
			</div>
		</div>

		{#if routeSearchVisible}
			<div
				class="pointer-events-none absolute inset-x-0 top-0 z-24 px-3 pt-[calc(env(safe-area-inset-top,0px)+12px)] sm:px-2 sm:pt-3"
			>
				<div class="mx-auto flex max-w-[1440px] justify-center sm:mx-0 sm:justify-start">
					<div class="pointer-events-auto w-full max-w-[520px]">
						<div
							class="overflow-hidden rounded-[28px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-float)]"
						>
							<form
								class="flex items-center gap-3 px-4 py-3"
								onsubmit={(event) => {
									event.preventDefault();
									void submitPlaceSearch();
								}}
							>
								<div
									class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--muted)]"
								>
									<svg
										viewBox="0 0 24 24"
										class="h-5 w-5"
										fill="none"
										stroke="currentColor"
										stroke-width="2.2"
										stroke-linecap="round"
										stroke-linejoin="round"
									>
										<circle cx="11" cy="11" r="7" />
										<path d="m20 20-3.5-3.5" />
									</svg>
								</div>

								<div class="min-w-0 flex-1">
									<p class="text-[10px] tracking-[0.24em] text-[var(--muted)] uppercase">
										Search destination
									</p>
									<input
										type="text"
										value={searchQuery}
										oninput={handleSearchInput}
										onkeydown={handleSearchKeydown}
										placeholder="Place, address, campus, or lat,lng"
										autocomplete="off"
										spellcheck="false"
										class="mt-1 w-full bg-transparent text-[15px] font-medium text-[var(--text)] placeholder:text-black/34 focus:outline-none"
									/>
								</div>

								{#if searchQuery}
									<button
										type="button"
										onclick={resetDestinationSearch}
										class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:bg-[var(--primary-soft)]"
										aria-label="Clear search"
										title="Clear search"
									>
										<svg
											viewBox="0 0 24 24"
											class="h-5 w-5"
											fill="none"
											stroke="currentColor"
											stroke-width="2.2"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<path d="M18 6 6 18" />
											<path d="m6 6 12 12" />
										</svg>
									</button>
								{/if}

								<button
									type="submit"
									disabled={searchQuery.trim().length < 2}
									class="rounded-full bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50"
								>
									Route
								</button>
							</form>

							{#if searchLoading || searchResults.length > 0 || searchError}
								<div class="border-t border-[var(--border)] px-3 py-3">
									{#if searchLoading}
										<div
											class="rounded-[20px] bg-[var(--surface-muted)] px-4 py-3 text-sm text-[var(--muted)]"
										>
											Searching nearby places...
										</div>
									{:else if searchResults.length > 0}
										<div class="space-y-2">
											{#each searchResults as result (result.id)}
												<button
													type="button"
													onclick={() => selectSearchResult(result)}
													class="block w-full rounded-[20px] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left transition hover:bg-[var(--primary-soft)]"
												>
													<div class="flex items-start justify-between gap-3">
														<div class="min-w-0">
															<p class="truncate text-sm font-medium text-[var(--text)]">
																{result.label}
															</p>
															<p class="mt-1 line-clamp-2 text-xs leading-5 text-[var(--muted)]">
																{result.detail}
															</p>
														</div>
														<span
															class="shrink-0 rounded-full bg-[var(--primary-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text)]"
														>
															Route
														</span>
													</div>
												</button>
											{/each}
										</div>
									{:else if searchError}
										<div
											class="rounded-[20px] border border-[var(--danger)]/20 bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]"
										>
											{searchError}
										</div>
									{/if}
								</div>
							{/if}
						</div>
					</div>
				</div>
			</div>
		{/if}

		{#if activeTab === 'route'}
			<div class="pointer-events-none absolute inset-0 z-26">
				<div class="hidden h-full p-4 sm:block">
					<aside
						class="pointer-events-auto flex h-full w-[min(410px,calc(100vw-2rem))] flex-col overflow-hidden rounded-[26px] border border-black/10 bg-white text-[#202124] shadow-[0_22px_56px_rgba(32,33,36,0.18)]"
					>
						<div class="border-b border-[#e5e7eb] px-7 py-5">
							<div class="flex items-center gap-5">
								<button
									type="button"
									onclick={clearRoutePlan}
									class="flex h-12 w-12 items-center justify-center rounded-full text-[#3c4043] transition hover:bg-[#f1f3f4]"
									aria-label="Clear route planner"
								>
									<svg
										viewBox="0 0 24 24"
										class="h-7 w-7"
										fill="none"
										stroke="currentColor"
										stroke-width="2.2"
										stroke-linecap="round"
										stroke-linejoin="round"
									>
										<path d="M4 7h16" />
										<path d="M4 12h16" />
										<path d="M4 17h16" />
									</svg>
								</button>
								<h2
									class="text-[1.35rem] leading-none font-semibold tracking-[-0.03em] text-[#202124]"
								>
									Driving directions
								</h2>
							</div>

							<div class="mt-6 flex items-start gap-4">
								<div class="flex shrink-0 flex-col items-center pt-2">
									<span
										class="flex h-7 w-7 items-center justify-center rounded-full border-[3px] border-[#1a73e8] bg-white"
									>
										<span class="h-2.5 w-2.5 rounded-full bg-[#1a73e8]"></span>
									</span>
									<span class="my-2 h-9 w-[3px] rounded-full bg-[#cbd5e1]"></span>
									<span
										class="relative flex h-7 w-7 items-center justify-center rounded-full bg-[#ea4335]"
									>
										<span class="h-2.5 w-2.5 rounded-full bg-white"></span>
										<span class="absolute top-[22px] h-3.5 w-2.5 rounded-b-full bg-[#ea4335]"
										></span>
									</span>
								</div>

								<div class="min-w-0 flex-1 space-y-4">
									<div class="rounded-[14px] bg-[#f1f3f4] px-5 py-3.5">
										<p class="truncate text-[0.85rem] font-medium text-[#202124]">
											{routePanelOriginLabel}
										</p>
										<p class="mt-1 truncate text-[0.72rem] text-[#5f6368]">
											{routePanelOriginDetail}
										</p>
									</div>

									<form
										class="rounded-[14px] bg-[#f1f3f4] px-5 py-3.5"
										onsubmit={(event) => {
											event.preventDefault();
											void submitPlaceSearch();
										}}
									>
										<input
											type="text"
											value={searchQuery}
											oninput={handleSearchInput}
											onkeydown={handleSearchKeydown}
											placeholder="Choose destination"
											autocomplete="off"
											spellcheck="false"
											class="w-full bg-transparent text-[0.85rem] font-medium text-[#202124] placeholder:text-[#5f6368] focus:outline-none"
										/>
										<p class="mt-1 truncate text-[0.72rem] text-[#5f6368]">
											{routeDestination
												? currentRouteDestinationDetail
												: 'Place, address, or campus'}
										</p>
									</form>
								</div>

								<div class="flex shrink-0 flex-col items-center gap-2 pt-3 text-[#5f6368]">
									<button
										type="button"
										onclick={() => void planRoute()}
										disabled={!routeDestination || routeLoading}
										class="flex h-10 w-10 items-center justify-center rounded-full transition hover:bg-[#f1f3f4] disabled:opacity-40"
										aria-label="Refresh routes"
									>
										<svg
											viewBox="0 0 24 24"
											class="h-5 w-5"
											fill="none"
											stroke="currentColor"
											stroke-width="2.2"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<path d="M12 5v14" />
											<path d="m7 10 5-5 5 5" />
										</svg>
									</button>
									<button
										type="button"
										onclick={clearRoutePlan}
										class="flex h-10 w-10 items-center justify-center rounded-full transition hover:bg-[#f1f3f4]"
										aria-label="Clear route"
									>
										<svg
											viewBox="0 0 24 24"
											class="h-5 w-5"
											fill="none"
											stroke="currentColor"
											stroke-width="2.2"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<path d="M12 19V5" />
											<path d="m7 14 5 5 5-5" />
										</svg>
									</button>
								</div>
							</div>

							<div
								class="mt-4 flex items-center justify-between gap-3 border-t border-[#e5e7eb] pt-4"
							>
								<div class="flex items-center gap-3 text-[#3c4043]">
									<svg
										viewBox="0 0 24 24"
										class="h-7 w-7"
										fill="none"
										stroke="currentColor"
										stroke-width="2.2"
										stroke-linecap="round"
										stroke-linejoin="round"
									>
										<circle cx="12" cy="12" r="9" />
										<path d="M12 7v5l3 3" />
									</svg>
									<span class="text-[0.8rem] font-medium">Leave now</span>
								</div>
								<div class="flex items-center gap-2">
									{#if navigationRoute}
										<span
											class={`rounded-full px-3 py-1.5 text-[11px] font-semibold ${getTrafficBadgeClass(navigationRoute.trafficLevel)}`}
										>
											{getTrafficLabel(navigationRoute.trafficLevel)}
										</span>
									{/if}
									{#if selectedRoute}
										<span class="text-[0.75rem] text-[#5f6368]">
											{formatMinutes(selectedRoute.durationSec)} • {nextArrivalLabel}
										</span>
									{/if}
								</div>
								{#if tripStatus === 'tracking'}
									<button
										type="button"
										onclick={markArrived}
										disabled={tripBusy !== null}
										class="rounded-full bg-[#1a73e8] px-8 py-3 text-[0.95rem] font-semibold text-white shadow-[0_12px_24px_rgba(26,115,232,0.28)] disabled:opacity-50"
									>
										{tripBusy === 'arriving' ? 'Saving...' : 'Arrived'}
									</button>
								{:else}
									<button
										type="button"
										onclick={beginTrip}
										disabled={!selectedRoute || tripBusy !== null}
										class="rounded-full bg-[#1a73e8] px-8 py-3 text-[0.95rem] font-semibold text-white shadow-[0_12px_24px_rgba(26,115,232,0.28)] disabled:opacity-50"
									>
										{tripBusy === 'starting' ? 'Starting...' : 'Start trip'}
									</button>
								{/if}
							</div>
						</div>

						<div class="min-h-0 flex-1 overflow-hidden bg-[#f8f9fa]">
							<div class="border-b border-[#e5e7eb] bg-white px-7 py-4">
								<div class="flex items-center justify-between gap-3">
									<p class="text-[0.85rem] font-medium text-[#3c4043]">Routes</p>
									{#if routeOptions.length > 0}
										<p class="text-[0.75rem] text-[#5f6368]">
											{routeOptions.length} option{routeOptions.length === 1 ? '' : 's'}
										</p>
									{/if}
								</div>
							</div>

							<div class="space-y-3 px-2 py-3">
								{#if routeError}
									<div class="px-4">
										<div
											class="rounded-[18px] border border-[#f6c7c1] bg-[#fef1ef] px-4 py-3 text-sm text-[#b3261e]"
										>
											{routeError}
										</div>
									</div>
								{/if}

								{#if tripError}
									<div class="px-4">
										<div
											class="rounded-[18px] border border-[#f6c7c1] bg-[#fef1ef] px-4 py-3 text-sm text-[#b3261e]"
										>
											{tripError}
										</div>
									</div>
								{/if}

								{#if tripMessage}
									<div class="px-4">
										<div
											class="rounded-[18px] border border-[#c7dafc] bg-[#eef4ff] px-4 py-3 text-sm text-[#174ea6]"
										>
											{tripMessage}
										</div>
									</div>
								{/if}

								{#if searchLoading || searchResults.length > 0 || searchError}
									<div class="space-y-2 px-4">
										{#if searchLoading}
											<div
												class="rounded-[18px] bg-white px-4 py-3 text-sm text-[#5f6368] shadow-[0_1px_3px_rgba(32,33,36,0.1)]"
											>
												Searching nearby places...
											</div>
										{:else if searchError}
											<div
												class="rounded-[18px] border border-[#f6c7c1] bg-[#fef1ef] px-4 py-3 text-sm text-[#b3261e]"
											>
												{searchError}
											</div>
										{:else}
											{#each searchResults as result (result.id)}
												<button
													type="button"
													onclick={() => selectSearchResult(result)}
													class="block w-full rounded-[18px] bg-white px-4 py-3 text-left shadow-[0_1px_3px_rgba(32,33,36,0.1)] transition hover:bg-[#f8fbff]"
												>
													<p class="truncate text-[0.98rem] font-medium text-[#202124]">
														{result.label}
													</p>
													<p class="mt-1 line-clamp-2 text-sm text-[#5f6368]">
														{result.detail}
													</p>
												</button>
											{/each}
										{/if}
									</div>
								{/if}

								{#if routeLoading}
									<div class="px-4">
										<div
											class="rounded-[22px] bg-white px-5 py-4 text-sm text-[#5f6368] shadow-[0_1px_3px_rgba(32,33,36,0.1)]"
										>
											Loading traffic-aware routes for {routeDestination?.label ??
												'your destination'}.
										</div>
									</div>
								{:else if routeOptions.length === 0}
									<div class="px-4">
										<div
											class="rounded-[22px] bg-white px-5 py-4 text-sm text-[#5f6368] shadow-[0_1px_3px_rgba(32,33,36,0.1)]"
										>
											Search for a destination to compare route options.
										</div>
									</div>
								{:else}
									<div class="space-y-3 overflow-y-auto px-2 pb-3">
										{#each routeOptions.slice(0, 3) as route, index (route.routeId)}
											<button
												type="button"
												onclick={() => selectRoute(route.routeId)}
												class={`mx-4 block rounded-[20px] border-l-[5px] bg-white px-5 py-4 text-left shadow-[0_1px_3px_rgba(32,33,36,0.1)] transition ${
													selectedRouteId === route.routeId
														? 'border-l-[#1a73e8] ring-2 ring-[#1a73e8]/10'
														: 'border-l-transparent hover:bg-[#fbfdff]'
												}`}
											>
												<div class="flex items-start gap-4">
													<div
														class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1a73e8] text-sm font-semibold text-white"
													>
														{index + 1}
													</div>
													<div class="min-w-0 flex-1">
														<div class="flex items-center gap-3">
															<p
																class="text-[1.25rem] leading-none font-semibold tracking-[-0.04em] text-[#202124]"
															>
																{formatMinutes(route.durationSec)}
															</p>
															<p class="text-[0.85rem] font-medium text-[#202124]">
																Arrive at {formatArrivalTime(route.arrivalTime)}
															</p>
															{#if index === 0}
																<span
																	class="rounded-[8px] bg-[#1a73e8] px-2.5 py-1 text-[11px] font-semibold text-white"
																>
																	BEST
																</span>
															{/if}
														</div>
														<p class="mt-2 text-[0.82rem] leading-6 text-[#3c4043]">
															{route.label}; {route.trafficSummary}
														</p>
														<p class="mt-1 text-[0.78rem] text-[#5f6368]">
															{formatDistance(route.distanceMeters)} KM
														</p>
													</div>
												</div>
											</button>
										{/each}
									</div>
								{/if}
							</div>
						</div>
					</aside>
				</div>

				<div class="sm:hidden">
					<div class="pointer-events-none absolute inset-x-0 bottom-[86px] px-3">
						<div
							class="pointer-events-auto overflow-hidden rounded-[28px] border border-black/8 bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-float)]"
						>
							<div class="px-4 pt-2.5 pb-2.5">
								<button
									type="button"
									onpointerdown={handleMobileRouteSheetPointerDown}
									onpointerup={handleMobileRouteSheetPointerUp}
									class="mx-auto flex w-20 items-center justify-center py-1"
									aria-label={mobileRouteSheetState === 'peek'
										? 'Expand route sheet'
										: 'Collapse route sheet'}
								>
									<span class="h-1 w-12 rounded-full bg-[#d7dce1]"></span>
								</button>

								<div class="mt-2 flex items-center justify-between gap-2">
									<div class="min-w-0">
										<p class="truncate text-[0.82rem] font-semibold text-[var(--text)]">
											{currentRouteDestinationLabel}
										</p>
										<p class="mt-0.5 text-[0.66rem] text-[var(--muted)]">
											{mobileRouteSheetPreviewLabel}
										</p>
									</div>
									<div class="flex shrink-0 items-center gap-1">
										{#if navigationRoute}
											<span
												class={`rounded-full px-2 py-1 text-[9px] font-semibold ${getTrafficBadgeClass(navigationRoute.trafficLevel)}`}
											>
												{getTrafficLabel(navigationRoute.trafficLevel)}
											</span>
										{/if}
									</div>
								</div>

								{#if mobileRouteSheetState === 'full'}
									<form
										class="mt-2.5 rounded-[22px] bg-[#f3f4f6] px-3 py-2.5"
										onsubmit={(event) => {
											event.preventDefault();
											void submitPlaceSearch();
										}}
									>
										<div class="flex items-start gap-2.5">
											<div class="mt-0.5 flex shrink-0 flex-col items-center">
												<span class="h-2 w-2 rounded-full bg-[#1a73e8]"></span>
												<span class="my-1 h-4 w-[2px] rounded-full bg-[#cbd5e1]"></span>
												<span class="h-2 w-2 rounded-full bg-[#ea4335]"></span>
											</div>
											<div class="min-w-0 flex-1 space-y-2">
												<div>
													<p class="truncate text-[0.74rem] font-medium text-[var(--text)]">
														{routePanelOriginLabel}
													</p>
													<p class="mt-0.5 truncate text-[0.62rem] text-[var(--muted)]">
														{routePanelOriginDetail}
													</p>
												</div>
												<div class="h-px bg-[#d9dde3]"></div>
												<div>
													<input
														type="text"
														value={searchQuery}
														oninput={handleSearchInput}
														onkeydown={handleSearchKeydown}
														placeholder="Choose destination"
														autocomplete="off"
														spellcheck="false"
														class="w-full bg-transparent text-[0.74rem] font-medium text-[var(--text)] placeholder:text-[var(--muted)] focus:outline-none"
													/>
													<p class="mt-0.5 truncate text-[0.62rem] text-[var(--muted)]">
														{routeDestination
															? currentRouteDestinationDetail
															: 'Place, address, or campus'}
													</p>
												</div>
											</div>
										</div>
									</form>

									<div class="mt-2.5 flex items-center justify-between gap-2">
										<div class="flex min-w-0 items-center gap-2">
											<span
												class="rounded-full bg-[#f3f4f6] px-2.5 py-1 text-[0.68rem] font-medium text-[var(--muted)]"
											>
												Leave now
											</span>
											{#if selectedRoute}
												<span class="truncate text-[0.7rem] text-[var(--muted)]">
													{formatDistance(selectedRoute.distanceMeters)} • {nextArrivalLabel}
												</span>
											{/if}
										</div>
										<button
											type="button"
											onclick={() => void planRoute()}
											disabled={!routeDestination || routeLoading}
											class="rounded-[18px] border border-black/8 bg-white px-3 py-1.5 text-[0.68rem] font-medium text-[var(--muted)] disabled:opacity-40"
										>
											Refresh
										</button>
									</div>
								{:else}
									<div class="mt-2.5 grid grid-cols-2 gap-2">
										{#if tripStatus === 'tracking'}
											<button
												type="button"
												onclick={() => setMobileRouteSheetState('full')}
												class="rounded-[22px] border border-black/8 bg-white px-4 py-2.5 text-[0.82rem] font-semibold text-[var(--muted)]"
											>
												Report
											</button>
											<button
												type="button"
												onclick={markArrived}
												disabled={tripBusy !== null}
												class="rounded-[16px] bg-[#1a73e8] px-4 py-2.5 text-[0.82rem] font-semibold text-white disabled:opacity-50"
											>
												{tripBusy === 'arriving' ? 'Saving...' : 'Arrived'}
											</button>
										{:else}
											<button
												type="button"
												onclick={beginTrip}
												disabled={!selectedRoute || tripBusy !== null}
												class="rounded-[16px] bg-[#1a73e8] px-4 py-2.5 text-[0.82rem] font-semibold text-white disabled:opacity-50"
											>
												{tripBusy === 'starting' ? 'Starting...' : 'Start trip'}
											</button>
											<button
												type="button"
												onclick={() => setMobileRouteSheetState('full')}
												class="rounded-[22px] border border-black/8 bg-white px-4 py-2.5 text-[0.82rem] font-semibold text-[var(--muted)]"
											>
												Details
											</button>
										{/if}
									</div>
								{/if}
							</div>

							{#if mobileRouteSheetState === 'full'}
								<div class="border-t border-black/8 bg-[#f8f9fa] px-3 pt-2.5 pb-2.5">
									{#if searchLoading || searchResults.length > 0 || searchError}
										<div class="mb-2.5 space-y-2">
											{#if searchLoading}
												<div
													class="rounded-[22px] bg-white px-3.5 py-3 text-[0.72rem] text-[var(--muted)]"
												>
													Searching nearby places...
												</div>
											{:else if searchError}
												<div
													class="rounded-[22px] border border-[#f6c7c1] bg-[#fef1ef] px-3.5 py-3 text-[0.72rem] text-[#b3261e]"
												>
													{searchError}
												</div>
											{:else}
												{#each searchResults.slice(0, 3) as result (result.id)}
													<button
														type="button"
														onclick={() => selectSearchResult(result)}
														class="block w-full rounded-[22px] bg-white px-3.5 py-3 text-left"
													>
														<p class="truncate text-[0.78rem] font-medium text-[var(--text)]">
															{result.label}
														</p>
														<p class="mt-1 line-clamp-2 text-[0.68rem] text-[var(--muted)]">
															{result.detail}
														</p>
													</button>
												{/each}
											{/if}
										</div>
									{/if}

									{#if routeError}
										<div
											class="mb-2.5 rounded-[22px] border border-[#f6c7c1] bg-[#fef1ef] px-3.5 py-3 text-[0.72rem] text-[#b3261e]"
										>
											{routeError}
										</div>
									{/if}

									{#if routeLoading}
										<div
											class="rounded-[22px] bg-white px-3.5 py-3 text-[0.72rem] text-[var(--muted)]"
										>
											Loading traffic-aware routes...
										</div>
									{:else if routeOptions.length === 0}
										<div
											class="rounded-[22px] bg-white px-3.5 py-3 text-[0.72rem] text-[var(--muted)]"
										>
											Search for a destination to compare route options.
										</div>
									{:else}
										<div class="space-y-2">
											{#each routeOptions.slice(0, 1) as route, index (route.routeId)}
												<button
													type="button"
													onclick={() => selectRoute(route.routeId)}
													class={`block w-full rounded-[18px] border bg-white px-3 py-2.5 text-left ${
														selectedRouteId === route.routeId
															? 'border-[#9ac5ff] shadow-[0_0_0_2px_rgba(26,115,232,0.08)]'
															: 'border-transparent'
													}`}
												>
													<div class="flex items-start justify-between gap-3">
														<div class="min-w-0">
															<div class="flex items-center gap-2">
																<div
																	class="flex h-6.5 w-6.5 items-center justify-center rounded-full bg-[#1a73e8] text-[0.68rem] font-semibold text-white"
																>
																	{index + 1}
																</div>
																<p
																	class="text-[0.9rem] font-semibold tracking-[-0.03em] text-[var(--text)]"
																>
																	{formatMinutes(route.durationSec)}
																</p>
																{#if index === 0}
																	<span
																		class="rounded-[7px] bg-[#1a73e8] px-2 py-0.5 text-[9px] font-semibold text-white"
																	>
																		BEST
																	</span>
																{/if}
															</div>
															<p
																class="mt-1.5 truncate text-[0.7rem] font-medium text-[var(--text)]"
															>
																{route.label}
															</p>
															<p class="mt-0.5 text-[0.62rem] text-[var(--muted)]">
																Arrive {formatArrivalTime(route.arrivalTime)} • {formatDistance(
																	route.distanceMeters
																)}
															</p>
														</div>
														{#if selectedRouteId === route.routeId}
															<span
																class="rounded-full bg-[#eef4ff] px-2 py-1 text-[9px] font-semibold text-[#1a73e8]"
															>
																Selected
															</span>
														{/if}
													</div>
												</button>
											{/each}
										</div>
									{/if}

									<div class="mt-2.5 grid grid-cols-2 gap-2">
										<button
											type="button"
											onclick={beginTrip}
											disabled={!selectedRoute || tripBusy !== null}
											class="rounded-[16px] bg-[#1a73e8] px-4 py-2.5 text-[0.82rem] font-semibold text-white disabled:opacity-50"
										>
											{tripBusy === 'starting' ? 'Starting...' : 'Start trip'}
										</button>
										<button
											type="button"
											onclick={markArrived}
											disabled={tripStatus !== 'tracking' || tripBusy !== null}
											class="rounded-[22px] border border-black/8 bg-white px-4 py-2.5 text-[0.82rem] font-semibold text-[var(--muted)] disabled:opacity-50"
										>
											{tripBusy === 'arriving' ? 'Saving...' : 'Arrived'}
										</button>
									</div>
								</div>
							{/if}
						</div>
					</div>
				</div>
			</div>
		{/if}

		{#if activeTab === 'route' && showRouteHud && false}
			<div
				class={`pointer-events-none absolute inset-x-0 z-25 px-2 sm:px-2 ${
					tripStatus === 'tracking'
						? 'top-3 bottom-3 sm:top-4 sm:bottom-4'
						: 'top-0 bottom-0 sm:top-2 sm:bottom-[106px]'
				}`}
			>
				<div class="flex h-full w-full flex-col justify-between gap-3">
					{#if tripStatus === 'tracking'}
						<div
							class="flex h-full flex-col justify-between px-3 pt-[calc(env(safe-area-inset-top,0px)+8px)] pb-3 sm:hidden"
						>
							<div
								class="pointer-events-auto rounded-[24px] border border-[var(--border)] bg-[var(--surface)] px-3 py-3 text-[var(--text)] shadow-[var(--shadow-panel)]"
							>
								<div class="flex items-center gap-3">
									<div
										class="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
									>
										{#if currentCueModifier === 'left' || currentCueModifier === 'slight left' || currentCueModifier === 'sharp left'}
											<svg
												viewBox="0 0 24 24"
												class="h-7 w-7"
												fill="none"
												stroke="currentColor"
												stroke-width="2.4"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<path d="M19 5H10a5 5 0 0 0-5 5v9" />
												<path d="m9 5-4 4 4 4" />
											</svg>
										{:else if currentCueModifier === 'right' || currentCueModifier === 'slight right' || currentCueModifier === 'sharp right'}
											<svg
												viewBox="0 0 24 24"
												class="h-7 w-7"
												fill="none"
												stroke="currentColor"
												stroke-width="2.4"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<path d="M5 5h9a5 5 0 0 1 5 5v9" />
												<path d="m15 5 4 4-4 4" />
											</svg>
										{:else if currentCueModifier === 'uturn'}
											<svg
												viewBox="0 0 24 24"
												class="h-7 w-7"
												fill="none"
												stroke="currentColor"
												stroke-width="2.4"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<path d="M18 19H9a4 4 0 0 1-4-4V5" />
												<path d="m9 19-4-4 4-4" />
											</svg>
										{:else if currentCueModifier === 'arrive'}
											<svg
												viewBox="0 0 24 24"
												class="h-7 w-7"
												fill="none"
												stroke="currentColor"
												stroke-width="2.2"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<path d="M12 21s6-4.35 6-10a6 6 0 1 0-12 0c0 5.65 6 10 6 10Z" />
												<circle cx="12" cy="11" r="2.5" />
											</svg>
										{:else}
											<svg
												viewBox="0 0 24 24"
												class="h-7 w-7"
												fill="none"
												stroke="currentColor"
												stroke-width="2.4"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<path d="M12 19V5" />
												<path d="m7 10 5-5 5 5" />
											</svg>
										{/if}
									</div>

									<div class="min-w-0 flex-1">
										<div class="flex items-start justify-between gap-2">
											<div class="min-w-0">
												<p
													class="text-[2rem] leading-none font-semibold tracking-[-0.07em] text-[#121212]"
												>
													{navigationRoute ? nextCueDistanceLabel : '--'}
												</p>
												<p
													class="mt-1 truncate text-[15px] font-semibold tracking-[-0.03em] text-[var(--text)]"
												>
													{navigationRoadLabel}
												</p>
											</div>

											<div class="shrink-0 space-y-1.5 text-right">
												<span
													class={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${
														navigationRoute
															? getTrafficBadgeClass(navigationRoute.trafficLevel)
															: 'bg-[var(--surface-muted)] text-[var(--muted)]'
													}`}
												>
													{navigationRoute ? getTrafficLabel(navigationRoute.trafficLevel) : 'Live'}
												</span>
												<p class="text-[12px] font-medium text-[var(--muted)]">
													{nextArrivalLabel}
												</p>
											</div>
										</div>
										<div class="mt-2 flex items-center gap-2 text-[12px] text-[var(--muted)]">
											<span
												>{navigationRoute ? formatMinutes(navigationRoute.durationSec) : '--'}</span
											>
											<span class="h-1 w-1 rounded-full bg-black/24"></span>
											<span class="truncate">{navigationInstruction}</span>
										</div>
									</div>
								</div>
							</div>

							<div
								class="pointer-events-auto rounded-[24px] border border-[var(--border)] bg-[var(--surface)] px-4 pt-2.5 pb-[calc(env(safe-area-inset-bottom,0px)+10px)] text-[var(--text)] shadow-[var(--shadow-panel)]"
							>
								<div class="mx-auto h-1.5 w-12 rounded-full bg-black/10"></div>

								<div class="mt-3 flex items-center justify-between gap-3">
									<div class="min-w-0">
										<p
											class="truncate text-[1.05rem] leading-none font-semibold tracking-[-0.04em] text-[var(--text)]"
										>
											{currentRouteDestinationLabel}
										</p>
										<p class="mt-1 text-[13px] leading-5 text-[var(--muted)]">
											{routeDistanceLabel}
										</p>
									</div>
								</div>

								{#if tripError}
									<div
										class="mt-3 rounded-[16px] border border-[var(--danger)]/20 bg-[var(--danger-soft)] px-3 py-2.5 text-sm text-[var(--danger)]"
									>
										{tripError}
									</div>
								{/if}

								{#if reportError}
									<div
										class="mt-3 rounded-[16px] border border-[#f1b7a4] bg-[#fff0eb] px-3 py-2 text-xs font-medium text-[#7d2c1d]"
									>
										{reportError}
									</div>
								{/if}

								{#if reportFeedback}
									<div
										class="mt-3 rounded-[16px] border border-[#b7e6d4] bg-[#eefbf5] px-3 py-2 text-xs font-medium text-[#155544]"
									>
										{reportFeedback}
									</div>
								{/if}

								<div
									class="mt-3 rounded-[18px] border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-2.5"
								>
									<div class="flex items-center justify-between gap-3">
										<div class="min-w-0">
											<p class="text-[10px] tracking-[0.24em] text-[var(--muted)] uppercase">
												Report
											</p>
										</div>
										<span
											class="shrink-0 rounded-full border border-[var(--border)] bg-white px-2.5 py-1 text-[10px] font-medium text-[var(--muted)]"
										>
											Live GPS
										</span>
									</div>

									<div class="mt-2 grid grid-cols-3 gap-1.5">
										{#each INCIDENT_TYPES as incidentType (incidentType)}
											<button
												type="button"
												onclick={() => void submitIncident(incidentType)}
												disabled={reportSubmitting}
												class={`rounded-[14px] border px-1.5 py-2 text-center transition ${
													selectedType === incidentType
														? 'border-[#1e88f7] bg-[#eef6ff] shadow-[0_10px_24px_rgba(30,136,247,0.12)]'
														: 'border-[var(--border)] bg-white'
												} disabled:opacity-50`}
											>
												<div class="flex flex-col items-center gap-1">
													<div
														class={`flex h-8 w-8 items-center justify-center rounded-[10px] ${
															selectedType === incidentType
																? 'bg-white'
																: 'bg-[var(--surface-muted)]'
														}`}
													>
														<IncidentTypeIcon type={incidentType} class="h-4 w-4 shrink-0" />
													</div>
													<span class="text-[9px] leading-3 font-semibold text-[var(--text)]">
														{REPORT_TYPE_LABELS[incidentType]}
													</span>
												</div>
											</button>
										{/each}
									</div>
								</div>

								<button
									type="button"
									onclick={markArrived}
									disabled={tripStatus !== 'tracking' || tripBusy !== null}
									class="mt-3 w-full rounded-[20px] bg-[var(--primary)] px-4 py-3 text-base font-semibold text-white shadow-[0_14px_30px_rgba(30,136,247,0.22)] hover:bg-[var(--primary-strong)] disabled:bg-[var(--surface-muted)] disabled:text-[var(--muted)] disabled:shadow-none"
								>
									{tripBusy === 'arriving' ? 'Saving arrival...' : 'Mark arrived'}
								</button>
							</div>
						</div>

						<div
							class="hidden h-full flex-col justify-between px-3 pt-[calc(env(safe-area-inset-top,0px)+10px)] pb-[calc(env(safe-area-inset-bottom,0px)+12px)] sm:flex lg:px-5 xl:px-6"
						>
							<div class="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_280px]">
								<div
									class="pointer-events-auto flex min-w-0 items-start gap-3 rounded-[24px] border border-[var(--border)] bg-[var(--surface)] px-4 py-4 text-[var(--text)] shadow-[var(--shadow-float)]"
								>
									<div
										class="flex h-16 w-16 shrink-0 items-center justify-center rounded-[20px] bg-[var(--surface-muted)] text-[var(--text)]"
									>
										{#if currentCueModifier === 'left' || currentCueModifier === 'slight left' || currentCueModifier === 'sharp left'}
											<svg
												viewBox="0 0 24 24"
												class="h-9 w-9"
												fill="none"
												stroke="currentColor"
												stroke-width="2.4"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<path d="M19 5H10a5 5 0 0 0-5 5v9" />
												<path d="m9 5-4 4 4 4" />
											</svg>
										{:else if currentCueModifier === 'right' || currentCueModifier === 'slight right' || currentCueModifier === 'sharp right'}
											<svg
												viewBox="0 0 24 24"
												class="h-9 w-9"
												fill="none"
												stroke="currentColor"
												stroke-width="2.4"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<path d="M5 5h9a5 5 0 0 1 5 5v9" />
												<path d="m15 5 4 4-4 4" />
											</svg>
										{:else if currentCueModifier === 'uturn'}
											<svg
												viewBox="0 0 24 24"
												class="h-9 w-9"
												fill="none"
												stroke="currentColor"
												stroke-width="2.4"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<path d="M18 19H9a4 4 0 0 1-4-4V5" />
												<path d="m9 19-4-4 4-4" />
											</svg>
										{:else if currentCueModifier === 'arrive'}
											<svg
												viewBox="0 0 24 24"
												class="h-9 w-9"
												fill="none"
												stroke="currentColor"
												stroke-width="2.2"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<path d="M12 21s6-4.35 6-10a6 6 0 1 0-12 0c0 5.65 6 10 6 10Z" />
												<circle cx="12" cy="11" r="2.5" />
											</svg>
										{:else}
											<svg
												viewBox="0 0 24 24"
												class="h-9 w-9"
												fill="none"
												stroke="currentColor"
												stroke-width="2.4"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<path d="M12 19V5" />
												<path d="m7 10 5-5 5 5" />
											</svg>
										{/if}
									</div>

									<div class="min-w-0 flex-1">
										<div class="flex flex-wrap items-start justify-between gap-3">
											<div class="min-w-0">
												<div class="flex flex-wrap items-center gap-3">
													<p
														class="text-3xl font-semibold tracking-[-0.06em] text-[var(--text)] sm:text-4xl lg:text-5xl"
													>
														{navigationRoute ? nextCueDistanceLabel : '--'}
													</p>
													<span
														class={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${
															navigationRoute
																? getTrafficBadgeClass(navigationRoute.trafficLevel)
																: 'bg-[var(--surface-muted)] text-[var(--muted)]'
														}`}
													>
														{navigationRoute
															? getTrafficLabel(navigationRoute.trafficLevel)
															: 'Live'}
													</span>
												</div>
												<p
													class="mt-1.5 truncate text-[1.25rem] font-semibold tracking-[-0.05em] text-[var(--primary)] sm:text-[1.5rem]"
												>
													{navigationRoadLabel}
												</p>
											</div>
										</div>

										<p class="mt-2 max-w-[40rem] text-sm leading-6 text-[var(--muted)]">
											{navigationInstruction}
										</p>
									</div>
								</div>

								<div class="pointer-events-auto grid gap-2.5">
									<div
										class="rounded-[22px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-[var(--text)] shadow-[var(--shadow-panel)]"
									>
										<div class="flex items-center gap-3">
											<div
												class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[14px] bg-[var(--surface-muted)] text-[var(--primary)]"
											>
												<svg
													viewBox="0 0 24 24"
													class="h-5 w-5"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													stroke-linecap="round"
													stroke-linejoin="round"
												>
													<circle cx="12" cy="12" r="8" />
													<path d="M12 8v4l2.5 2.5" />
												</svg>
											</div>
											<div class="min-w-0">
												<p class="text-[10px] tracking-[0.28em] text-[var(--muted)] uppercase">
													ETA
												</p>
												<p class="mt-0.5 text-xl font-semibold text-[var(--text)]">
													{nextArrivalLabel}
												</p>
											</div>
										</div>
									</div>

									<div
										class="rounded-[22px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-[var(--text)] shadow-[var(--shadow-panel)]"
									>
										<div class="flex items-center gap-3">
											<div
												class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[14px] bg-[var(--surface-muted)] text-[var(--primary)]"
											>
												<svg
													viewBox="0 0 24 24"
													class="h-5 w-5"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													stroke-linecap="round"
													stroke-linejoin="round"
												>
													<path d="M4 18h8" />
													<path d="M4 12h16" />
													<path d="M4 6h12" />
													<path d="m14 16 3 3 4-6" />
												</svg>
											</div>
											<div class="min-w-0">
												<p class="text-[10px] tracking-[0.28em] text-[var(--muted)] uppercase">
													Trip
												</p>
												<p class="mt-0.5 text-xl font-semibold text-[var(--text)]">
													{navigationRoute ? formatMinutes(navigationRoute.durationSec) : '--'}
												</p>
											</div>
										</div>
									</div>

									<div
										class="rounded-[22px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-[var(--text)] shadow-[var(--shadow-panel)]"
									>
										<div class="flex items-start gap-3">
											<div
												class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[14px] bg-[var(--surface-muted)] text-[var(--primary)]"
											>
												<svg
													viewBox="0 0 24 24"
													class="h-5 w-5"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													stroke-linecap="round"
													stroke-linejoin="round"
												>
													<path d="M4 7h16" />
													<path d="M7 12h10" />
													<path d="M10 17h4" />
												</svg>
											</div>
											<div class="min-w-0 flex-1">
												<div class="flex items-center justify-between gap-3">
													<p class="text-[10px] tracking-[0.28em] text-[var(--muted)] uppercase">
														Traffic
													</p>
													<span
														class={`rounded-full px-2.5 py-1 text-xs font-semibold ${
															navigationRoute
																? getTrafficBadgeClass(navigationRoute.trafficLevel)
																: 'bg-[var(--surface-muted)] text-[var(--muted)]'
														}`}
													>
														{navigationRoute
															? getTrafficLabel(navigationRoute.trafficLevel)
															: 'Live'}
													</span>
												</div>
												<p class="mt-0.5 text-sm font-semibold text-[var(--text)]">
													{navigationRoute?.trafficSummary ?? 'Live route'}
												</p>
											</div>
										</div>
									</div>
								</div>
							</div>

							<div class="pointer-events-none flex-1"></div>

							<div
								class="grid items-end gap-3 lg:grid-cols-[minmax(0,380px)_minmax(260px,340px)] lg:justify-between"
							>
								<div class="pointer-events-auto space-y-3">
									<div
										class="rounded-[22px] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-[var(--text)] shadow-[var(--shadow-float)]"
									>
										<div class="flex items-start gap-3">
											<div
												class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[14px] bg-[var(--surface-muted)] text-[var(--primary)]"
											>
												<svg
													viewBox="0 0 24 24"
													class="h-5 w-5"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													stroke-linecap="round"
													stroke-linejoin="round"
												>
													<path d="M4 18h7" />
													<path d="M4 12h11" />
													<path d="M4 6h16" />
													<circle cx="18" cy="18" r="2" />
												</svg>
											</div>
											<div class="min-w-0 flex-1">
												<p class="text-[10px] tracking-[0.28em] text-[var(--muted)] uppercase">
													Live trip
												</p>
												<p
													class="mt-1 text-[1.45rem] font-semibold tracking-[-0.04em] text-[var(--text)]"
												>
													{activeRouteLabel}
												</p>
												<div
													class="mt-2 flex flex-wrap items-center gap-2.5 text-xs text-[var(--muted)]"
												>
													<span class="inline-flex items-center gap-1.5">
														<svg
															viewBox="0 0 24 24"
															class="h-4 w-4"
															fill="none"
															stroke="currentColor"
															stroke-width="2"
															stroke-linecap="round"
															stroke-linejoin="round"
														>
															<circle cx="12" cy="12" r="8" />
															<path d="M12 8v4l2.5 2.5" />
														</svg>
														Arrive {nextArrivalLabel}
													</span>
													<span class="inline-flex items-center gap-1.5">
														<svg
															viewBox="0 0 24 24"
															class="h-4 w-4"
															fill="none"
															stroke="currentColor"
															stroke-width="2"
															stroke-linecap="round"
															stroke-linejoin="round"
														>
															<path d="M12 21s6-4.35 6-10a6 6 0 1 0-12 0c0 5.65 6 10 6 10Z" />
															<circle cx="12" cy="11" r="2.5" />
														</svg>
														{navigationRoute
															? formatDistance(navigationRoute.distanceMeters)
															: '--'}
													</span>
												</div>
											</div>
										</div>
									</div>

									{#if tripError}
										<div
											class="rounded-[20px] border border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]"
										>
											<div class="flex items-start gap-2.5">
												<svg
													viewBox="0 0 24 24"
													class="mt-0.5 h-4 w-4 shrink-0"
													fill="none"
													stroke="currentColor"
													stroke-width="2.2"
													stroke-linecap="round"
													stroke-linejoin="round"
												>
													<circle cx="12" cy="12" r="9" />
													<path d="M12 8v5" />
													<circle cx="12" cy="16.5" r="0.8" fill="currentColor" stroke="none" />
												</svg>
												<span>{tripError}</span>
											</div>
										</div>
									{/if}
									<div
										class="rounded-[20px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3 text-[var(--text)] shadow-[var(--shadow-panel)]"
									>
										<div class="flex items-start justify-between gap-3">
											<div class="min-w-0">
												<p class="text-[10px] tracking-[0.28em] text-[var(--muted)] uppercase">
													Report ahead
												</p>
												<p class="mt-1 text-xs font-medium text-[var(--text)]">
													Flag a blockage or other issue without leaving navigation.
												</p>
											</div>
											<span
												class="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-[10px] font-medium text-[var(--muted)]"
											>
												Live GPS
											</span>
										</div>

										{#if reportError}
											<div
												class="mt-3 rounded-[16px] border border-[#f1b7a4] bg-[#fff0eb] px-3 py-2 text-xs font-medium text-[#7d2c1d]"
											>
												{reportError}
											</div>
										{/if}

										{#if reportFeedback}
											<div
												class="mt-3 rounded-[16px] border border-[#b7e6d4] bg-[#eefbf5] px-3 py-2 text-xs font-medium text-[#155544]"
											>
												{reportFeedback}
											</div>
										{/if}

										<div class="mt-2.5 grid grid-cols-3 gap-1.5">
											{#each INCIDENT_TYPES as incidentType (incidentType)}
												<button
													type="button"
													onclick={() => void submitIncident(incidentType)}
													disabled={reportSubmitting}
													class={`rounded-[14px] border px-2 py-2 text-left transition ${
														selectedType === incidentType
															? 'border-[#1e88f7] bg-[#eef6ff] shadow-[0_10px_24px_rgba(30,136,247,0.12)]'
															: 'border-[var(--border)] bg-white hover:bg-[var(--primary-soft)]'
													} disabled:opacity-50`}
												>
													<div class="flex items-center gap-1.5">
														<IncidentTypeIcon type={incidentType} class="h-4.5 w-4.5 shrink-0" />
														<span class="min-w-0 text-[11px] font-semibold text-[var(--text)]">
															{INCIDENT_LABELS[incidentType].en}
														</span>
													</div>
												</button>
											{/each}
										</div>
									</div>
								</div>

								<div
									class="pointer-events-auto flex flex-col items-stretch gap-3 lg:justify-self-end"
								>
									<div class="flex flex-wrap justify-end gap-2">
										<span
											class="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-xs font-medium text-[var(--muted)] shadow-[0_12px_28px_rgba(36,31,23,0.1)]"
										>
											<svg
												viewBox="0 0 24 24"
												class="h-4 w-4"
												fill="none"
												stroke="currentColor"
												stroke-width="2"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<path d="M12 21s6-4.35 6-10a6 6 0 1 0-12 0c0 5.65 6 10 6 10Z" />
												<circle cx="12" cy="11" r="2.5" />
											</svg>
											{currentRouteDestinationLabel}
										</span>
										<span
											class="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-xs font-medium text-[var(--muted)] shadow-[0_12px_28px_rgba(36,31,23,0.1)]"
										>
											<svg
												viewBox="0 0 24 24"
												class="h-4 w-4"
												fill="none"
												stroke="currentColor"
												stroke-width="2"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<path d="M5 19 19 5" />
												<path d="m9 5 10 0 0 10" />
											</svg>
											Traffic-aware path
										</span>
									</div>

									<button
										type="button"
										onclick={markArrived}
										disabled={tripStatus !== 'tracking' || tripBusy !== null}
										class="flex min-w-[240px] items-center justify-center gap-3 self-end rounded-[26px] bg-[var(--primary)] px-6 py-5 text-lg font-semibold text-white shadow-[0_24px_64px_rgba(90,66,41,0.24)] hover:bg-[#5a4229] disabled:bg-[var(--surface-muted)] disabled:text-[var(--muted)] disabled:shadow-none"
									>
										<svg
											viewBox="0 0 24 24"
											class="h-5 w-5"
											fill="none"
											stroke="currentColor"
											stroke-width="2.2"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<path d="M5 13l4 4L19 7" />
										</svg>
										{tripBusy === 'arriving' ? 'Saving...' : 'Arrived'}
									</button>
								</div>
							</div>
						</div>
					{:else}
						<div
							class="flex h-full flex-col justify-between px-3 pt-[calc(env(safe-area-inset-top,0px)+12px)] pb-3 sm:hidden"
						>
							<div
								class="pointer-events-auto relative w-full max-w-[348px] overflow-hidden rounded-[30px] border border-[var(--border)] bg-[var(--surface)] px-4 py-4 text-[var(--text)] shadow-[var(--shadow-panel)]"
							>
								<div class="absolute top-4 right-4 flex items-center gap-2">
									<span
										class={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold shadow-[0_10px_24px_rgba(15,23,42,0.08)] ${
											navigationRoute
												? getTrafficBadgeClass(navigationRoute.trafficLevel)
												: 'border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--muted)]'
										}`}
									>
										<svg
											viewBox="0 0 24 24"
											class="h-3.5 w-3.5"
											fill="none"
											stroke="currentColor"
											stroke-width="2"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<path d="M4 12h16" />
											<path d="m13 5 7 7-7 7" />
										</svg>
										{navigationRoute ? getTrafficLabel(navigationRoute.trafficLevel) : 'Standby'}
									</span>

									<button
										type="button"
										onclick={clearRoutePlan}
										class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] shadow-[0_12px_28px_rgba(15,23,42,0.08)]"
										aria-label="Dismiss route planner"
									>
										<svg
											viewBox="0 0 24 24"
											class="h-5 w-5"
											fill="none"
											stroke="currentColor"
											stroke-width="2.2"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<path d="M18 6 6 18" />
											<path d="m6 6 12 12" />
										</svg>
									</button>
								</div>

								<p
									class="text-[11px] font-semibold tracking-[0.28em] text-[var(--muted)] uppercase"
								>
									Next move
								</p>
								<p
									class="mt-3 pr-[9.25rem] text-[1.65rem] leading-[1.2] font-semibold tracking-[-0.05em] text-[#101828]"
								>
									{navigationRoute?.navigationCue.instruction ??
										'Search for a destination to compare route options.'}
								</p>
								<p class="mt-2 pr-[5rem] text-sm font-medium text-[var(--muted)]">
									{navigationRoadLabel}
								</p>

								<div class="mt-4 grid grid-cols-3 gap-2">
									<div
										class="rounded-[20px] border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 shadow-[0_10px_24px_rgba(15,23,42,0.05)]"
									>
										<p
											class="text-[10px] font-semibold tracking-[0.22em] text-[var(--muted)] uppercase"
										>
											Distance
										</p>
										<p class="mt-1 text-base font-semibold text-[var(--text)]">
											{routeDistanceLabel}
										</p>
									</div>
									<div
										class="rounded-[20px] border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 shadow-[0_10px_24px_rgba(15,23,42,0.05)]"
									>
										<p
											class="text-[10px] font-semibold tracking-[0.22em] text-[var(--muted)] uppercase"
										>
											ETA
										</p>
										<p class="mt-1 text-base font-semibold text-[var(--text)]">
											{nextArrivalLabel}
										</p>
									</div>
									<div
										class="rounded-[20px] border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 shadow-[0_10px_24px_rgba(15,23,42,0.05)]"
									>
										<p
											class="text-[10px] font-semibold tracking-[0.22em] text-[var(--muted)] uppercase"
										>
											Trip
										</p>
										<p class="mt-1 text-base font-semibold text-[var(--text)]">
											{selectedRoute ? formatMinutes(selectedRoute.durationSec) : '--'}
										</p>
									</div>
								</div>

								{#if mobileRouteBanner}
									<div
										class={`mt-3 line-clamp-2 rounded-[18px] border px-3.5 py-2.5 text-[12px] leading-5 shadow-[0_10px_24px_rgba(15,23,42,0.04)] ${getMobileRouteBannerClass(mobileRouteBanner?.tone ?? 'error')}`}
									>
										{mobileRouteBanner?.message}
									</div>
								{/if}
							</div>

							<div
								class="pointer-events-auto rounded-[34px] border border-[var(--border)] bg-[var(--surface)] px-4 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+14px)] text-[var(--text)] shadow-[0_-20px_56px_rgba(15,23,42,0.18)]"
							>
								<div
									class="mx-auto h-1.5 w-14 rounded-full bg-[linear-gradient(90deg,rgba(156,163,175,0.18),rgba(100,116,139,0.4),rgba(156,163,175,0.18))]"
								></div>

								<div class="mt-3">
									<div class="mb-4 flex items-center justify-between gap-3">
										<div>
											<p
												class="text-[11px] font-semibold tracking-[0.26em] text-[var(--muted)] uppercase"
											>
												Route setup
											</p>
											<p class="mt-1 text-lg font-semibold tracking-[-0.04em] text-[#101828]">
												Compare options
											</p>
										</div>
										{#if selectedRoute}
											<span
												class="inline-flex items-center gap-1.5 rounded-full border border-[#b6dcff] bg-[#edf6ff] px-3 py-1.5 text-[11px] font-semibold text-[var(--primary-strong)]"
											>
												<svg
													viewBox="0 0 24 24"
													class="h-3.5 w-3.5"
													fill="none"
													stroke="currentColor"
													stroke-width="2.2"
													stroke-linecap="round"
													stroke-linejoin="round"
												>
													<path d="m5 12 4 4L19 6" />
												</svg>
												Selected
											</span>
										{/if}
									</div>

									<div class="mb-4 flex flex-wrap gap-2">
										{#each preferenceSummary.slice(0, 3) as chip (chip)}
											<span
												class="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-white px-3 py-1.5 text-[11px] font-semibold text-[var(--muted)] shadow-[0_8px_18px_rgba(15,23,42,0.04)]"
											>
												<span class="h-1.5 w-1.5 rounded-full bg-[var(--primary)]"></span>
												{chip}
											</span>
										{/each}
									</div>
									{#if routeLoading}
										<div class="grid grid-cols-3 gap-2">
											{#each [0, 1, 2] as loadingCard (loadingCard)}
												<div
													class="rounded-[22px] border border-[var(--border)] bg-[var(--surface)] px-3 py-3 shadow-[0_10px_22px_rgba(15,23,42,0.04)]"
												>
													<div class="h-3 w-16 rounded-full bg-black/8"></div>
													<div class="mt-3 h-6 w-12 rounded-full bg-black/8"></div>
													<div class="mt-2 h-3 w-12 rounded-full bg-black/8"></div>
												</div>
											{/each}
										</div>
									{:else if routeOptions.length > 0}
										<div
											class={`grid gap-2 ${routeOptions.length === 1 ? 'grid-cols-1' : routeOptions.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}
										>
											{#each routeOptions as route (route.routeId)}
												<button
													type="button"
													onclick={() => selectRoute(route.routeId)}
													class={`rounded-[24px] border px-3.5 py-3.5 text-left transition ${
														selectedRouteId === route.routeId
															? 'border-[#b6dcff] bg-[linear-gradient(180deg,#f3f8ff,#eaf4ff)] shadow-[0_16px_36px_rgba(25,118,243,0.14)]'
															: 'border-[var(--border)] bg-[var(--surface)] shadow-[0_10px_24px_rgba(15,23,42,0.04)]'
													}`}
												>
													<div class="flex items-start justify-between gap-2">
														<div class="min-w-0">
															<p
																class="line-clamp-2 text-[13px] leading-4 font-semibold text-[#171717]"
															>
																{route.label}
															</p>
															<p
																class="mt-2 text-[22px] leading-none font-semibold tracking-[-0.05em] text-[#101828]"
															>
																{formatMinutes(route.durationSec)}
															</p>
														</div>
														<span
															class={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${getTrafficBadgeClass(route.trafficLevel)}`}
														>
															{getTrafficLabel(route.trafficLevel)}
														</span>
													</div>
													<div
														class="mt-3 flex items-center justify-between gap-2 text-[11px] font-medium text-[var(--muted)]"
													>
														<p>{formatDistance(route.distanceMeters)}</p>
														{#if selectedRouteId === route.routeId}
															<span
																class="inline-flex items-center gap-1 text-[var(--primary-strong)]"
															>
																<svg
																	viewBox="0 0 24 24"
																	class="h-3.5 w-3.5"
																	fill="none"
																	stroke="currentColor"
																	stroke-width="2.2"
																	stroke-linecap="round"
																	stroke-linejoin="round"
																>
																	<path d="m5 12 4 4L19 6" />
																</svg>
																Best fit
															</span>
														{/if}
													</div>
													<p class="mt-2 text-[10px] leading-4 text-black/48">
														{formatTollEstimate(route.estimatedTollCostUsd)} • {formatFuelEstimate(
															route.estimatedFuelLiters
														)}
													</p>
												</button>
											{/each}
										</div>
									{:else}
										<div
											class="rounded-[22px] border border-dashed border-[var(--border)] bg-[var(--surface)] px-4 py-3.5 text-[13px] leading-5 text-[var(--muted)]"
										>
											Refresh to load routes again.
										</div>
									{/if}
								</div>

								<div class="mt-4 grid grid-cols-[84px_108px_minmax(0,1fr)] gap-2">
									<button
										type="button"
										onclick={clearRoutePlan}
										class="inline-flex items-center justify-center gap-2 rounded-[20px] border border-[var(--border)] bg-white px-3 py-3 text-sm font-semibold text-[var(--muted)] shadow-[0_10px_22px_rgba(15,23,42,0.04)]"
									>
										<svg
											viewBox="0 0 24 24"
											class="h-4 w-4"
											fill="none"
											stroke="currentColor"
											stroke-width="2.2"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<path d="M5 12h14" />
										</svg>
										Later
									</button>
									<button
										type="button"
										onclick={() => void planRoute()}
										disabled={!routeDestination || routeLoading}
										class="inline-flex items-center justify-center gap-2 rounded-[20px] border border-[var(--border)] bg-white px-3 py-3 text-sm font-semibold text-[var(--muted)] shadow-[0_10px_22px_rgba(15,23,42,0.04)] disabled:opacity-50"
									>
										<svg
											viewBox="0 0 24 24"
											class="h-4 w-4"
											fill="none"
											stroke="currentColor"
											stroke-width="2.2"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<path d="M21 12a9 9 0 1 1-2.64-6.36" />
											<path d="M21 3v6h-6" />
										</svg>
										Refresh
									</button>
									<button
										type="button"
										onclick={beginTrip}
										disabled={!selectedRoute || tripBusy !== null}
										class="inline-flex items-center justify-center gap-2 rounded-[22px] bg-[var(--primary)] px-4 py-3 text-sm font-semibold text-white shadow-[0_18px_34px_rgba(25,118,243,0.28)] hover:bg-[var(--primary-strong)] disabled:bg-[var(--surface-muted)] disabled:text-[var(--muted)] disabled:shadow-none"
									>
										<svg
											viewBox="0 0 24 24"
											class="h-4 w-4"
											fill="none"
											stroke="currentColor"
											stroke-width="2.2"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<path d="M5 12h14" />
											<path d="m13 5 7 7-7 7" />
										</svg>
										{tripBusy === 'starting' ? 'Starting...' : 'Go'}
									</button>
								</div>
							</div>
						</div>

						<div class="hidden">
							<div
								class="pointer-events-auto self-start rounded-[22px] border border-[var(--border)] bg-[var(--surface)] p-3 text-[var(--text)] shadow-[var(--shadow-panel)]"
							>
								<div class="flex items-start justify-between gap-2">
									<div class="min-w-0">
										<p
											class="truncate text-[1.1rem] font-semibold tracking-[-0.04em] text-[var(--text)]"
										>
											{currentRouteDestinationLabel}
										</p>
										<p class="mt-0.5 text-[11px] leading-4 text-[var(--muted)]">
											{currentRouteDestinationDetail}
										</p>
									</div>
									<div class="flex shrink-0 items-center gap-1.5">
										<span
											class={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
												navigationRoute
													? getTrafficBadgeClass(navigationRoute.trafficLevel)
													: 'bg-[var(--surface-muted)] text-[var(--muted)]'
											}`}
										>
											{navigationRoute ? getTrafficLabel(navigationRoute.trafficLevel) : 'Standby'}
										</span>
										<button
											type="button"
											onclick={() => void planRoute()}
											disabled={!routeDestination || routeLoading}
											class="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:border-[var(--border-strong)] hover:bg-[var(--primary-soft)] disabled:opacity-50"
											aria-label="Refresh routes"
											title="Refresh routes"
										>
											<svg
												viewBox="0 0 24 24"
												class="h-[18px] w-[18px]"
												fill="none"
												stroke="currentColor"
												stroke-width="2.2"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<path d="M21 12a9 9 0 1 1-2.64-6.36" />
												<path d="M21 3v6h-6" />
											</svg>
										</button>
									</div>
								</div>

								<div class="mt-2.5 flex flex-wrap gap-1.5">
									{#each UNIVERSITY_SEEDS as university (university.id)}
										<button
											type="button"
											onclick={() => choosePresetDestination(university)}
											class={`rounded-full border px-2 py-1 text-[10px] font-medium ${
												routeDestination?.presetId === university.id
													? 'border-[var(--border-strong)] bg-[var(--surface-muted)] text-[var(--text)]'
													: 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:border-[var(--border-strong)] hover:bg-[var(--primary-soft)]'
											}`}
										>
											{university.shortName}
										</button>
									{/each}
								</div>

								<div class="mt-3 flex flex-wrap gap-1.5">
									{#each preferenceSummary.slice(0, 4) as chip (chip)}
										<span
											class="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[10px] font-medium text-[var(--muted)]"
										>
											{chip}
										</span>
									{/each}
								</div>
							</div>

							<div class="pointer-events-auto lg:self-start lg:justify-self-center">
								<div
									class="mx-auto w-full max-w-[560px] rounded-[24px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3 text-[var(--text)] shadow-[var(--shadow-float)]"
								>
									<div class="flex items-start gap-3">
										<div
											class="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-[15px] bg-[var(--surface-muted)] text-[var(--text)]"
										>
											<svg
												viewBox="0 0 24 24"
												class="h-6 w-6"
												fill="none"
												stroke="currentColor"
												stroke-width="2.2"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<path d="M12 21s6-4.35 6-10a6 6 0 1 0-12 0c0 5.65 6 10 6 10Z" />
												<circle cx="12" cy="11" r="2.5" />
											</svg>
										</div>

										<div class="min-w-0 flex-1">
											<div class="flex items-start justify-between gap-3">
												<div class="min-w-0">
													<p
														class="text-[2rem] leading-none font-semibold tracking-[-0.05em] text-[var(--text)]"
													>
														{navigationRoute ? nextCueDistanceLabel : 'Ready'}
													</p>
													<p class="mt-1 truncate text-sm font-medium text-[var(--primary)]">
														{navigationRoute?.navigationCue.roadName ??
															currentRouteDestinationLabel}
													</p>
												</div>
												{#if navigationRoute}
													<span
														class={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${getTrafficBadgeClass(navigationRoute.trafficLevel)}`}
													>
														{getTrafficLabel(navigationRoute.trafficLevel)}
													</span>
												{/if}
											</div>
										</div>
									</div>

									<div class="mt-2.5 grid grid-cols-3 gap-1.5">
										<div
											class="flex items-center gap-2 rounded-[15px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
										>
											<svg
												viewBox="0 0 24 24"
												class="h-4 w-4 shrink-0 text-[var(--muted)]"
												fill="none"
												stroke="currentColor"
												stroke-width="2.2"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<circle cx="12" cy="12" r="8" />
												<path d="M12 8v4l2.5 2.5" />
											</svg>
											<p class="text-[15px] font-semibold text-[var(--text)]">{nextArrivalLabel}</p>
										</div>
										<div
											class="flex items-center gap-2 rounded-[15px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
										>
											<svg
												viewBox="0 0 24 24"
												class="h-4 w-4 shrink-0 text-[var(--muted)]"
												fill="none"
												stroke="currentColor"
												stroke-width="2.2"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<path d="M10 2h4" />
												<path d="M12 14v-4" />
												<circle cx="12" cy="14" r="8" />
											</svg>
											<p class="text-[15px] font-semibold text-[var(--text)]">
												{navigationRoute ? formatMinutes(navigationRoute.durationSec) : '--'}
											</p>
										</div>
										<div
											class="flex items-center gap-2 rounded-[15px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
										>
											<svg
												viewBox="0 0 24 24"
												class="h-4 w-4 shrink-0 text-[var(--muted)]"
												fill="none"
												stroke="currentColor"
												stroke-width="2.2"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<path d="M18 17H6" />
												<path d="M15 12H6" />
												<path d="M12 7H6" />
											</svg>
											<p class="truncate text-[11px] font-semibold text-[var(--text)]">
												{navigationRoute?.trafficSummary ?? 'Planning'}
											</p>
										</div>
									</div>
								</div>
							</div>

							<div
								class="pointer-events-auto hidden max-h-[calc(100svh-220px)] overflow-hidden rounded-[22px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-float)] lg:block"
							>
								<div
									class="flex items-center justify-between border-b border-[var(--border)] px-3 py-2"
								>
									<p class="text-[1.05rem] font-semibold text-[var(--text)]">
										{routeOptions.length > 0 ? `${routeOptions.length} routes` : 'Routes'}
									</p>
									{#if selectedRoute}
										<p class="text-xs text-[var(--muted)]">
											{formatMinutes(selectedRoute.durationSec)}
										</p>
									{/if}
								</div>

								<div class="max-h-[calc(100svh-284px)] space-y-1.5 overflow-y-auto p-2">
									{#if routeLoading}
										<div
											class="rounded-[22px] border border-[var(--border)] bg-[var(--surface)] px-4 py-4 text-sm text-[var(--muted)]"
										>
											Loading routes...
										</div>
									{:else if !routeDestination}
										<div
											class="rounded-[22px] border border-dashed border-[var(--border)] bg-[var(--surface)] px-4 py-4 text-sm text-[var(--muted)]"
										>
											Search for a destination above.
										</div>
									{:else if routeOptions.length === 0}
										<div
											class="rounded-[22px] border border-[var(--border)] bg-[var(--surface)] px-4 py-4 text-sm text-[var(--muted)]"
										>
											No routes yet. Move the pin.
										</div>
									{:else}
										{#each routeOptions as route (route.routeId)}
											<button
												type="button"
												onclick={() => selectRoute(route.routeId)}
												class={`block w-full rounded-[18px] border px-3 py-2.5 text-left transition ${
													selectedRouteId === route.routeId
														? 'border-[var(--border-strong)] bg-[var(--primary-soft)]'
														: 'border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-strong)] hover:bg-[var(--primary-soft)]'
												}`}
											>
												<div class="flex items-start justify-between gap-2">
													<div class="min-w-0">
														<p class="text-sm font-medium text-[var(--text)]">{route.label}</p>
														<div
															class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-[var(--muted)]"
														>
															<span>{formatMinutes(route.durationSec)}</span>
															<span class="h-1 w-1 rounded-full bg-[var(--border-strong)]"></span>
															<span>{formatDistance(route.distanceMeters)}</span>
															<span class="h-1 w-1 rounded-full bg-[var(--border-strong)]"></span>
															<span>{formatArrivalTime(route.arrivalTime)}</span>
														</div>
													</div>
													<div class="flex shrink-0 items-center gap-1.5">
														<span
															class={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${getTrafficBadgeClass(route.trafficLevel)}`}
														>
															{getTrafficLabel(route.trafficLevel)}
														</span>
														{#if selectedRouteId === route.routeId}
															<span
																class="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--text)]"
																aria-label="Selected route"
																title="Selected route"
															>
																<svg
																	viewBox="0 0 24 24"
																	class="h-[18px] w-[18px]"
																	fill="none"
																	stroke="currentColor"
																	stroke-width="2.4"
																	stroke-linecap="round"
																	stroke-linejoin="round"
																>
																	<path d="m5 12 4 4L19 6" />
																</svg>
															</span>
														{/if}
													</div>
												</div>
												<div class="mt-2 flex flex-wrap gap-1.5">
													<span
														class="inline-flex items-center gap-1 rounded-full bg-[var(--surface-muted)] px-2 py-1 text-[11px] text-[var(--muted)]"
													>
														{formatTollEstimate(route.estimatedTollCostUsd)}
													</span>
													<span
														class="inline-flex items-center gap-1 rounded-full bg-[var(--surface-muted)] px-2 py-1 text-[11px] text-[var(--muted)]"
													>
														{formatFuelEstimate(route.estimatedFuelLiters)}
													</span>
													{#if route.incidentIds.length > 0}
														<span
															class="inline-flex items-center gap-1 rounded-full bg-[var(--surface-muted)] px-2 py-1 text-[11px] text-[var(--muted)]"
														>
															<svg
																viewBox="0 0 24 24"
																class="h-[14px] w-[14px]"
																fill="none"
																stroke="currentColor"
																stroke-width="2.2"
																stroke-linecap="round"
																stroke-linejoin="round"
															>
																<path d="M12 9v4" />
																<path d="M12 17h.01" />
																<path
																	d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
																/>
															</svg>
															{route.incidentIds.length}
														</span>
													{/if}
													{#if route.explanationChips[1] && route.explanationChips[1] !== route.trafficSummary}
														<span
															class="rounded-full bg-[var(--surface-muted)] px-2 py-1 text-[11px] text-[var(--muted)]"
														>
															{route.explanationChips[1]}
														</span>
													{/if}
												</div>
											</button>
										{/each}
									{/if}
								</div>
							</div>
						</div>

						<div class="hidden gap-3 lg:grid lg:grid-cols-[280px_minmax(0,1fr)_340px] lg:items-end">
							<div class="pointer-events-auto space-y-2">
								{#if routeError}
									<div
										class="rounded-[20px] border border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]"
									>
										{routeError}
									</div>
								{/if}
								{#if tripError}
									<div
										class="rounded-[20px] border border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]"
									>
										{tripError}
									</div>
								{/if}
								{#if tripMessage}
									<div
										class="rounded-[20px] border border-[var(--accent-soft)] bg-[var(--accent-soft)] px-4 py-3 text-sm text-[var(--accent)]"
									>
										{tripMessage}
									</div>
								{/if}
							</div>

							<div class="pointer-events-auto lg:justify-self-center">
								<div
									class="mx-auto flex w-full max-w-[196px] items-center gap-2 rounded-[26px] border border-white/70 bg-[var(--surface-glass)] p-2.5 text-[var(--text)] shadow-[var(--shadow-panel)]"
								>
									<button
										type="button"
										onclick={clearRoutePlan}
										class="flex h-11 w-11 shrink-0 items-center justify-center rounded-[18px] border border-[var(--border)] bg-white text-[var(--muted)] hover:border-[var(--border-strong)] hover:bg-[var(--primary-soft)]"
										aria-label="Close route planner"
										title="Close route planner"
									>
										<svg
											viewBox="0 0 24 24"
											class="h-5 w-5"
											fill="none"
											stroke="currentColor"
											stroke-width="2.2"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<path d="M18 6 6 18" />
											<path d="m6 6 12 12" />
										</svg>
									</button>
									<button
										type="button"
										onclick={() => void planRoute()}
										disabled={!routeDestination || routeLoading}
										class="flex h-11 w-11 shrink-0 items-center justify-center rounded-[18px] border border-[var(--border)] bg-white text-[var(--muted)] hover:border-[var(--border-strong)] hover:bg-[var(--primary-soft)] disabled:opacity-50"
										aria-label="Refresh routes"
										title="Refresh routes"
									>
										<svg
											viewBox="0 0 24 24"
											class="h-5 w-5"
											fill="none"
											stroke="currentColor"
											stroke-width="2.2"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<path d="M21 12a9 9 0 1 1-2.64-6.36" />
											<path d="M21 3v6h-6" />
										</svg>
									</button>
								</div>
							</div>
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<div class="pointer-events-none absolute inset-x-0 bottom-0 z-30 px-3 pb-3 sm:px-2 sm:pb-3">
			<div
				class="mx-auto flex max-w-[1440px] flex-col items-center gap-3 sm:mx-0 sm:max-w-none lg:items-start"
			>
				<div
					class="pointer-events-auto w-full max-w-[560px] rounded-[28px] border border-black/8 bg-[var(--surface)] p-1.5 shadow-[var(--shadow-float)]"
				>
					<div class="grid grid-cols-3 gap-1">
						{#each dockItems as item (item.id)}
							<button
								type="button"
								aria-current={activeTab === item.id ? 'page' : undefined}
								onclick={() => void handleTabNavigation(item.href)}
								class={`flex items-center justify-center gap-2 rounded-[22px] px-4 py-3 text-sm font-medium ${
									activeTab === item.id
										? 'bg-[#f3f4f6] text-[var(--text)]'
										: 'text-[var(--muted)] hover:bg-[#f8fafc]'
								}`}
							>
								{#if item.id === 'pulse'}
									<svg
										viewBox="0 0 24 24"
										class="h-4 w-4"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
									>
										<path d="M12 21s6-4.35 6-10a6 6 0 1 0-12 0c0 5.65 6 10 6 10Z" />
										<circle cx="12" cy="11" r="2.5" />
									</svg>
								{:else if item.id === 'route'}
									<svg
										viewBox="0 0 24 24"
										class="h-4 w-4"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
									>
										<path d="M9 6 15 12 9 18" />
									</svg>
								{:else}
									<svg
										viewBox="0 0 24 24"
										class="h-4 w-4"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
									>
										<circle cx="12" cy="8" r="3.5" />
										<path d="M5 19a7 7 0 0 1 14 0" />
									</svg>
								{/if}
								{item.label}
							</button>
						{/each}
					</div>
				</div>

				{#if activeTab === 'route'}
					<div class="pointer-events-auto hidden w-full max-w-[420px]">
						{#if routeSheetOpen || tripStatus === 'tracking'}
							<div
								class="overflow-hidden rounded-[34px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-float)]"
							>
								<div class="border-b border-[var(--border)] bg-[var(--surface)] p-5">
									<div class="flex items-start justify-between gap-3">
										<div class="min-w-0">
											<p class="text-[11px] tracking-[0.26em] text-[var(--muted)] uppercase">
												Plan and track
											</p>
											<p
												class="mt-2 truncate text-[1.85rem] font-semibold tracking-[-0.05em] text-[#101828]"
											>
												{currentRouteDestinationLabel}
											</p>
											<p class="mt-1 text-sm leading-6 text-[var(--muted)]">
												{currentRouteDestinationDetail}
											</p>
										</div>
										<div class="flex shrink-0 items-center gap-2">
											<span
												class={`rounded-full px-3 py-1.5 text-xs font-semibold shadow-[0_10px_22px_rgba(15,23,42,0.05)] ${
													navigationRoute
														? getTrafficBadgeClass(navigationRoute.trafficLevel)
														: 'border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--muted)]'
												}`}
											>
												{navigationRoute
													? getTrafficLabel(navigationRoute.trafficLevel)
													: 'Standby'}
											</span>
											{#if tripStatus !== 'tracking'}
												<button
													type="button"
													onclick={() => (routeSheetOpen = false)}
													class="rounded-full border border-[var(--border)] bg-white px-3 py-1.5 text-xs font-medium text-[var(--muted)] hover:bg-[var(--primary-soft)]"
												>
													Hide
												</button>
											{/if}
										</div>
									</div>

									<div
										class="mt-5 grid grid-cols-2 gap-2 text-sm text-[var(--muted)] sm:grid-cols-3"
									>
										<span
											class="rounded-[18px] border border-[var(--border)] bg-white px-3 py-2.5 shadow-[0_8px_18px_rgba(15,23,42,0.04)]"
										>
											{navigationRoute
												? formatMinutes(navigationRoute.durationSec)
												: routeDistanceLabel}
										</span>
										<span
											class="rounded-[18px] border border-[var(--border)] bg-white px-3 py-2.5 shadow-[0_8px_18px_rgba(15,23,42,0.04)]"
										>
											Arrive {nextArrivalLabel}
										</span>
										{#if navigationRoute}
											<span
												class="rounded-[18px] border border-[var(--border)] bg-white px-3 py-2.5 shadow-[0_8px_18px_rgba(15,23,42,0.04)]"
											>
												{formatDistance(navigationRoute.distanceMeters)}
											</span>
										{/if}
									</div>
								</div>

								<div class="space-y-4 p-5">
									{#if routeDestination && tripStatus !== 'tracking'}
										<div class="flex justify-end">
											<button
												type="button"
												onclick={() => void planRoute()}
												disabled={!routeDestination || routeLoading}
												class="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-white px-3 py-2 text-xs font-medium text-[var(--muted)] hover:bg-[var(--primary-soft)] disabled:opacity-50"
											>
												<svg
													viewBox="0 0 24 24"
													class="h-3.5 w-3.5"
													fill="none"
													stroke="currentColor"
													stroke-width="2.2"
													stroke-linecap="round"
													stroke-linejoin="round"
												>
													<path d="M21 12a9 9 0 1 1-2.64-6.36" />
													<path d="M21 3v6h-6" />
												</svg>
												{routeLoading ? 'Refreshing...' : 'Refresh'}
											</button>
										</div>
									{/if}

									{#if routeError}
										<div
											class="rounded-[18px] border border-[var(--danger)]/20 bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]"
										>
											{routeError}
										</div>
									{/if}

									{#if tripError}
										<div
											class="rounded-[18px] border border-[var(--danger)]/20 bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]"
										>
											{tripError}
										</div>
									{/if}

									{#if tripMessage}
										<div
											class="rounded-[18px] border border-[var(--accent)]/15 bg-[var(--accent-soft)] px-4 py-3 text-sm text-[var(--accent)]"
										>
											{tripMessage}
										</div>
									{/if}

									{#if tripStatus === 'tracking'}
										<div
											class="rounded-[22px] border border-[var(--border)] bg-[var(--surface)] p-4"
										>
											<div class="flex items-start justify-between gap-3">
												<div class="min-w-0">
													<p class="text-[10px] tracking-[0.28em] text-[var(--muted)] uppercase">
														Report on the road
													</p>
													<p class="mt-1 text-sm font-medium text-[var(--text)]">
														Flag what is ahead without leaving trip mode.
													</p>
													<p class="mt-1 text-xs text-[var(--muted)]">
														Uses your live GPS location while the trip is active.
													</p>
												</div>
												<span
													class="rounded-full border border-[var(--border)] bg-white px-2.5 py-1 text-[11px] font-medium text-[var(--muted)]"
												>
													Live report
												</span>
											</div>

											{#if reportError}
												<div
													class="mt-3 rounded-[16px] border border-[#f1b7a4] bg-[#fff0eb] px-3 py-2 text-xs font-medium text-[#7d2c1d]"
												>
													{reportError}
												</div>
											{/if}

											{#if reportFeedback}
												<div
													class="mt-3 rounded-[16px] border border-[#b7e6d4] bg-[#eefbf5] px-3 py-2 text-xs font-medium text-[#155544]"
												>
													{reportFeedback}
												</div>
											{/if}

											<div class="mt-3 grid grid-cols-3 gap-2">
												{#each INCIDENT_TYPES as incidentType (incidentType)}
													<button
														type="button"
														onclick={() => void submitIncident(incidentType)}
														disabled={reportSubmitting}
														class={`rounded-[18px] border px-3 py-3 text-left transition ${
															selectedType === incidentType
																? 'border-[#1e88f7] bg-[#eef6ff] shadow-[0_10px_24px_rgba(30,136,247,0.12)]'
																: 'border-[var(--border)] bg-white hover:bg-[var(--primary-soft)]'
														} disabled:opacity-50`}
													>
														<div class="flex items-center gap-2">
															<IncidentTypeIcon type={incidentType} class="h-6 w-6 shrink-0" />
															<span class="min-w-0 text-xs font-semibold text-[var(--text)]">
																{INCIDENT_LABELS[incidentType].en}
															</span>
														</div>
													</button>
												{/each}
											</div>

											<p class="mt-3 text-xs text-[var(--muted)]">
												Example: tap <span class="font-semibold text-[var(--text)]">Roadblock</span>
												if traffic is blocked ahead.
											</p>
										</div>
									{/if}

									{#if !routeDestination}
										<div
											class="rounded-[22px] border border-dashed border-[var(--border)] bg-[var(--surface)] px-4 py-4 text-sm text-[var(--muted)]"
										>
											Search for a destination, or tap a campus chip above for a quick preset.
										</div>
									{:else if routeLoading}
										<div
											class="rounded-[22px] border border-[var(--border)] bg-[var(--surface)] px-4 py-4 text-sm text-[var(--muted)]"
										>
											Loading traffic-aware routes for {routeDestination?.label ??
												'your destination'}.
										</div>
									{:else if routeOptions.length === 0}
										<div
											class="rounded-[22px] border border-[var(--border)] bg-[var(--surface)] px-4 py-4 text-sm text-[var(--muted)]"
										>
											No routes yet. Refresh to try again.
										</div>
									{:else}
										<div class="max-h-[280px] space-y-2 overflow-y-auto pr-1">
											{#each routeOptions as route (route.routeId)}
												<button
													type="button"
													onclick={() => selectRoute(route.routeId)}
													disabled={tripStatus === 'tracking'}
													class={`block w-full rounded-[24px] border px-4 py-3.5 text-left transition ${
														selectedRouteId === route.routeId
															? 'border-[#b6dcff] bg-[linear-gradient(180deg,#f3f8ff,#eaf4ff)] shadow-[0_16px_34px_rgba(25,118,243,0.12)]'
															: 'border-[var(--border)] bg-white hover:bg-[var(--primary-soft)]'
													} disabled:cursor-default disabled:opacity-85`}
												>
													<div class="flex items-start justify-between gap-3">
														<div class="min-w-0">
															<div class="flex flex-wrap items-center gap-2">
																<p class="text-sm font-semibold text-[var(--text)]">
																	{route.label}
																</p>
																{#if selectedRouteId === route.routeId}
																	<span
																		class="rounded-full bg-[var(--primary)] px-2.5 py-1 text-[10px] font-semibold text-white"
																	>
																		Best overall
																	</span>
																{/if}
															</div>
															<p class="mt-1 text-xs text-[var(--muted)]">
																{formatMinutes(route.durationSec)} • {formatDistance(
																	route.distanceMeters
																)} • {formatArrivalTime(route.arrivalTime)}
															</p>
															<div class="mt-2 flex flex-wrap gap-1.5">
																<span
																	class="rounded-full bg-[var(--surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--muted)]"
																>
																	{formatTollEstimate(route.estimatedTollCostUsd)}
																</span>
																<span
																	class="rounded-full bg-[var(--surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--muted)]"
																>
																	{formatFuelEstimate(route.estimatedFuelLiters)}
																</span>
															</div>
														</div>
														<div class="flex shrink-0 items-center gap-2">
															<span
																class={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${getTrafficBadgeClass(route.trafficLevel)}`}
															>
																{getTrafficLabel(route.trafficLevel)}
															</span>
														</div>
													</div>
												</button>
											{/each}
										</div>

										<div class="grid grid-cols-2 gap-2 pt-1">
											<button
												type="button"
												onclick={beginTrip}
												disabled={!selectedRoute || tripStatus === 'tracking' || tripBusy !== null}
												class="inline-flex items-center justify-center gap-2 rounded-[22px] bg-[var(--primary)] px-4 py-3.5 text-sm font-semibold text-white shadow-[0_16px_32px_rgba(25,118,243,0.24)] hover:bg-[var(--primary-strong)] disabled:bg-[var(--surface-muted)] disabled:text-[var(--muted)] disabled:shadow-none"
											>
												<svg
													viewBox="0 0 24 24"
													class="h-4 w-4"
													fill="none"
													stroke="currentColor"
													stroke-width="2.2"
													stroke-linecap="round"
													stroke-linejoin="round"
												>
													<path d="M5 12h14" />
													<path d="m13 5 7 7-7 7" />
												</svg>
												{tripBusy === 'starting'
													? 'Starting...'
													: tripStatus === 'tracking'
														? 'Trip live'
														: 'Start trip'}
											</button>
											<button
												type="button"
												onclick={markArrived}
												disabled={tripStatus !== 'tracking' || tripBusy !== null}
												class="inline-flex items-center justify-center gap-2 rounded-[22px] border border-[var(--border)] bg-white px-4 py-3.5 text-sm font-semibold text-[var(--text)] shadow-[0_10px_22px_rgba(15,23,42,0.04)] disabled:opacity-50"
											>
												<svg
													viewBox="0 0 24 24"
													class="h-4 w-4"
													fill="none"
													stroke="currentColor"
													stroke-width="2.2"
													stroke-linecap="round"
													stroke-linejoin="round"
												>
													<path d="m5 12 4 4L19 6" />
												</svg>
												{tripBusy === 'arriving' ? 'Saving...' : 'Arrived'}
											</button>
										</div>
									{/if}
								</div>
							</div>
						{:else if hasRouteContext}
							<button
								type="button"
								onclick={() => (routeSheetOpen = true)}
								class="w-full rounded-[28px] border border-[var(--border)] bg-[var(--surface)] p-4 text-left shadow-[var(--shadow-float)]"
							>
								<p class="text-[10px] tracking-[0.28em] text-[var(--muted)] uppercase">
									Route ready
								</p>
								<div class="mt-2 flex items-center justify-between gap-3">
									<div class="min-w-0">
										<p class="truncate text-lg font-semibold text-[var(--text)]">
											{currentRouteDestinationLabel}
										</p>
										<p class="mt-1 truncate text-sm text-[var(--muted)]">
											{selectedRoute
												? `${formatMinutes(selectedRoute.durationSec)} • ${selectedRoute.trafficSummary}`
												: currentRouteDestinationDetail}
										</p>
									</div>
									<span
										class="rounded-full bg-[var(--primary-soft)] px-3 py-1 text-xs font-semibold text-[var(--text)]"
									>
										Open
									</span>
								</div>
							</button>
						{/if}
					</div>
				{:else}
					<div
						class={`pointer-events-auto relative isolate flex w-full flex-col overflow-hidden transition-all ${
							activeTab === 'pulse'
								? `max-w-[560px] rounded-t-[30px] border border-black/8 bg-white text-[var(--text)] shadow-[0_-18px_48px_rgba(15,23,42,0.12)] ${reportSheetHeightClass}`
								: `max-w-[680px] rounded-[32px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-float)] ${
										drawerExpanded ? 'max-h-[82svh]' : 'max-h-[188px]'
									}`
						}`}
					>
						{#if activeTab === 'pulse'}
							<div class="border-b border-black/6 px-4 pt-3 pb-3">
								<div class="flex flex-col items-center gap-3">
									<button
										type="button"
										onclick={toggleActiveDrawer}
										class="flex w-full flex-col items-center gap-3 text-left"
									>
										<div class="h-1.5 w-14 rounded-full bg-black/12"></div>
										<div class="flex w-full items-center justify-between gap-3">
											<div class="min-w-0">
												<p class="text-[10px] tracking-[0.24em] text-[var(--muted)] uppercase">
													Street report
												</p>
												<p class="mt-1 text-lg font-semibold tracking-[-0.03em] text-[#141414]">
													{reportSheetState === 'collapsed'
														? 'Map first'
														: reportSheetState === 'half'
															? 'Report conditions'
															: 'Report details'}
												</p>
											</div>
											<span
												class={`max-w-[210px] truncate rounded-full px-3 py-1.5 text-xs font-medium ${
													weather?.tone === 'storm' || weather?.tone === 'rain'
														? 'bg-[#fff1d6] text-[#8a5a00]'
														: 'bg-[#f3f4f6] text-[#566273]'
												}`}
											>
												{getWeatherSummaryPill(weather)}
											</span>
										</div>
									</button>

									<div class="flex w-full justify-end">
										<button
											type="button"
											onclick={handleQuickReportAction}
											disabled={reportSubmitting}
											class="inline-flex items-center gap-2 rounded-full bg-[#fff1d6] px-3 py-1.5 text-xs font-semibold text-[#8a5a00] shadow-[0_8px_18px_rgba(217,119,6,0.12)] disabled:opacity-50"
										>
											<svg
												viewBox="0 0 24 24"
												class="h-3.5 w-3.5"
												fill="none"
												stroke="currentColor"
												stroke-width="2.2"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<path d="M12 5v14" />
												<path d="M5 12h14" />
											</svg>
											Quick report
										</button>
									</div>
								</div>
							</div>
						{:else}
							<button
								type="button"
								onclick={toggleActiveDrawer}
								class="relative z-10 w-full bg-[var(--surface)] px-4 py-4 text-left sm:px-5"
							>
								<div class="flex items-start justify-between gap-4">
									<div class="min-w-0">
										<div class="flex items-center gap-3">
											<div
												class="flex h-12 w-12 shrink-0 items-center justify-center rounded-[18px] bg-white text-[#141414] shadow-[0_10px_28px_rgba(17,24,39,0.08)]"
											>
												<svg
													viewBox="0 0 24 24"
													class="h-6 w-6"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													stroke-linecap="round"
													stroke-linejoin="round"
												>
													<circle cx="12" cy="8" r="3.5" />
													<path d="M5 19a7 7 0 0 1 14 0" />
												</svg>
											</div>
											<div class="min-w-0">
												<div class="flex flex-wrap items-center gap-2">
													<span
														class="flex h-5 w-5 items-center justify-center rounded-full bg-[#f1f2f4] text-black/58"
													>
														<svg
															viewBox="0 0 24 24"
															class="h-3.5 w-3.5"
															fill="none"
															stroke="currentColor"
															stroke-width="2"
															stroke-linecap="round"
															stroke-linejoin="round"
														>
															<circle cx="12" cy="8" r="3.5" />
															<path d="M5 19a7 7 0 0 1 14 0" />
														</svg>
													</span>
													<p class="text-[10px] tracking-[0.28em] text-[var(--muted)] uppercase">
														Account
													</p>
													<span
														class="rounded-full border border-black/8 bg-white px-2.5 py-1 text-[11px] font-medium text-black/60"
													>
														{getRoleLabel(meQuery.data?.role)}
													</span>
												</div>
												<p
													class="mt-1 truncate text-[1.55rem] font-semibold tracking-[-0.04em] text-[#141414]"
												>
													{meQuery.data?.displayName ?? panelCopy[activeTab].title}
												</p>
											</div>
										</div>
									</div>
									<span
										class="inline-flex shrink-0 items-center gap-2 rounded-full border border-black/8 bg-white px-3 py-1.5 text-xs font-medium text-black/60"
									>
										{drawerExpanded ? 'Collapse' : 'Expand'}
										<svg
											viewBox="0 0 24 24"
											class={`h-4 w-4 transition-transform ${drawerExpanded ? 'rotate-180' : ''}`}
											fill="none"
											stroke="currentColor"
											stroke-width="2"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<path d="m6 9 6 6 6-6" />
										</svg>
									</span>
								</div>
							</button>
						{/if}

						<div
							class={`relative z-10 min-h-0 overflow-y-auto border-t px-4 pb-4 ${
								activeTab === 'pulse' ? 'border-black/8' : 'border-black/8'
							} ${activeTab === 'pulse' ? '' : 'bg-[rgba(248,248,246,0.98)]'}`}
						>
							{#if activeTab === 'pulse'}
								<div class="px-0 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+10px)]">
									{#if reportError}
										<div
											class="mb-3 rounded-[16px] border border-[#f1b7a4] bg-[#fff0eb] px-3 py-2 text-xs font-medium text-[#7d2c1d]"
										>
											{reportError}
										</div>
									{/if}

									{#if reportFeedback}
										<div
											class="mb-3 rounded-[16px] border border-[#b7e6d4] bg-[#eefbf5] px-3 py-2 text-xs font-medium text-[#155544]"
										>
											{reportFeedback}
										</div>
									{/if}

									{#if reportSheetState !== 'collapsed'}
										<div class="space-y-3">
											<div
												class="rounded-[24px] bg-[#f3f4f6] px-4 py-4 shadow-[inset_0_0_0_1px_rgba(15,23,42,0.05)]"
											>
												<div class="flex items-center gap-3">
													<div
														class={`flex h-12 w-12 shrink-0 items-center justify-center rounded-[18px] ${
															weather?.tone === 'storm' || weather?.tone === 'rain'
																? 'bg-[#fff1d6] text-[#8a5a00]'
																: 'bg-white text-[#4b5563]'
														}`}
													>
														{#if getWeatherIcon(weather) === 'storm'}
															<svg
																viewBox="0 0 24 24"
																class="h-6 w-6"
																fill="none"
																stroke="currentColor"
																stroke-width="2"
																stroke-linecap="round"
																stroke-linejoin="round"
															>
																<path d="M6 16a4 4 0 1 1 .9-7.9A5 5 0 0 1 17 9a3 3 0 0 1 1 5.8" />
																<path d="m13 12-3 5h3l-2 5 6-8h-4l2-4Z" />
															</svg>
														{:else if getWeatherIcon(weather) === 'rain'}
															<svg
																viewBox="0 0 24 24"
																class="h-6 w-6"
																fill="none"
																stroke="currentColor"
																stroke-width="2"
																stroke-linecap="round"
																stroke-linejoin="round"
															>
																<path d="M6 15a4 4 0 1 1 .9-7.9A5 5 0 0 1 17 8a3 3 0 0 1 1 5.8" />
																<path d="M8 19v.01" />
																<path d="M12 19v.01" />
																<path d="M16 19v.01" />
															</svg>
														{:else if getWeatherIcon(weather) === 'watch'}
															<svg
																viewBox="0 0 24 24"
																class="h-6 w-6"
																fill="none"
																stroke="currentColor"
																stroke-width="2"
																stroke-linecap="round"
																stroke-linejoin="round"
															>
																<path d="M6 15a4 4 0 1 1 .9-7.9A5 5 0 0 1 17 8a3 3 0 0 1 1 5.8" />
																<path d="M12 16v4" />
																<path d="M10 18h4" />
															</svg>
														{:else}
															<svg
																viewBox="0 0 24 24"
																class="h-6 w-6"
																fill="none"
																stroke="currentColor"
																stroke-width="2"
																stroke-linecap="round"
																stroke-linejoin="round"
															>
																<circle cx="12" cy="12" r="4" />
																<path d="M12 2v2" />
																<path d="M12 20v2" />
																<path d="m4.93 4.93 1.41 1.41" />
																<path d="m17.66 17.66 1.41 1.41" />
																<path d="M2 12h2" />
																<path d="M20 12h2" />
																<path d="m6.34 17.66-1.41 1.41" />
																<path d="m19.07 4.93-1.41 1.41" />
															</svg>
														{/if}
													</div>
													<div class="min-w-0 flex-1">
														<p class="truncate text-sm font-semibold text-[#111827]">
															{weather?.headline ??
																(weatherLoading ? 'Loading local weather' : 'Weather unavailable')}
														</p>
														<p class="mt-1 truncate text-xs text-[#6b7280]">
															{weather?.conditionLabel ??
																(weatherLoading ? 'Checking conditions' : 'Stand by')}
														</p>
													</div>
												</div>

												<div class="mt-3 grid grid-cols-3 gap-2">
													<div class="rounded-[18px] bg-white px-3 py-2.5">
														<p class="text-[10px] tracking-[0.18em] text-[#9ca3af] uppercase">
															Temp
														</p>
														<p class="mt-1 text-sm font-semibold text-[#111827]">
															{weather ? formatTemperature(weather.temperatureC) : '--'}
														</p>
													</div>
													<div class="rounded-[18px] bg-white px-3 py-2.5">
														<p class="text-[10px] tracking-[0.18em] text-[#9ca3af] uppercase">
															Rain
														</p>
														<p class="mt-1 text-sm font-semibold text-[#111827]">
															{weather ? `${weather.precipitationChancePercent}%` : '--'}
														</p>
													</div>
													<div class="rounded-[18px] bg-white px-3 py-2.5">
														<p class="text-[10px] tracking-[0.18em] text-[#9ca3af] uppercase">
															Wind
														</p>
														<p class="mt-1 text-sm font-semibold text-[#111827]">
															{weather ? formatWindSpeed(weather.windSpeedKph) : '--'}
														</p>
													</div>
												</div>

												{#if reportSheetState === 'full'}
													<p class="mt-3 text-sm leading-5 text-[#6b7280]">
														{weatherError
															? weatherError
															: (weather?.recommendation ??
																'Checking whether rain could affect road conditions right now.')}
													</p>
												{/if}
											</div>

											<div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
												{#each INCIDENT_TYPES as incidentType (incidentType)}
													<button
														type="button"
														aria-label={`Report ${REPORT_TYPE_LABELS[incidentType]}`}
														title={REPORT_TYPE_LABELS[incidentType]}
														onclick={() => {
															selectedType = incidentType;
															if (reportSheetState === 'half') {
																void submitIncident(incidentType);
															}
														}}
														disabled={reportSubmitting}
														class={`rounded-[22px] border px-4 py-4 text-left shadow-[0_8px_24px_rgba(15,23,42,0.06)] transition ${
															selectedType === incidentType
																? 'border-[#d97706]/25 bg-[#fff8eb]'
																: 'border-black/6 bg-[#f3f4f6] hover:bg-[#eceef1]'
														} disabled:opacity-50`}
													>
														<div class="flex items-center gap-3">
															<div
																class="flex h-11 w-11 shrink-0 items-center justify-center rounded-[16px] bg-white"
															>
																<IncidentTypeIcon type={incidentType} class="h-6 w-6" />
															</div>
															<div class="min-w-0">
																<p class="text-sm font-semibold text-[#111827]">
																	{REPORT_TYPE_LABELS[incidentType]}
																</p>
																<p class="mt-0.5 text-xs text-[#6b7280]">
																	{INCIDENT_LABELS[incidentType].en}
																</p>
															</div>
														</div>
													</button>
												{/each}
											</div>

											{#if reportSheetState === 'full'}
												<div class="space-y-3">
													<div
														class="rounded-[24px] bg-[#f3f4f6] px-4 py-4 shadow-[inset_0_0_0_1px_rgba(15,23,42,0.05)]"
													>
														<div class="flex items-start justify-between gap-3">
															<div>
																<p class="text-sm font-semibold text-[#111827]">Report details</p>
																<p class="mt-1 text-xs text-[#6b7280]">
																	Add context and choose where this report should be pinned.
																</p>
															</div>
															<div class="flex gap-2">
																<button
																	type="button"
																	onclick={() => {
																		if (currentLocation) setReportLocation(currentLocation, 'gps');
																	}}
																	class="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-[#4b5563]"
																>
																	Use GPS
																</button>
																<button
																	type="button"
																	onclick={() => setReportSheetState('half')}
																	class="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-[#4b5563]"
																>
																	Quick mode
																</button>
															</div>
														</div>
														<div
															class="mt-3 rounded-[18px] bg-white px-3 py-2.5 text-xs text-[#6b7280]"
														>
															{reportLocation
																? `Pinned at ${formatPointLabel(reportLocation)}`
																: currentLocation
																	? 'Using live GPS if you submit now.'
																	: 'Wait for GPS or double-click the map to drop a pin.'}
														</div>
														<label class="mt-3 block">
															<span class="text-[10px] tracking-[0.18em] text-[#9ca3af] uppercase"
																>Note</span
															>
															<textarea
																rows="3"
																bind:value={reportNote}
																placeholder="What is happening here?"
																class="mt-2 w-full rounded-[18px] border border-black/6 bg-white px-3 py-3 text-sm text-[#111827] outline-none placeholder:text-[#9ca3af]"
															></textarea>
														</label>
														<button
															type="button"
															onclick={() => void submitIncident(selectedType)}
															disabled={reportSubmitting}
															class="mt-3 w-full rounded-[20px] bg-[#d97706] px-4 py-3 text-sm font-semibold text-white disabled:bg-[var(--surface-muted)] disabled:text-[var(--muted)]"
														>
															{reportSubmitting
																? 'Sending report...'
																: `Submit ${REPORT_TYPE_LABELS[selectedType]}`}
														</button>
													</div>

													<div
														class="rounded-[24px] bg-[#f3f4f6] px-4 py-4 shadow-[inset_0_0_0_1px_rgba(15,23,42,0.05)]"
													>
														<div class="flex items-center justify-between gap-3">
															<div>
																<p class="text-sm font-semibold text-[#111827]">Recent history</p>
																<p class="mt-1 text-xs text-[#6b7280]">
																	Your last reports and their current status.
																</p>
															</div>
															<span
																class="rounded-full bg-white px-3 py-1 text-xs font-medium text-[#6b7280]"
															>
																{myIncidents.length} total
															</span>
														</div>
														<div class="mt-3 space-y-2">
															{#if myIncidents.length === 0}
																<div
																	class="rounded-[18px] bg-white px-3 py-3 text-sm text-[#6b7280]"
																>
																	No reports yet.
																</div>
															{:else}
																{#each myIncidents.slice(0, 6) as incident (incident._id)}
																	<div
																		class="flex items-center justify-between gap-3 rounded-[18px] bg-white px-3 py-3"
																	>
																		<div class="flex min-w-0 items-center gap-3">
																			<div
																				class="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[#f3f4f6]"
																			>
																				<IncidentTypeIcon type={incident.type} class="h-5 w-5" />
																			</div>
																			<div class="min-w-0">
																				<p class="truncate text-sm font-semibold text-[#111827]">
																					{REPORT_TYPE_LABELS[incident.type]}
																				</p>
																				<p class="mt-0.5 text-xs text-[#6b7280]">
																					{formatShortDate(incident.createdAt)}
																				</p>
																			</div>
																		</div>
																		<span
																			class={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${getIncidentStatusClass(incident.status)}`}
																		>
																			{incident.status === 'active' ? 'Active' : 'Expired'}
																		</span>
																	</div>
																{/each}
															{/if}
														</div>
													</div>
												</div>
											{/if}
										</div>
									{/if}
								</div>
							{:else}
								<div class="pt-4">
									<div class="grid gap-3 sm:grid-cols-3">
										<div
											class="rounded-[24px] border border-black/6 bg-white px-4 py-4 shadow-[0_10px_28px_rgba(17,24,39,0.06)]"
										>
											<div class="flex items-center gap-3">
												<div
													class="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[#f4f4f2] text-[#141414]"
												>
													<svg
														viewBox="0 0 24 24"
														class="h-5 w-5"
														fill="none"
														stroke="currentColor"
														stroke-width="2"
														stroke-linecap="round"
														stroke-linejoin="round"
													>
														<path d="M12 3 4 7v5c0 5 3.4 8.8 8 10 4.6-1.2 8-5 8-10V7l-8-4Z" />
														<path d="m9.5 12 1.8 1.8 3.7-4.3" />
													</svg>
												</div>
												<div>
													<p class="text-[10px] tracking-[0.24em] text-[var(--muted)] uppercase">
														Trust
													</p>
													<p
														class="mt-1 text-2xl font-semibold tracking-[-0.04em] text-[var(--text)]"
													>
														{meQuery.data?.trustScore?.toFixed(1) ?? '2.0'}
													</p>
												</div>
											</div>
										</div>
										<div
											class="rounded-[24px] border border-black/6 bg-white px-4 py-4 shadow-[0_10px_28px_rgba(17,24,39,0.06)]"
										>
											<div class="flex items-center gap-3">
												<div
													class="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[#f4f4f2] text-[#141414]"
												>
													<svg
														viewBox="0 0 24 24"
														class="h-5 w-5"
														fill="none"
														stroke="currentColor"
														stroke-width="2"
														stroke-linecap="round"
														stroke-linejoin="round"
													>
														<path d="M12 3v18" />
														<path d="M3 12h18" />
													</svg>
												</div>
												<div>
													<p class="text-[10px] tracking-[0.24em] text-[var(--muted)] uppercase">
														Reports
													</p>
													<p
														class="mt-1 text-2xl font-semibold tracking-[-0.04em] text-[var(--text)]"
													>
														{meQuery.data?.reportsCount ?? 0}
													</p>
												</div>
											</div>
										</div>
										<div
											class="rounded-[24px] border border-black/6 bg-white px-4 py-4 shadow-[0_10px_28px_rgba(17,24,39,0.06)]"
										>
											<div class="flex items-center gap-3">
												<div
													class="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[#f4f4f2] text-[#141414]"
												>
													<svg
														viewBox="0 0 24 24"
														class="h-5 w-5"
														fill="none"
														stroke="currentColor"
														stroke-width="2"
														stroke-linecap="round"
														stroke-linejoin="round"
													>
														<path d="M5 13l4 4L19 7" />
													</svg>
												</div>
												<div>
													<p class="text-[10px] tracking-[0.24em] text-[var(--muted)] uppercase">
														Confirmed
													</p>
													<p
														class="mt-1 text-2xl font-semibold tracking-[-0.04em] text-[var(--text)]"
													>
														{meQuery.data?.confirmedCount ?? 0}
													</p>
												</div>
											</div>
										</div>
									</div>

									{#if drawerExpanded}
										<div class="mt-4 space-y-3">
											<div
												class="rounded-[24px] border border-black/6 bg-white px-4 py-4 shadow-[0_10px_28px_rgba(17,24,39,0.06)]"
											>
												<div class="flex items-start justify-between gap-3">
													<div class="flex items-center gap-2">
														<span
															class="flex h-9 w-9 items-center justify-center rounded-[12px] bg-[#f4f4f2] text-[#141414]"
														>
															<svg
																viewBox="0 0 24 24"
																class="h-4.5 w-4.5"
																fill="none"
																stroke="currentColor"
																stroke-width="2"
																stroke-linecap="round"
																stroke-linejoin="round"
															>
																<path d="M12 3v18" />
																<path d="M3 12h18" />
																<path d="m18 6 3-3" />
																<path d="m3 21 3-3" />
															</svg>
														</span>
														<div>
															<p class="text-sm font-semibold text-[var(--text)]">
																Route preferences
															</p>
															<p class="text-xs text-[var(--muted)]">Routing and comfort</p>
														</div>
													</div>
													{#if routePreferencesSaving}
														<span
															class="rounded-full border border-black/8 bg-[#f8fafc] px-2.5 py-1 text-[11px] font-medium text-black/56"
														>
															Saving
														</span>
													{/if}
												</div>

												<div class="mt-4 grid gap-3 sm:grid-cols-2">
													<label class="grid gap-1.5">
														<span
															class="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.18em] text-[var(--muted)] uppercase"
														>
															<svg
																viewBox="0 0 24 24"
																class="h-3.5 w-3.5"
																fill="none"
																stroke="currentColor"
																stroke-width="2"
																stroke-linecap="round"
																stroke-linejoin="round"
															>
																<circle cx="12" cy="12" r="8" />
																<path d="M12 8v4l3 3" />
															</svg>
															Mode
														</span>
														<select
															class="rounded-[16px] border border-black/8 bg-white px-3 py-2.5 text-sm text-[#141414] shadow-[0_6px_18px_rgba(17,24,39,0.04)]"
															value={routingPreferences.mode}
															onchange={handleRoutingModeChange}
															disabled={routePreferencesSaving}
														>
															{#each ROUTING_MODES as mode (mode)}
																<option value={mode}>{getRoutingModeLabel(mode)}</option>
															{/each}
														</select>
													</label>

													<label class="grid gap-1.5">
														<span
															class="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.18em] text-[var(--muted)] uppercase"
														>
															<svg
																viewBox="0 0 24 24"
																class="h-3.5 w-3.5"
																fill="none"
																stroke="currentColor"
																stroke-width="2"
																stroke-linecap="round"
																stroke-linejoin="round"
															>
																<path d="M3 6h18" />
																<path d="M7 12h10" />
																<path d="M10 18h4" />
															</svg>
															Cost priority
														</span>
														<select
															class="rounded-[16px] border border-black/8 bg-white px-3 py-2.5 text-sm text-[#141414] shadow-[0_6px_18px_rgba(17,24,39,0.04)]"
															value={routingPreferences.costPriority}
															onchange={handleCostPriorityChange}
															disabled={routePreferencesSaving}
														>
															{#each ROUTING_COST_PRIORITIES as priority (priority)}
																<option value={priority}>{getCostPriorityLabel(priority)}</option>
															{/each}
														</select>
													</label>
												</div>

												<div class="mt-4 grid gap-2 sm:grid-cols-2">
													<button
														type="button"
														onclick={() =>
															void updateRoutingPreferences({
																avoidHighways: !routingPreferences.avoidHighways
															})}
														disabled={routePreferencesSaving}
														class={`flex items-center gap-2 rounded-[18px] border px-3 py-3 text-left text-sm font-semibold ${
															routingPreferences.avoidHighways
																? 'border-[#1e88f7] bg-[#eef6ff] text-[#141414] shadow-[0_10px_24px_rgba(30,136,247,0.12)]'
																: 'border-black/8 bg-white text-black/62 shadow-[0_8px_24px_rgba(17,24,39,0.05)]'
														}`}
													>
														<svg
															viewBox="0 0 24 24"
															class="h-4 w-4 shrink-0"
															fill="none"
															stroke="currentColor"
															stroke-width="2"
															stroke-linecap="round"
															stroke-linejoin="round"
														>
															<path d="M4 18h16" />
															<path d="M6 18V8l4-2 4 2 4-2v12" />
														</svg>
														Avoid highways
													</button>
													<button
														type="button"
														onclick={() =>
															void updateRoutingPreferences({
																avoidUTurns: !routingPreferences.avoidUTurns
															})}
														disabled={routePreferencesSaving}
														class={`flex items-center gap-2 rounded-[18px] border px-3 py-3 text-left text-sm font-semibold ${
															routingPreferences.avoidUTurns
																? 'border-[#1e88f7] bg-[#eef6ff] text-[#141414] shadow-[0_10px_24px_rgba(30,136,247,0.12)]'
																: 'border-black/8 bg-white text-black/62 shadow-[0_8px_24px_rgba(17,24,39,0.05)]'
														}`}
													>
														<svg
															viewBox="0 0 24 24"
															class="h-4 w-4 shrink-0"
															fill="none"
															stroke="currentColor"
															stroke-width="2"
															stroke-linecap="round"
															stroke-linejoin="round"
														>
															<path d="M8 7v6a4 4 0 0 0 4 4h6" />
															<path d="m14 13 4 4-4 4" />
														</svg>
														Avoid U-turns
													</button>
													<button
														type="button"
														onclick={() =>
															void updateRoutingPreferences({
																preferWellLitStreets: !routingPreferences.preferWellLitStreets
															})}
														disabled={routePreferencesSaving}
														class={`flex items-center gap-2 rounded-[18px] border px-3 py-3 text-left text-sm font-semibold ${
															routingPreferences.preferWellLitStreets
																? 'border-[#1e88f7] bg-[#eef6ff] text-[#141414] shadow-[0_10px_24px_rgba(30,136,247,0.12)]'
																: 'border-black/8 bg-white text-black/62 shadow-[0_8px_24px_rgba(17,24,39,0.05)]'
														}`}
													>
														<svg
															viewBox="0 0 24 24"
															class="h-4 w-4 shrink-0"
															fill="none"
															stroke="currentColor"
															stroke-width="2"
															stroke-linecap="round"
															stroke-linejoin="round"
														>
															<path d="M12 3v3" />
															<path d="M18.4 5.6 16.2 7.8" />
															<path d="M21 12h-3" />
															<path d="m18.4 18.4-2.2-2.2" />
															<path d="M12 21v-3" />
															<path d="m5.6 18.4 2.2-2.2" />
															<path d="M3 12h3" />
															<path d="m5.6 5.6 2.2 2.2" />
															<circle cx="12" cy="12" r="3" />
														</svg>
														Prefer lit streets
													</button>
													<button
														type="button"
														onclick={() =>
															void updateRoutingPreferences({
																preferFewerTurns: !routingPreferences.preferFewerTurns
															})}
														disabled={routePreferencesSaving}
														class={`flex items-center gap-2 rounded-[18px] border px-3 py-3 text-left text-sm font-semibold ${
															routingPreferences.preferFewerTurns
																? 'border-[#1e88f7] bg-[#eef6ff] text-[#141414] shadow-[0_10px_24px_rgba(30,136,247,0.12)]'
																: 'border-black/8 bg-white text-black/62 shadow-[0_8px_24px_rgba(17,24,39,0.05)]'
														}`}
													>
														<svg
															viewBox="0 0 24 24"
															class="h-4 w-4 shrink-0"
															fill="none"
															stroke="currentColor"
															stroke-width="2"
															stroke-linecap="round"
															stroke-linejoin="round"
														>
															<path d="M5 19V9a4 4 0 0 1 4-4h10" />
															<path d="m15 3 4 2-4 2" />
														</svg>
														Prefer fewer turns
													</button>
												</div>

												{#if routePreferencesError}
													<div
														class="mt-3 rounded-[16px] border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-xs font-medium text-[var(--danger)]"
													>
														{routePreferencesError}
													</div>
												{/if}
											</div>

											{#if myIncidents.length === 0}
												<div
													class="flex items-center gap-3 rounded-[24px] border border-black/6 bg-white px-4 py-4 text-sm text-black/60 shadow-[0_10px_28px_rgba(17,24,39,0.06)]"
												>
													<span
														class="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[#f4f4f2] text-[#141414]"
													>
														<svg
															viewBox="0 0 24 24"
															class="h-5 w-5"
															fill="none"
															stroke="currentColor"
															stroke-width="2"
															stroke-linecap="round"
															stroke-linejoin="round"
														>
															<path d="M4 19h16" />
															<path d="M7 16V9" />
															<path d="M12 16V5" />
															<path d="M17 16v-3" />
														</svg>
													</span>
													<p>No reports yet.</p>
												</div>
											{:else}
												<div
													class="overflow-hidden rounded-[24px] border border-black/6 bg-white shadow-[0_10px_28px_rgba(17,24,39,0.06)]"
												>
													<div class="border-b border-black/6 px-4 py-3">
														<p class="text-sm font-semibold text-[#141414]">Recent reports</p>
													</div>
													<div class="divide-y divide-black/6">
														{#each myIncidents.slice(0, 3) as incident (incident._id)}
															<div class="flex items-center justify-between gap-3 px-4 py-3">
																<div class="min-w-0">
																	<p class="truncate text-sm font-medium text-[#141414]">
																		{INCIDENT_LABELS[incident.type].en}
																	</p>
																	<p class="text-sm text-black/56">
																		{formatShortDate(incident.createdAt)}
																	</p>
																</div>
																<span
																	class={`shrink-0 px-2 py-1 text-[11px] font-semibold ${getIncidentStatusClass(incident.status)}`}
																>
																	{incident.status === 'active' ? 'Active' : 'Expired'}
																</span>
															</div>
														{/each}
													</div>
												</div>
											{/if}
										</div>
									{/if}
								</div>
							{/if}
						</div>
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}
