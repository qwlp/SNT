<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onDestroy } from 'svelte';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { makeFunctionReference, type FunctionReference } from 'convex/server';
	import MapSurface from '$lib/components/MapSurface.svelte';
	import IncidentTypeIcon from '$lib/components/IncidentTypeIcon.svelte';
	import { getClerkContext } from '$lib/stores/clerk.svelte';
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
	import {
		planRankedRoutes,
		type RankedClientRouteResult,
		type TrafficLevel
	} from '$lib/services/route-planner';
	import { api } from '../../convex/_generated/api';
	import type { Id } from '../../convex/_generated/dataModel';

	type AppTab = 'pulse' | 'route' | 'account';
	type DockHref = '/app?tab=pulse' | '/app?tab=route' | '/app?tab=account' | '/app/proof';
	type TripSyncMode = 'remote' | 'local';
	type RouteResponse = RankedClientRouteResult;
	type StoredRouteOption = {
		routeId: string;
		providerRouteId?: string;
		label: string;
		geometry: GeoPoint[];
		distanceMeters: number;
		durationSec: number;
		adjustedScore: number;
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

	const dockItems: Array<{ id: AppTab | 'proof'; label: string; href: DockHref }> = [
		{ id: 'pulse', label: 'Report', href: '/app?tab=pulse' },
		{ id: 'route', label: 'Route', href: '/app?tab=route' },
		{ id: 'account', label: 'Account', href: '/app?tab=account' },
		{ id: 'proof', label: 'Proof', href: '/app/proof' }
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
		if (level === 'severe') return 'bg-[#ff4d4f] text-white';
		if (level === 'heavy') return 'bg-[#ff8f1f] text-[#1b1406]';
		if (level === 'moderate') return 'bg-[#ffd45a] text-[#1f1702]';
		if (level === 'light') return 'bg-[#89e77b] text-[#0f1a0a]';
		return 'bg-[#7dd3fc] text-[#07161f]';
	};
	const getTrafficLabel = (level: TrafficLevel) => {
		if (level === 'severe') return 'Severe';
		if (level === 'heavy') return 'Heavy';
		if (level === 'moderate') return 'Moderate';
		if (level === 'light') return 'Light';
		return 'Clear';
	};
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
		routeLoading = false;
		routeResult = null;
		selectedRouteId = null;
		routeMessage = null;
		routeError = null;
		tripError = null;
		tripMessage = null;
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
	let tripStatus = $state<'idle' | 'tracking' | 'completed'>('idle');
	let tripBusy = $state<'starting' | 'arriving' | null>(null);
	let tripMessage = $state<string | null>(null);
	let tripError = $state<string | null>(null);
	let selectedRouteId = $state<string | null>(null);
	let locationInterval = $state<number | null>(null);
	let drawerExpanded = $state(true);
	let routeRequestId = $state(0);
	let profileSyncRequest: Promise<unknown> | null = null;

	const activeTab = $derived.by((): AppTab => {
		const tab = page.url.searchParams.get('tab');
		if (tab === 'route' || tab === 'account') return tab;
		return 'pulse';
	});

	const incidents = $derived(incidentsQuery.data ?? []);
	const myIncidents = $derived(myIncidentsQuery.data ?? []);
	const shortcuts = $derived(shortcutsQuery.data ?? []);
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
		navigationRoute ? formatNavDistance(navigationRoute.navigationCue.distanceMeters) : 'Pin route'
	);
	const nextArrivalLabel = $derived(
		navigationRoute ? formatArrivalTime(navigationRoute.arrivalTime) : '--:--'
	);
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
				: 'Double-click anywhere on the map to pin a destination.')
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
		tripMessage = `Trip started to ${target.label}. Cloud sync is unavailable, so tracking is local on this device.`;
	};

	const planRoute = async (target = routeDestination) => {
		if (!target) {
			routeError = 'Double-click anywhere on the map to choose a destination first.';
			routeSheetOpen = true;
			return;
		}

		const requestId = routeRequestId + 1;
		routeRequestId = requestId;
		routeLoading = true;
		routeError = null;
		routeMessage = null;
		tripError = null;

		try {
			const result = await planRankedRoutes({
				origin: currentLocation ?? PHNOM_PENH_CENTER,
				destination: target.point,
				incidents,
				shortcuts
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
			if (requestId === routeRequestId) {
				routeLoading = false;
			}
		}
	};

	const beginTrip = async () => {
		if (tripStatus === 'tracking' || tripBusy) return;
		if (!selectedRoute) {
			tripError = 'Choose a route first.';
			return;
		}
		if (!routeDestination) {
			tripError = 'Double-click on the map to pin where you are going first.';
			routeSheetOpen = true;
			return;
		}

		tripBusy = 'starting';
		tripError = null;
		tripMessage = null;
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
				tripStatus = 'completed';
				tripMessage = `Trip completed for ${activeTrip.destinationName}. Local-only tracking was used because cloud sync was unavailable.`;
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
			tripStatus = 'completed';
			tripMessage = `Trip completed for ${activeTrip.destinationName}.`;
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
			drawerExpanded = true;
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
			drawerExpanded = false;
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
		drawerExpanded = true;
	};

	const pickReportLocationFromMap = (point: GeoPoint) => {
		setReportLocation(point, 'pin');
	};

	const pickDestinationFromMap = (point: GeoPoint) => {
		const nextDestination = setRouteDestination(point);
		if (!nextDestination) return;

		void planRoute(nextDestination);
	};

	const choosePresetDestination = (university: UniversitySeed) => {
		const nextDestination = setRouteDestination(university.campus, {
			label: university.shortName,
			detail: university.name,
			presetId: university.id
		});
		if (!nextDestination) return;

		void planRoute(nextDestination);
	};

	$effect(() => {
		if (!clerkContext.currentUser) {
			reportFeedback = null;
			reportError = null;
			reportLocation = null;
			reportLocationMode = null;
			routeDestination = null;
			routeSheetOpen = false;
			routeResult = null;
			routeMessage = null;
			routeError = null;
			tripMessage = null;
			tripError = null;
			selectedRouteId = null;
			activeTripId = null;
			activeTrip = null;
			activeTripSyncMode = 'remote';
			tripStatus = 'idle';
			stopTripSampling();
			return;
		}

		if (meQuery.data || profileSyncRequest) {
			return;
		}

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
				currentLocation = PHNOM_PENH_CENTER;
			},
			{
				enableHighAccuracy: true,
				maximumAge: 30_000
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

	onDestroy(() => {
		stopTripSampling();
	});
</script>

{#if !isSignedIn}
	<div class="relative min-h-[100svh] overflow-hidden bg-[#0f1115] text-white">
		<div
			class="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(60,86,95,0.55),_transparent_34%),radial-gradient(circle_at_top_right,_rgba(194,82,48,0.34),_transparent_24%),linear-gradient(180deg,_#14181f_0%,_#0b0d11_100%)]"
		></div>
		<div
			class="absolute inset-0 [background-image:linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] [background-size:36px_36px] opacity-35"
		></div>
		<div class="relative mx-auto flex min-h-[100svh] max-w-md items-center px-5 py-10">
			<div
				class="w-full rounded-[32px] border border-white/10 bg-[rgba(10,12,16,0.78)] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.38)] backdrop-blur-xl"
			>
				<p class="text-xs font-medium tracking-[0.32em] text-white/45 uppercase">SNT Live</p>
				<h1 class="mt-3 text-4xl font-semibold tracking-[-0.04em]">Traffic tools on one map.</h1>
				<p class="mt-3 text-sm leading-6 text-white/70">
					Sign in to submit reports, plan routes, track trips, and issue delay proof.
				</p>
				<div
					class="mt-6"
					{@attach (element) => {
						clerkContext.clerk.mountSignIn(element, {});
					}}
				></div>
			</div>
		</div>
	</div>
{:else}
	<div class="relative h-[100svh] overflow-hidden bg-[#0b0d11] text-white">
		<div class="absolute inset-0">
			<MapSurface
				{currentLocation}
				{incidents}
				routes={routeOptions}
				trackedRoute={tripStatus === 'tracking' ? (navigationRoute?.geometry ?? null) : null}
				destination={activeTab === 'pulse' ? reportLocation : currentRouteDestination}
				destinationLabel={activeTab === 'pulse'
					? reportLocationMode === 'gps'
						? 'Live report location'
						: 'Report pin'
					: currentRouteDestinationLabel}
				destinationTone={activeTab === 'pulse' ? 'report' : 'destination'}
				destinationMoveHint={activeTab === 'pulse'
					? 'Double-click again anywhere to move this report pin.'
					: 'Double-click again anywhere to move this destination.'}
				liveNavigation={tripStatus === 'tracking'}
				activeRouteStyle={tripStatus === 'tracking' ? 'navigation' : 'traffic'}
				activeRouteId={tripStatus === 'tracking'
					? (activeTrip?.routeId ?? selectedRouteId)
					: selectedRouteId}
				focusPoints={activeTab === 'pulse' ? reportFocusPoints : []}
				fullscreen={true}
				showHeader={false}
				onRouteSelect={selectRoute}
				onDestinationPick={activeTab === 'route'
					? pickDestinationFromMap
					: activeTab === 'pulse'
						? pickReportLocationFromMap
						: undefined}
			/>
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
						class="rounded-full border border-[var(--border)] bg-[rgba(255,253,248,0.96)] p-1 shadow-[0_18px_48px_rgba(36,31,23,0.16)] backdrop-blur-xl sm:[&_button]:scale-110 sm:[&_button]:transform-gpu sm:[&_button]:transition-transform"
						{@attach (element) => {
							clerkContext.clerk.mountUserButton(element);
						}}
					></div>
				</div>
			</div>
		</div>

		{#if activeTab === 'route' && showRouteHud}
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
								class="pointer-events-auto rounded-[24px] border border-black/8 bg-[rgba(248,248,246,0.98)] px-3 py-3 text-[#161616] shadow-[0_14px_36px_rgba(0,0,0,0.14)] backdrop-blur-2xl"
							>
								<div class="flex items-center gap-3">
									<div
										class="flex h-12 w-12 shrink-0 items-center justify-center rounded-[16px] border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
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
													class="text-[2.25rem] leading-none font-semibold tracking-[-0.08em] text-[#121212]"
												>
													{navigationRoute ? nextCueDistanceLabel : '--'}
												</p>
												<p
													class="mt-1 truncate text-base font-semibold tracking-[-0.04em] text-black/80"
												>
													{navigationRoadLabel}
												</p>
											</div>

											<div class="shrink-0 space-y-1.5 text-right">
												<span
													class={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${
														navigationRoute
															? getTrafficBadgeClass(navigationRoute.trafficLevel)
															: 'bg-black/8 text-black/60'
													}`}
												>
													{navigationRoute ? getTrafficLabel(navigationRoute.trafficLevel) : 'Live'}
												</span>
												<p class="text-[12px] font-medium text-black/56">{nextArrivalLabel}</p>
											</div>
										</div>
										<div class="mt-2 flex items-center gap-2 text-[12px] text-black/54">
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
								class="pointer-events-auto rounded-[26px] border border-black/8 bg-[rgba(248,248,246,0.98)] px-3.5 pt-2.5 pb-[calc(env(safe-area-inset-bottom,0px)+10px)] text-[#161616] shadow-[0_-14px_36px_rgba(0,0,0,0.14)] backdrop-blur-2xl"
							>
								<div class="mx-auto h-1.5 w-12 rounded-full bg-black/10"></div>

								<div class="mt-3 flex items-center justify-between gap-3">
									<div class="min-w-0">
										<p
											class="truncate text-[1.2rem] leading-none font-semibold tracking-[-0.05em] text-[#161616]"
										>
											{currentRouteDestinationLabel}
										</p>
										<p class="mt-1 text-sm leading-5 text-black/54">{routeDistanceLabel}</p>
									</div>
									{#if activeTripSyncMode === 'local'}
										<span
											class="shrink-0 rounded-full border border-black/8 bg-white px-2.5 py-1 text-[10px] font-medium text-black/58"
										>
											Local only
										</span>
									{/if}
								</div>

								{#if tripError}
									<div
										class="mt-3 rounded-[16px] border border-[#f1b7a4] bg-[#fff0eb] px-3 py-2.5 text-sm text-[#7d2c1d]"
									>
										{tripError}
									</div>
								{/if}

								<button
									type="button"
									onclick={markArrived}
									disabled={tripStatus !== 'tracking' || tripBusy !== null}
									class="mt-3 w-full rounded-[22px] bg-[var(--primary)] px-4 py-3.5 text-base font-semibold text-white shadow-[0_14px_30px_rgba(90,66,41,0.22)] hover:bg-[#5a4229] disabled:opacity-50"
								>
									{tripBusy === 'arriving' ? 'Saving arrival...' : 'Mark arrived'}
								</button>
							</div>
						</div>

						<div
							class="hidden h-full flex-col justify-between px-3 pt-[calc(env(safe-area-inset-top,0px)+10px)] pb-[calc(env(safe-area-inset-bottom,0px)+12px)] sm:flex lg:px-5 xl:px-6"
						>
							<div class="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
								<div
									class="pointer-events-auto flex min-w-0 items-start gap-4 rounded-[32px] border border-[var(--border)] bg-[rgba(255,253,248,0.96)] px-5 py-5 text-[var(--text)] shadow-[0_28px_72px_rgba(36,31,23,0.18)] backdrop-blur-2xl"
								>
									<div
										class="flex h-24 w-24 shrink-0 items-center justify-center rounded-[28px] bg-[var(--surface-muted)] text-[var(--text)]"
									>
										{#if currentCueModifier === 'left' || currentCueModifier === 'slight left' || currentCueModifier === 'sharp left'}
											<svg
												viewBox="0 0 24 24"
												class="h-12 w-12"
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
												class="h-12 w-12"
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
												class="h-12 w-12"
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
												class="h-12 w-12"
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
												class="h-12 w-12"
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
														class="text-4xl font-semibold tracking-[-0.06em] text-[var(--text)] sm:text-5xl lg:text-6xl"
													>
														{navigationRoute ? nextCueDistanceLabel : '--'}
													</p>
													<span
														class={`inline-flex items-center rounded-full px-3 py-1.5 text-xs font-semibold sm:text-sm ${
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
													class="mt-2 truncate text-[1.6rem] font-semibold tracking-[-0.05em] text-[var(--primary)] sm:text-[2rem]"
												>
													{navigationRoadLabel}
												</p>
											</div>
										</div>

										<p
											class="mt-3 max-w-[52rem] text-base leading-7 text-[var(--muted)] lg:text-lg"
										>
											{navigationInstruction}
										</p>
									</div>
								</div>

								<div class="pointer-events-auto grid gap-3">
									<div
										class="rounded-[26px] border border-[var(--border)] bg-[rgba(255,253,248,0.96)] px-4 py-3.5 text-[var(--text)] shadow-[0_20px_48px_rgba(36,31,23,0.16)] backdrop-blur-2xl"
									>
										<div class="flex items-center gap-3">
											<div
												class="flex h-11 w-11 shrink-0 items-center justify-center rounded-[16px] bg-[var(--surface-muted)] text-[var(--primary)]"
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
												<p class="mt-1 text-2xl font-semibold text-[var(--text)]">
													{nextArrivalLabel}
												</p>
											</div>
										</div>
									</div>

									<div
										class="rounded-[26px] border border-[var(--border)] bg-[rgba(255,253,248,0.96)] px-4 py-3.5 text-[var(--text)] shadow-[0_20px_48px_rgba(36,31,23,0.16)] backdrop-blur-2xl"
									>
										<div class="flex items-center gap-3">
											<div
												class="flex h-11 w-11 shrink-0 items-center justify-center rounded-[16px] bg-[var(--surface-muted)] text-[var(--primary)]"
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
												<p class="mt-1 text-2xl font-semibold text-[var(--text)]">
													{navigationRoute ? formatMinutes(navigationRoute.durationSec) : '--'}
												</p>
											</div>
										</div>
									</div>

									<div
										class="rounded-[26px] border border-[var(--border)] bg-[rgba(255,253,248,0.96)] px-4 py-3.5 text-[var(--text)] shadow-[0_20px_48px_rgba(36,31,23,0.16)] backdrop-blur-2xl"
									>
										<div class="flex items-start gap-3">
											<div
												class="flex h-11 w-11 shrink-0 items-center justify-center rounded-[16px] bg-[var(--surface-muted)] text-[var(--primary)]"
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
												<p class="mt-1 text-base font-semibold text-[var(--text)]">
													{navigationRoute?.trafficSummary ?? 'Live route'}
												</p>
											</div>
										</div>
									</div>
								</div>
							</div>

							<div class="pointer-events-none flex-1"></div>

							<div
								class="grid items-end gap-4 lg:grid-cols-[minmax(0,480px)_minmax(300px,380px)] lg:justify-between"
							>
								<div class="pointer-events-auto space-y-3">
									<div
										class="rounded-[28px] border border-[var(--border)] bg-[rgba(255,253,248,0.96)] px-5 py-4 text-[var(--text)] shadow-[0_24px_60px_rgba(36,31,23,0.16)] backdrop-blur-2xl"
									>
										<div class="flex items-start gap-3">
											<div
												class="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-[16px] bg-[var(--surface-muted)] text-[var(--primary)]"
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
													class="mt-1 text-2xl font-semibold tracking-[-0.04em] text-[var(--text)]"
												>
													{activeRouteLabel}
												</p>
												<div
													class="mt-3 flex flex-wrap items-center gap-3 text-sm text-[var(--muted)]"
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
													{#if activeTripSyncMode === 'local'}
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
																<path d="M4 7h16" />
																<path d="M7 12h10" />
																<path d="M10 17h4" />
															</svg>
															Local only
														</span>
													{/if}
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
									{#if tripMessage}
										<div
											class="rounded-[20px] border border-[var(--accent-soft)] bg-[var(--accent-soft)] px-4 py-3 text-sm text-[var(--accent)]"
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
													<path d="M4 12h16" />
													<path d="m13 5 7 7-7 7" />
												</svg>
												<span>{tripMessage}</span>
											</div>
										</div>
									{/if}
								</div>

								<div
									class="pointer-events-auto flex flex-col items-stretch gap-3 lg:justify-self-end"
								>
									<div class="flex flex-wrap justify-end gap-2">
										<span
											class="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[rgba(255,253,248,0.96)] px-3.5 py-2 text-xs font-medium text-[var(--muted)] shadow-[0_12px_28px_rgba(36,31,23,0.1)] backdrop-blur-xl"
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
											class="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[rgba(255,253,248,0.96)] px-3.5 py-2 text-xs font-medium text-[var(--muted)] shadow-[0_12px_28px_rgba(36,31,23,0.1)] backdrop-blur-xl"
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
										class="flex min-w-[240px] items-center justify-center gap-3 self-end rounded-[26px] bg-[var(--primary)] px-6 py-5 text-lg font-semibold text-white shadow-[0_24px_64px_rgba(90,66,41,0.24)] backdrop-blur-2xl hover:bg-[#5a4229] disabled:opacity-50"
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
								class="pointer-events-auto relative w-full max-w-[320px] rounded-[24px] border border-black/8 bg-[rgba(248,248,246,0.96)] px-4 py-3 text-[#141414] shadow-[0_16px_40px_rgba(0,0,0,0.18)] backdrop-blur-2xl"
							>
								<div class="absolute top-3 right-4 flex items-center gap-2">
									<span
										class={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
											navigationRoute
												? getTrafficBadgeClass(navigationRoute.trafficLevel)
												: 'bg-black/8 text-black/60'
										}`}
									>
										{navigationRoute ? getTrafficLabel(navigationRoute.trafficLevel) : 'Standby'}
									</span>

									<button
										type="button"
										onclick={clearRoutePlan}
										class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] shadow-[0_10px_24px_rgba(36,31,23,0.08)]"
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

								<p class="pr-[8.5rem] text-[1.05rem] leading-7 font-medium text-black/68">
									{navigationRoute?.navigationCue.instruction ??
										'Touch and hold anywhere on the map to move this pin.'}
								</p>

								<div class="mt-2.5 flex flex-wrap gap-2">
									<span
										class="rounded-full border border-black/8 bg-[#f5f5f2] px-3 py-1.5 text-[12px] font-medium text-black/64"
									>
										{routeDistanceLabel}
									</span>
									<span
										class="rounded-full border border-black/8 bg-[#f5f5f2] px-3 py-1.5 text-[12px] font-medium text-black/64"
									>
										Arrive {nextArrivalLabel}
									</span>
									{#if selectedRoute}
										<span
											class="rounded-full border border-black/8 bg-[#f5f5f2] px-3 py-1.5 text-[12px] font-medium text-black/64"
										>
											{formatMinutes(selectedRoute.durationSec)}
										</span>
									{/if}
								</div>

								{#if mobileRouteBanner}
									<div
										class={`mt-3 line-clamp-2 rounded-[16px] border px-3 py-2 text-[12px] leading-5 ${getMobileRouteBannerClass(mobileRouteBanner.tone)}`}
									>
										{mobileRouteBanner.message}
									</div>
								{/if}
							</div>

							<div
								class="pointer-events-auto rounded-[28px] border border-black/8 bg-[rgba(248,248,246,0.98)] px-4 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)] text-[#141414] shadow-[0_-18px_48px_rgba(0,0,0,0.2)] backdrop-blur-2xl"
							>
								<div class="mx-auto h-1.5 w-12 rounded-full bg-black/10"></div>

								<div class="mt-3">
									{#if routeLoading}
										<div class="grid grid-cols-3 gap-2">
											{#each [0, 1, 2] as loadingCard (loadingCard)}
												<div class="rounded-[18px] bg-[#f3f4f6] px-3 py-3">
													<div class="h-3 w-16 rounded-full bg-black/8"></div>
													<div class="mt-3 h-5 w-10 rounded-full bg-black/8"></div>
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
													class={`rounded-[20px] border px-3 py-3 text-left transition ${
														selectedRouteId === route.routeId
															? 'border-[var(--border-strong)] bg-[var(--primary-soft)] shadow-[0_10px_24px_rgba(90,66,41,0.1)]'
															: 'border-black/8 bg-[#f8f8f6]'
													}`}
												>
													<p
														class="line-clamp-2 text-[13px] leading-4 font-semibold text-[#171717]"
													>
														{route.label}
													</p>
													<p class="mt-2 text-[15px] leading-none font-semibold text-[#171717]">
														{formatMinutes(route.durationSec)}
													</p>
													<div class="mt-2 flex items-end justify-between gap-2">
														<p class="text-[11px] text-black/46">
															{formatDistance(route.distanceMeters)}
														</p>
														<span
															class={`rounded-full px-2 py-1 text-[10px] font-semibold ${getTrafficBadgeClass(route.trafficLevel)}`}
														>
															{getTrafficLabel(route.trafficLevel)}
														</span>
													</div>
												</button>
											{/each}
										</div>
									{:else}
										<div
											class="rounded-[18px] border border-dashed border-black/10 bg-[#f8f8f6] px-3.5 py-3 text-[13px] leading-5 text-black/56"
										>
											Refresh to load routes, or move the pin slightly.
										</div>
									{/if}
								</div>

								<div class="mt-3 grid grid-cols-[72px_92px_minmax(0,1fr)] gap-2">
									<button
										type="button"
										onclick={clearRoutePlan}
										class="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm font-semibold text-[var(--muted)]"
									>
										Later
									</button>
									<button
										type="button"
										onclick={() => void planRoute()}
										disabled={!routeDestination || routeLoading}
										class="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm font-semibold text-[var(--muted)] disabled:opacity-50"
									>
										Refresh
									</button>
									<button
										type="button"
										onclick={beginTrip}
										disabled={!selectedRoute || tripBusy !== null}
										class="rounded-full bg-[var(--primary)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#5a4229] disabled:opacity-50"
									>
										{tripBusy === 'starting' ? 'Starting...' : 'Go'}
									</button>
								</div>
							</div>
						</div>

						<div
							class="hidden h-full gap-2 lg:grid lg:grid-cols-[248px_minmax(0,1fr)_300px] lg:items-start"
						>
							<div
								class="pointer-events-auto self-start rounded-[22px] border border-[var(--border)] bg-[rgba(255,253,248,0.96)] p-3 text-[var(--text)] shadow-[0_20px_54px_rgba(36,31,23,0.14)] backdrop-blur-2xl"
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
							</div>

							<div class="pointer-events-auto lg:self-start lg:justify-self-center">
								<div
									class="mx-auto w-full max-w-[560px] rounded-[24px] border border-[var(--border)] bg-[rgba(255,253,248,0.96)] px-3.5 py-3 text-[var(--text)] shadow-[0_24px_68px_rgba(36,31,23,0.16)] backdrop-blur-2xl"
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
								class="pointer-events-auto hidden max-h-[calc(100svh-220px)] overflow-hidden rounded-[22px] border border-[var(--border)] bg-[rgba(255,253,248,0.96)] text-[var(--text)] shadow-[0_24px_68px_rgba(36,31,23,0.16)] backdrop-blur-2xl lg:block"
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
											Double-click to pin.
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
								{#if routeMessage}
									<div
										class="rounded-[20px] border border-[var(--border)] bg-[var(--primary-soft)] px-4 py-3 text-sm text-[var(--text)]"
									>
										{routeMessage}
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
									class="mx-auto flex w-full max-w-[380px] items-center gap-2 rounded-full border border-[var(--border)] bg-[rgba(255,253,248,0.96)] p-2 text-[var(--text)] shadow-[0_20px_54px_rgba(36,31,23,0.16)] backdrop-blur-2xl"
								>
									<button
										type="button"
										onclick={clearRoutePlan}
										class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:border-[var(--border-strong)] hover:bg-[var(--primary-soft)]"
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
										class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:border-[var(--border-strong)] hover:bg-[var(--primary-soft)] disabled:opacity-50"
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
									<button
										type="button"
										onclick={beginTrip}
										disabled={!selectedRoute || tripBusy !== null}
										class="flex-1 rounded-full bg-[var(--primary)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#5a4229] disabled:opacity-50"
									>
										{tripBusy === 'starting' ? 'Starting...' : 'Start trip'}
									</button>
								</div>
							</div>
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<div
			class={`pointer-events-none absolute inset-x-0 bottom-0 z-30 px-3 pb-3 sm:px-2 sm:pb-3 ${
				activeTab === 'route' && tripStatus === 'tracking'
					? 'hidden'
					: activeTab === 'route' && showRouteHud
						? 'hidden sm:block'
						: ''
			}`}
		>
			<div
				class="mx-auto flex max-w-[1440px] flex-col items-center gap-3 sm:mx-0 sm:max-w-none lg:items-start"
			>
				<div
					class="pointer-events-auto rounded-full border border-[var(--border)] bg-[rgba(255,253,248,0.96)] p-1 shadow-[0_24px_64px_rgba(36,31,23,0.16)] backdrop-blur-2xl"
				>
					<div class="flex items-center gap-1">
						{#each dockItems as item (item.id)}
							<a
								href={resolve(item.href)}
								aria-current={activeTab === item.id ? 'page' : undefined}
								class={`rounded-full px-4 py-2.5 text-sm font-medium ${
									activeTab === item.id
										? 'bg-[var(--surface-muted)] text-[var(--text)]'
										: 'text-[var(--muted)] hover:bg-[var(--primary-soft)]'
								}`}
							>
								{item.label}
							</a>
						{/each}
					</div>
				</div>

				{#if activeTab === 'route'}
					<div class="hidden">
						{#if routeSheetOpen || tripStatus === 'tracking'}
							<div
								class="overflow-hidden rounded-[32px] border border-white/10 bg-[rgba(11,13,17,0.9)] shadow-[0_28px_80px_rgba(0,0,0,0.42)] backdrop-blur-2xl"
							>
								<div
									class="border-b border-white/8 bg-[linear-gradient(180deg,rgba(10,14,20,0.96)_0%,rgba(7,9,13,0.9)_100%)] p-4"
								>
									<div class="flex items-start justify-between gap-3">
										<div class="min-w-0">
											<p class="text-[10px] tracking-[0.28em] text-white/40 uppercase">
												Plan and track
											</p>
											<p class="mt-2 truncate text-2xl font-semibold tracking-[-0.04em] text-white">
												{currentRouteDestinationLabel}
											</p>
											<p class="mt-1 text-sm text-white/58">{currentRouteDestinationDetail}</p>
										</div>
										<div class="flex shrink-0 items-center gap-2">
											<span
												class={`rounded-full px-3 py-1 text-xs font-semibold ${
													navigationRoute
														? getTrafficBadgeClass(navigationRoute.trafficLevel)
														: 'bg-white/10 text-white/72'
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
													class="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-white/74 hover:bg-white/[0.08]"
												>
													Hide
												</button>
											{/if}
										</div>
									</div>

									<div class="mt-4 rounded-[28px] border border-white/8 bg-black/35 p-4">
										<div class="flex items-center gap-4">
											<div
												class="flex h-16 w-16 shrink-0 items-center justify-center rounded-[22px] bg-white text-black"
											>
												{#if tripStatus === 'tracking'}
													<svg
														viewBox="0 0 24 24"
														class="h-9 w-9"
														fill="none"
														stroke="currentColor"
														stroke-width="2.5"
														stroke-linecap="round"
														stroke-linejoin="round"
													>
														<path d="M12 19V5" />
														<path d="m7 10 5-5 5 5" />
													</svg>
												{:else}
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
												{/if}
											</div>

											<div class="min-w-0">
												<p class="text-[10px] tracking-[0.28em] text-white/38 uppercase">
													{tripStatus === 'tracking' ? 'Live traffic route' : 'Pinned destination'}
												</p>
												<p class="mt-1 text-2xl font-semibold tracking-[-0.04em] text-white">
													{navigationRoute ? nextCueDistanceLabel : 'Ready to plan'}
												</p>
												<p class="truncate text-base font-medium text-[#55c6ff]">
													{navigationRoute?.navigationCue.roadName ?? currentRouteDestinationLabel}
												</p>
											</div>
										</div>

										<p class="mt-4 text-sm leading-6 text-white/72">
											{navigationRoute?.navigationCue.instruction ??
												'Double-click anywhere on the map to move this pin. Traffic-aware routes load automatically.'}
										</p>

										<div class="mt-4 grid grid-cols-3 gap-2">
											<div class="rounded-[18px] border border-white/8 bg-white/[0.04] px-3 py-3">
												<p class="text-[10px] tracking-[0.24em] text-white/38 uppercase">ETA</p>
												<p class="mt-1 text-lg font-semibold text-white">{nextArrivalLabel}</p>
											</div>
											<div class="rounded-[18px] border border-white/8 bg-white/[0.04] px-3 py-3">
												<p class="text-[10px] tracking-[0.24em] text-white/38 uppercase">Trip</p>
												<p class="mt-1 text-lg font-semibold text-white">
													{navigationRoute ? formatMinutes(navigationRoute.durationSec) : '--'}
												</p>
											</div>
											<div class="rounded-[18px] border border-white/8 bg-white/[0.04] px-3 py-3">
												<p class="text-[10px] tracking-[0.24em] text-white/38 uppercase">Traffic</p>
												<p class="mt-1 truncate text-sm font-semibold text-white">
													{navigationRoute?.trafficSummary ?? 'Planning'}
												</p>
											</div>
										</div>
									</div>
								</div>

								<div class="space-y-3 p-4">
									<div class="flex flex-wrap gap-2">
										{#each UNIVERSITY_SEEDS as university (university.id)}
											<button
												type="button"
												onclick={() => choosePresetDestination(university)}
												disabled={tripStatus === 'tracking'}
												class={`rounded-full border px-3 py-2 text-xs font-medium ${
													routeDestination?.presetId === university.id
														? 'border-[#f1deba] bg-[#f1deba] text-[#171717]'
														: 'border-white/10 bg-white/[0.05] text-white/74 hover:bg-white/[0.08]'
												} disabled:opacity-50`}
											>
												{university.shortName}
											</button>
										{/each}
										<button
											type="button"
											onclick={() => void planRoute()}
											disabled={!routeDestination || routeLoading || tripStatus === 'tracking'}
											class="rounded-full border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-medium text-white/82 hover:bg-white/[0.08] disabled:opacity-50"
										>
											{routeLoading ? 'Refreshing...' : 'Refresh'}
										</button>
									</div>

									{#if routeError}
										<div class="rounded-[18px] bg-[#a44c39]/20 px-4 py-3 text-sm text-[#ffd2c6]">
											{routeError}
										</div>
									{/if}

									{#if routeMessage}
										<div class="rounded-[18px] bg-[#f1deba]/12 px-4 py-3 text-sm text-[#f8e7c4]">
											{routeMessage}
										</div>
									{/if}

									{#if tripError}
										<div class="rounded-[18px] bg-[#a44c39]/20 px-4 py-3 text-sm text-[#ffd2c6]">
											{tripError}
										</div>
									{/if}

									{#if tripMessage}
										<div class="rounded-[18px] bg-[#7fc7ae]/16 px-4 py-3 text-sm text-[#d9fff2]">
											{tripMessage}
										</div>
									{/if}

									{#if !routeDestination}
										<div
											class="rounded-[22px] border border-dashed border-white/10 bg-white/[0.04] px-4 py-4 text-sm text-white/64"
										>
											Double-click anywhere on the map to choose a destination, or tap a campus chip
											above for a quick preset.
										</div>
									{:else if routeLoading}
										<div
											class="rounded-[22px] border border-white/8 bg-white/[0.04] px-4 py-4 text-sm text-white/64"
										>
											Loading traffic-aware routes for {routeDestination.label}.
										</div>
									{:else if routeOptions.length === 0}
										<div
											class="rounded-[22px] border border-white/8 bg-white/[0.04] px-4 py-4 text-sm text-white/64"
										>
											No route options came back for this pin yet. Double-click nearby or refresh to
											try again.
										</div>
									{:else}
										<div class="max-h-[260px] space-y-2 overflow-y-auto pr-1">
											{#each routeOptions as route (route.routeId)}
												<button
													type="button"
													onclick={() => selectRoute(route.routeId)}
													disabled={tripStatus === 'tracking'}
													class={`block w-full rounded-[24px] border px-4 py-4 text-left transition ${
														selectedRouteId === route.routeId
															? 'border-[#55c6ff]/45 bg-[#55c6ff]/10'
															: 'border-white/8 bg-white/[0.04] hover:bg-white/[0.06]'
													} disabled:cursor-default disabled:opacity-85`}
												>
													<div class="flex items-start justify-between gap-3">
														<div class="min-w-0">
															<p class="text-sm font-medium text-white/90">{route.label}</p>
															<p class="mt-1 text-xs text-white/54">
																Arrive {formatArrivalTime(route.arrivalTime)} • {formatMinutes(
																	route.durationSec
																)} • {formatDistance(route.distanceMeters)}
															</p>
														</div>
														<div class="flex shrink-0 items-center gap-2">
															<span
																class={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${getTrafficBadgeClass(route.trafficLevel)}`}
															>
																{getTrafficLabel(route.trafficLevel)}
															</span>
															{#if selectedRouteId === route.routeId}
																<span
																	class="rounded-full bg-[#55c6ff] px-2.5 py-1 text-[11px] font-semibold text-[#05131d]"
																>
																	Selected
																</span>
															{/if}
														</div>
													</div>

													<p class="mt-3 text-sm text-white/70">
														{route.navigationCue.instruction}
													</p>

													<div class="mt-3 flex flex-wrap gap-2">
														<span
															class="rounded-full bg-white/[0.05] px-2.5 py-1 text-xs text-white/62"
														>
															{route.trafficSummary}
														</span>
														<span
															class="rounded-full bg-white/[0.05] px-2.5 py-1 text-xs text-white/62"
														>
															{route.incidentIds.length} incident matches
														</span>
														{#each route.explanationChips.slice(1, 4) as chip (chip)}
															<span
																class="rounded-full bg-white/[0.05] px-2.5 py-1 text-xs text-white/62"
															>
																{chip}
															</span>
														{/each}
													</div>
												</button>
											{/each}
										</div>

										<div class="grid grid-cols-2 gap-2">
											<button
												type="button"
												onclick={beginTrip}
												disabled={!selectedRoute || tripStatus === 'tracking' || tripBusy !== null}
												class="rounded-[20px] bg-[#55c6ff] px-4 py-3 text-sm font-semibold text-[#08141c] disabled:opacity-50"
											>
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
												class="rounded-[20px] border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white/86 disabled:opacity-50"
											>
												{tripBusy === 'arriving' ? 'Saving...' : 'Arrived'}
											</button>
										</div>
										<p class="text-xs text-white/50">
											Traffic is shown on the map by default. Double-click anywhere to move the pin,
											or tap a route line to switch before starting.
										</p>
									{/if}
								</div>
							</div>
						{:else if hasRouteContext}
							<button
								type="button"
								onclick={() => (routeSheetOpen = true)}
								class="w-full rounded-[28px] border border-white/10 bg-[rgba(11,13,17,0.88)] p-4 text-left shadow-[0_24px_64px_rgba(0,0,0,0.32)] backdrop-blur-2xl"
							>
								<p class="text-[10px] tracking-[0.28em] text-white/40 uppercase">Route ready</p>
								<div class="mt-2 flex items-center justify-between gap-3">
									<div class="min-w-0">
										<p class="truncate text-lg font-semibold text-white/92">
											{currentRouteDestinationLabel}
										</p>
										<p class="mt-1 truncate text-sm text-white/58">
											{selectedRoute
												? `${formatMinutes(selectedRoute.durationSec)} • ${selectedRoute.trafficSummary}`
												: currentRouteDestinationDetail}
										</p>
									</div>
									<span
										class="rounded-full bg-[#f1deba] px-3 py-1 text-xs font-semibold text-[#171717]"
									>
										Open
									</span>
								</div>
							</button>
						{:else}
							<div
								class="w-full rounded-[28px] border border-white/10 bg-[rgba(11,13,17,0.88)] p-4 shadow-[0_24px_64px_rgba(0,0,0,0.32)] backdrop-blur-2xl"
							>
								<p class="text-[10px] tracking-[0.28em] text-white/40 uppercase">Route mode</p>
								<p class="mt-2 text-xl font-semibold tracking-[-0.04em] text-white/92">
									Double-click anywhere to plan
								</p>
								<p class="mt-2 text-sm leading-6 text-white/66">
									Drop a pin on the map and the route sheet will appear with traffic-aware ETAs,
									alternatives, and trip tracking controls.
								</p>
								<div class="mt-4 flex flex-wrap gap-2">
									{#each UNIVERSITY_SEEDS as university (university.id)}
										<button
											type="button"
											onclick={() => choosePresetDestination(university)}
											class="rounded-full border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-medium text-white/78 hover:bg-white/[0.08]"
										>
											{university.shortName}
										</button>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				{:else}
					<div
						class={`pointer-events-auto flex w-full flex-col overflow-hidden backdrop-blur-2xl transition-all ${
							activeTab === 'pulse'
								? `max-w-[520px] rounded-[32px] border border-black/8 bg-[rgba(249,250,252,0.97)] text-[#141414] shadow-[0_28px_80px_rgba(0,0,0,0.22)] ${
										drawerExpanded ? 'max-h-[74svh] sm:max-h-[640px]' : 'max-h-[118px]'
									}`
								: `max-w-[680px] rounded-[32px] border border-[var(--border)] bg-[linear-gradient(180deg,rgba(255,253,248,0.98)_0%,rgba(247,241,230,0.94)_100%)] text-[var(--text)] shadow-[0_28px_80px_rgba(36,31,23,0.16)] ${
										drawerExpanded ? 'max-h-[82svh]' : 'max-h-[188px]'
									}`
						}`}
					>
						<button
							type="button"
							onclick={() => (drawerExpanded = !drawerExpanded)}
							class={activeTab === 'pulse'
								? 'w-full px-5 pt-4 pb-3 text-left'
								: 'w-full px-4 py-4 text-left sm:px-5'}
						>
							{#if activeTab === 'pulse'}
								<div class="flex flex-col items-center gap-2 pb-1">
									<div class="h-1.5 w-14 rounded-full bg-black/12"></div>
									{#if !drawerExpanded}
										<div
											class="flex h-12 w-12 items-center justify-center rounded-full bg-white shadow-[0_10px_24px_rgba(0,0,0,0.08)]"
										>
											<IncidentTypeIcon type={selectedType} class="h-8 w-8" />
										</div>
									{/if}
								</div>
							{:else}
								<div class="flex items-start justify-between gap-4">
									<div class="min-w-0">
										<div class="flex items-center gap-3">
											<div
												class="flex h-12 w-12 shrink-0 items-center justify-center rounded-[18px] bg-[var(--primary)] text-white shadow-[0_12px_28px_rgba(90,66,41,0.18)]"
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
													<p class="text-[10px] tracking-[0.28em] text-[var(--muted)] uppercase">
														Trust and history
													</p>
													<span
														class="rounded-full border border-[var(--border)] bg-white/75 px-2.5 py-1 text-[11px] font-medium text-[var(--muted)]"
													>
														{getRoleLabel(meQuery.data?.role)}
													</span>
												</div>
												<p
													class="mt-1 truncate text-[1.55rem] font-semibold tracking-[-0.04em] text-[var(--text)]"
												>
													{meQuery.data?.displayName ?? panelCopy[activeTab].title}
												</p>
											</div>
										</div>
									</div>
									<span
										class="inline-flex shrink-0 items-center gap-2 rounded-full border border-[var(--border)] bg-white/75 px-3 py-1.5 text-xs font-medium text-[var(--muted)]"
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
							{/if}
						</button>

						<div
							class={`min-h-0 overflow-y-auto border-t px-4 pb-4 ${
								activeTab === 'pulse' ? 'border-black/8' : 'border-[var(--border)]'
							}`}
						>
							{#if activeTab === 'pulse'}
								<div class="px-1 pt-3 pb-4">
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

									<div class="grid grid-cols-3 gap-3">
										{#each INCIDENT_TYPES as incidentType (incidentType)}
											<button
												type="button"
												aria-label={`Report ${INCIDENT_LABELS[incidentType].en}`}
												title={INCIDENT_LABELS[incidentType].en}
												onclick={() => void submitIncident(incidentType)}
												disabled={reportSubmitting}
												class={`flex items-center justify-center rounded-[26px] p-2.5 transition ${
													selectedType === incidentType
														? 'bg-[#eef6ff] ring-2 ring-[#1e88f7] ring-offset-2 ring-offset-[#f8fafc]'
														: 'bg-transparent'
												} disabled:opacity-50`}
											>
												<span
													class={`flex h-[80px] w-[80px] items-center justify-center rounded-full border sm:h-[88px] sm:w-[88px] ${
														selectedType === incidentType
															? 'border-[#1e88f7] bg-white shadow-[0_12px_30px_rgba(30,136,247,0.18)]'
															: 'border-black/6 bg-white shadow-[0_10px_28px_rgba(17,24,39,0.06)]'
													}`}
												>
													<IncidentTypeIcon type={incidentType} class="h-10 w-10 sm:h-12 sm:w-12" />
												</span>
											</button>
										{/each}
									</div>
								</div>
							{:else}
								<div class="pt-4">
									<div class="grid gap-3 sm:grid-cols-3">
										<div
											class="rounded-[24px] border border-[var(--border)] bg-white/80 px-4 py-4 shadow-[0_12px_30px_rgba(36,31,23,0.08)]"
										>
											<div class="flex items-center gap-3">
												<div
													class="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[var(--surface-muted)] text-[var(--primary)]"
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
											class="rounded-[24px] border border-[var(--border)] bg-white/80 px-4 py-4 shadow-[0_12px_30px_rgba(36,31,23,0.08)]"
										>
											<div class="flex items-center gap-3">
												<div
													class="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[var(--surface-muted)] text-[var(--primary)]"
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
											class="rounded-[24px] border border-[var(--border)] bg-white/80 px-4 py-4 shadow-[0_12px_30px_rgba(36,31,23,0.08)]"
										>
											<div class="flex items-center gap-3">
												<div
													class="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[var(--surface-muted)] text-[var(--primary)]"
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
											<a
												href={resolve('/app/proof')}
												class="flex items-center justify-between gap-3 border border-[var(--border)] bg-[var(--surface)] px-4 py-4 text-[var(--text)]"
											>
												<div class="flex min-w-0 items-center gap-3">
													<div
														class="flex h-10 w-10 shrink-0 items-center justify-center bg-[var(--surface-muted)] text-[var(--primary)]"
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
															<path
																d="M7 4.5h7l3 3V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z"
															/>
															<path d="M14 4.5V8h3" />
															<path d="M8 12h8" />
															<path d="M8 16h5" />
														</svg>
													</div>
													<div class="min-w-0">
														<p class="text-sm font-semibold text-[var(--text)]">
															Open proof center
														</p>
														<p class="text-sm text-[var(--muted)]">
															Issue and download certificates
														</p>
													</div>
												</div>
												<svg
													viewBox="0 0 24 24"
													class="h-4 w-4 shrink-0 text-[var(--muted)]"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													stroke-linecap="round"
													stroke-linejoin="round"
												>
													<path d="M5 12h14" />
													<path d="m13 5 7 7-7 7" />
												</svg>
											</a>

											{#if myIncidents.length === 0}
												<p
													class="border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--muted)]"
												>
													No recent reports.
												</p>
											{:else}
												<div class="border border-[var(--border)] bg-[var(--surface)]">
													<div class="border-b border-[var(--border)] px-4 py-3">
														<p class="text-sm font-semibold text-[var(--text)]">Recent reports</p>
													</div>
													<div class="divide-y divide-[var(--border)]">
														{#each myIncidents.slice(0, 3) as incident (incident._id)}
															<div class="flex items-center justify-between gap-3 px-4 py-3">
																<div class="min-w-0">
																	<p class="truncate text-sm font-medium text-[var(--text)]">
																		{INCIDENT_LABELS[incident.type].en}
																	</p>
																	<p class="text-sm text-[var(--muted)]">
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
