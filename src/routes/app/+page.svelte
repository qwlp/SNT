<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onDestroy } from 'svelte';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { makeFunctionReference, type FunctionReference } from 'convex/server';
	import MapSurface from '$lib/components/MapSurface.svelte';
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
	type ProfileState = 'idle' | 'loading' | 'ready' | 'error';
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
	const formatCompactDistance = (distanceMeters: number) =>
		distanceMeters >= 1000
			? `${(distanceMeters / 1000).toFixed(distanceMeters >= 10_000 ? 0 : 1)} km away`
			: `${Math.max(20, Math.round(distanceMeters / 10) * 10)} m away`;
	const formatError = (error: unknown, fallback: string) =>
		error instanceof Error ? error.message : fallback;
	const formatArrivalTime = (timestamp: number) =>
		new Date(timestamp).toLocaleTimeString('en-US', {
			hour: 'numeric',
			minute: '2-digit'
		});
	const relativeTimeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
	const formatRelativeTime = (timestamp: number) => {
		const diffMs = timestamp - Date.now();
		const absDiffMs = Math.abs(diffMs);

		if (absDiffMs < 60_000) {
			return 'just now';
		}

		if (absDiffMs < 3_600_000) {
			return relativeTimeFormatter.format(Math.round(diffMs / 60_000), 'minute');
		}

		if (absDiffMs < 86_400_000) {
			return relativeTimeFormatter.format(Math.round(diffMs / 3_600_000), 'hour');
		}

		return relativeTimeFormatter.format(Math.round(diffMs / 86_400_000), 'day');
	};
	const PROFILE_TIMEOUT_MESSAGE = 'Traffic profile setup timed out.';
	const getIncidentAccentClass = (type: IncidentType) => {
		if (type === 'roadblock') return 'border-[#ffb089]/45 bg-[#ffefe7] text-[#7f2e10]';
		if (type === 'vip') return 'border-[#efdca8]/40 bg-[#fff7de] text-[#6f5812]';
		if (type === 'wedding') return 'border-[#f4c4d6]/40 bg-[#fff0f5] text-[#7a2b4d]';
		if (type === 'flood') return 'border-[#8fd1ff]/40 bg-[#e9f6ff] text-[#0d4564]';
		if (type === 'accident') return 'border-[#ffb7b7]/40 bg-[#fff0f0] text-[#7f1d1d]';
		return 'border-[#c8c5ff]/35 bg-[#f3f1ff] text-[#43357f]';
	};
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

	let profileState = $state<ProfileState>('idle');
	let profileError = $state<string | null>(null);
	let selectedType = $state<IncidentType>('roadblock');
	let reportNote = $state('');
	let reportSubmitting = $state(false);
	let reportFeedback = $state<string | null>(null);
	let reportError = $state<string | null>(null);
	let reportLocation = $state<GeoPoint | null>(null);
	let reportLocationMode = $state<'pin' | 'gps' | null>(null);
	let currentLocation = $state<GeoPoint | null>(null);
	let locationStatus = $state('Waiting for GPS');
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
	let incidentActionId = $state<string | null>(null);
	let routeRequestId = $state(0);

	let profileRequest: Promise<unknown> | null = null;

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
	const visibleIncidents = $derived.by(() =>
		drawerExpanded ? incidents.slice(0, 6) : incidents.slice(0, 2)
	);
	const activeIncidentIds = $derived.by(
		() =>
			new Set(
				myIncidents
					.filter((incident) => incident.status === 'active')
					.map((incident) => incident._id)
			)
	);
	const isSignedIn = $derived(Boolean(clerkContext.currentUser));
	const locationLabel = $derived(
		currentLocation
			? `${currentLocation.lat.toFixed(4)}, ${currentLocation.lng.toFixed(4)}`
			: 'Phnom Penh center fallback'
	);
	const reportLocationLabel = $derived.by(() => {
		if (reportLocationMode === 'gps') return 'Live location';
		if (reportLocation) return 'Pinned report spot';
		return 'Pick a location';
	});
	const reportLocationDetail = $derived.by(() => {
		if (!reportLocation) {
			return 'Double-click on the map, press and hold on mobile, or use your live GPS to choose where this report belongs.';
		}

		if (reportLocationMode === 'gps') {
			return `${formatPointLabel(reportLocation)} • follows your current GPS`;
		}

		return formatPointLabel(reportLocation);
	});
	const reportLocationDistance = $derived.by(() => {
		if (!reportLocation || !currentLocation) return null;

		const distanceMeters = haversineMeters(currentLocation, reportLocation);
		if (distanceMeters < 25) return 'At your location';
		return formatCompactDistance(distanceMeters);
	});
	const reportFocusPoints = $derived.by(() =>
		[reportLocation, currentLocation].filter((point): point is GeoPoint => point !== null)
	);
	const profileStatusLabel = $derived.by(() => {
		if (profileState === 'ready') return 'Ready';
		if (profileState === 'loading') return 'Preparing account';
		if (profileState === 'error') return 'Needs retry';
		return 'Waiting';
	});
	const modeSummary = $derived.by(() => {
		if (activeTab === 'route') {
			if (tripStatus === 'tracking' && activeTrip) {
				return `Trip live to ${activeTrip.destinationName}`;
			}

			if (selectedRoute) {
				return `${formatMinutes(selectedRoute.durationSec)} • ${formatDistance(selectedRoute.distanceMeters)}`;
			}

			if (routeDestination) {
				return routeDestination.label;
			}

			return 'Double-click to plan';
		}

		if (activeTab === 'account') {
			return `${meQuery.data?.trustScore?.toFixed(1) ?? '2.0'}/5 trust`;
		}

		if (reportLocation) {
			return `${INCIDENT_LABELS[selectedType].en} • ${reportLocationMode === 'gps' ? 'live location' : 'pin ready'}`;
		}

		return `${incidents.length} live reports`;
	});
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

		if (profileError) {
			return {
				tone: 'error' as const,
				message: profileError
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
	const isProfileTimeoutError = (error: unknown) =>
		error instanceof Error && error.message === PROFILE_TIMEOUT_MESSAGE;
	const getMobileRouteBannerClass = (tone: 'error' | 'info' | 'success') => {
		if (tone === 'error') {
			return 'border-[#f1b7a4] bg-[#fff0eb] text-[#7d2c1d]';
		}

		if (tone === 'success') {
			return 'border-[#b7e6d4] bg-[#eefbf5] text-[#155544]';
		}

		return 'border-[#f0dfb5] bg-[#fff7e2] text-[#6d5320]';
	};

	const ensureTrafficProfile = async ({
		silent = false,
		allowTimeout = false
	}: {
		silent?: boolean;
		allowTimeout?: boolean;
	} = {}) => {
		if (!clerkContext.currentUser) {
			throw new Error('Sign in to continue.');
		}

		if (profileState === 'ready' && meQuery.data) {
			return meQuery.data;
		}

		if (profileRequest) {
			return profileRequest;
		}

		profileState = 'loading';
		if (!silent) {
			profileError = null;
		}

		profileRequest = withTimeout(
			convex.mutation(api.authed.users.ensureProfile, {}),
			8_000,
			PROFILE_TIMEOUT_MESSAGE
		)
			.then((profile) => {
				profileState = 'ready';
				return profile;
			})
			.catch((error: unknown) => {
				if (allowTimeout && isProfileTimeoutError(error)) {
					profileState = 'idle';
					if (!silent) {
						profileError = null;
					}
					return null;
				}

				profileState = 'error';
				if (!silent) {
					profileError = formatError(error, 'Unable to prepare your traffic profile.');
				}
				throw error;
			})
			.finally(() => {
				profileRequest = null;
			});

		return profileRequest;
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
			const profile = await ensureTrafficProfile({
				silent: true,
				allowTimeout: true
			}).catch(() => null);
			if (!profile) {
				startLocalTrip(routeDestination, selectedRoute);
				return;
			}

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

	const submitIncident = async () => {
		if (reportSubmitting) return;
		if (!reportLocation) {
			reportError = 'Pick a location on the map or use your live GPS before sending this report.';
			reportFeedback = null;
			drawerExpanded = true;
			return;
		}

		reportSubmitting = true;
		reportFeedback = null;
		reportError = null;

		try {
			await ensureTrafficProfile();
			await convex.mutation(api.authed.incidents.create, {
				type: selectedType,
				location: reportLocation,
				description: reportNote.trim() || undefined
			});

			reportNote = '';
			drawerExpanded = true;
			reportFeedback = `${INCIDENT_LABELS[selectedType].en} reported successfully at ${reportLocationMode === 'gps' ? 'your live location' : 'the pinned spot'}.`;
		} catch (error) {
			reportError = formatError(error, 'Unable to send road report.');
		} finally {
			reportSubmitting = false;
		}
	};

	const confirmIncident = async (incidentId: Id<'incidents'>) => {
		if (activeIncidentIds.has(incidentId) || incidentActionId) return;

		incidentActionId = incidentId;
		reportFeedback = null;
		reportError = null;

		try {
			await ensureTrafficProfile();
			await convex.mutation(api.authed.incidents.confirm, {
				incidentId
			});
			reportFeedback = 'Confirmation recorded. Thank you for verifying the report.';
		} catch (error) {
			reportError = formatError(error, 'Unable to confirm report.');
		} finally {
			incidentActionId = null;
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

	const useLiveLocationForReport = () => {
		if (!currentLocation) {
			reportError = 'Waiting for GPS. Try again in a moment or pin the map manually.';
			reportFeedback = null;
			drawerExpanded = true;
			return;
		}

		setReportLocation(currentLocation, 'gps');
	};

	const clearReportLocation = () => {
		reportLocation = null;
		reportLocationMode = null;
		reportFeedback = null;
		reportError = null;
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
		if (meQuery.data) {
			profileState = 'ready';
			profileError = null;
		}
	});

	$effect(() => {
		if (!clerkContext.currentUser) {
			profileState = 'idle';
			profileError = null;
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

		void ensureTrafficProfile({
			silent: true,
			allowTimeout: true
		}).catch(() => undefined);
	});

	$effect(() => {
		if (reportLocationMode !== 'gps' || !currentLocation) return;

		reportLocation = currentLocation;
	});

	$effect(() => {
		if (!navigator.geolocation) {
			locationStatus = 'Geolocation unavailable';
			currentLocation = PHNOM_PENH_CENTER;
			return;
		}

		const watchId = navigator.geolocation.watchPosition(
			(position) => {
				currentLocation = {
					lat: position.coords.latitude,
					lng: position.coords.longitude
				};
				locationStatus = 'Live GPS';
			},
			() => {
				locationStatus = 'Using Phnom Penh center';
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
				navigationMode={activeTab === 'route'}
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

		<div class="pointer-events-none absolute inset-x-0 top-0 z-20 p-3 sm:p-4">
			<div class="mx-auto flex max-w-[1440px] items-start justify-between gap-3">
				<div
					class={`pointer-events-auto flex flex-wrap items-center gap-2 ${
						activeTab === 'route' && showRouteHud && tripStatus !== 'tracking'
							? 'hidden sm:flex'
							: activeTab === 'route'
								? 'hidden sm:flex'
								: ''
					}`}
				>
					{#if !(activeTab === 'route' && tripStatus === 'tracking')}
						<div
							class="rounded-full border border-white/10 bg-[rgba(11,13,17,0.84)] px-4 py-2 shadow-[0_18px_48px_rgba(0,0,0,0.28)] backdrop-blur-xl"
						>
							<p class="text-[10px] tracking-[0.28em] text-white/40 uppercase">SNT</p>
							<p class="mt-0.5 text-sm font-semibold text-white/90">
								{panelCopy[activeTab].title} • {modeSummary}
							</p>
						</div>
						<div
							class="hidden rounded-full border border-white/10 bg-[rgba(11,13,17,0.8)] px-3 py-2 text-xs text-white/66 shadow-[0_18px_48px_rgba(0,0,0,0.22)] backdrop-blur-xl sm:block"
						>
							{panelCopy[activeTab].subtitle}
						</div>
					{/if}
				</div>

				<div
					class={`pointer-events-auto flex items-center gap-2 ${
						activeTab === 'route' && showRouteHud && tripStatus !== 'tracking'
							? 'hidden sm:flex'
							: ''
					}`}
				>
					<div
						class="hidden rounded-full border border-white/10 bg-[rgba(11,13,17,0.8)] px-4 py-2 text-right shadow-[0_18px_48px_rgba(0,0,0,0.22)] backdrop-blur-xl sm:block"
					>
						<p class="text-[10px] tracking-[0.28em] text-white/40 uppercase">{locationStatus}</p>
						<p class="mt-0.5 text-sm font-medium text-white/88">{locationLabel}</p>
					</div>
					<div
						class="hidden rounded-full border border-white/10 bg-[rgba(11,13,17,0.8)] px-4 py-2 text-right shadow-[0_18px_48px_rgba(0,0,0,0.22)] backdrop-blur-xl sm:block"
					>
						<p class="text-[10px] tracking-[0.28em] text-white/40 uppercase">Profile</p>
						<p class="mt-0.5 text-sm font-medium text-white/88">{profileStatusLabel}</p>
					</div>
					<div
						class="rounded-full border border-white/10 bg-[rgba(11,13,17,0.8)] p-1 shadow-[0_18px_48px_rgba(0,0,0,0.22)] backdrop-blur-xl"
						{@attach (element) => {
							clerkContext.clerk.mountUserButton(element);
						}}
					></div>
				</div>
			</div>
		</div>

		{#if activeTab === 'route' && showRouteHud}
			<div
				class={`pointer-events-none absolute inset-x-0 z-25 px-3 sm:px-4 ${
					tripStatus === 'tracking'
						? 'top-3 bottom-3 sm:top-4 sm:bottom-4'
						: 'top-0 bottom-0 sm:top-[98px] sm:bottom-[110px]'
				}`}
			>
				<div class="mx-auto flex h-full max-w-[1440px] flex-col justify-between gap-3">
					{#if tripStatus === 'tracking'}
						<div
							class="flex h-full flex-col justify-between px-3 pt-[calc(env(safe-area-inset-top,0px)+8px)] pb-3 sm:hidden"
						>
							<div
								class="pointer-events-auto rounded-[24px] border border-black/8 bg-[rgba(248,248,246,0.98)] px-3 py-3 text-[#161616] shadow-[0_14px_36px_rgba(0,0,0,0.14)] backdrop-blur-2xl"
							>
								<div class="flex items-center gap-3">
									<div
										class="flex h-12 w-12 shrink-0 items-center justify-center rounded-[16px] bg-[#11161c] text-[#f7f1e4]"
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
									class="mt-3 w-full rounded-[22px] bg-[#1397ff] px-4 py-3.5 text-base font-semibold text-white shadow-[0_14px_30px_rgba(19,151,255,0.2)] disabled:opacity-50"
								>
									{tripBusy === 'arriving' ? 'Saving arrival...' : 'Mark arrived'}
								</button>
							</div>
						</div>

						<div class="hidden h-full flex-col justify-between sm:flex">
							<div class="pointer-events-auto flex justify-center">
								<div
									class="grid w-full max-w-[1280px] gap-3 rounded-[34px] border border-white/10 bg-[rgba(6,8,12,0.94)] p-4 shadow-[0_30px_80px_rgba(0,0,0,0.4)] backdrop-blur-2xl sm:p-5 lg:grid-cols-[112px_minmax(0,1fr)_150px_150px_220px] lg:items-center"
								>
									<div
										class="flex h-20 w-20 shrink-0 items-center justify-center rounded-[24px] bg-white text-black sm:h-24 sm:w-24"
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

									<div class="min-w-0 lg:pr-4">
										<div class="flex flex-wrap items-start justify-between gap-3">
											<div class="min-w-0">
												<p
													class="text-4xl font-semibold tracking-[-0.06em] text-white sm:text-5xl lg:text-6xl"
												>
													{navigationRoute ? nextCueDistanceLabel : '--'}
												</p>
												<p
													class="truncate text-[1.8rem] font-semibold tracking-[-0.05em] text-[#55c6ff] sm:text-[2.2rem]"
												>
													{navigationRoadLabel}
												</p>
											</div>
											<span
												class={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold sm:text-sm lg:hidden ${
													navigationRoute
														? getTrafficBadgeClass(navigationRoute.trafficLevel)
														: 'bg-white/10 text-white/72'
												}`}
											>
												{navigationRoute ? getTrafficLabel(navigationRoute.trafficLevel) : 'Live'}
											</span>
										</div>

										<p class="mt-2 max-w-[48rem] text-base leading-7 text-white/70">
											{navigationInstruction}
										</p>
									</div>

									<div class="rounded-[22px] border border-white/8 bg-white/[0.04] px-4 py-3">
										<p class="text-[10px] tracking-[0.3em] text-white/34 uppercase">ETA</p>
										<p class="mt-1 text-xl font-semibold text-white sm:text-2xl">
											{nextArrivalLabel}
										</p>
									</div>

									<div class="rounded-[22px] border border-white/8 bg-white/[0.04] px-4 py-3">
										<p class="text-[10px] tracking-[0.3em] text-white/34 uppercase">Trip</p>
										<p class="mt-1 text-xl font-semibold text-white sm:text-2xl">
											{navigationRoute ? formatMinutes(navigationRoute.durationSec) : '--'}
										</p>
									</div>

									<div class="rounded-[22px] border border-white/8 bg-white/[0.04] px-4 py-3">
										<div class="flex items-center justify-between gap-3">
											<p class="text-[10px] tracking-[0.3em] text-white/34 uppercase">Traffic</p>
											<span
												class={`hidden rounded-full px-3 py-1 text-xs font-semibold lg:inline-flex ${
													navigationRoute
														? getTrafficBadgeClass(navigationRoute.trafficLevel)
														: 'bg-white/10 text-white/72'
												}`}
											>
												{navigationRoute ? getTrafficLabel(navigationRoute.trafficLevel) : 'Live'}
											</span>
										</div>
										<p class="mt-1 text-base font-semibold text-white sm:text-lg">
											{navigationRoute?.trafficSummary ?? 'Live route'}
										</p>
									</div>
								</div>
							</div>

							<div class="pointer-events-none flex-1"></div>

							<div class="grid items-end gap-3 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)_260px]">
								<div class="pointer-events-auto space-y-2">
									<div
										class="rounded-[24px] border border-white/10 bg-[rgba(11,13,17,0.88)] px-4 py-3 shadow-[0_22px_56px_rgba(0,0,0,0.3)] backdrop-blur-2xl"
									>
										<p class="text-[10px] tracking-[0.28em] text-white/38 uppercase">Live trip</p>
										<p class="mt-1 text-xl font-semibold text-white">{activeRouteLabel}</p>
										<p class="mt-1 text-sm text-white/60">
											Arrive {nextArrivalLabel} • {navigationRoute
												? formatDistance(navigationRoute.distanceMeters)
												: '--'}
										</p>
									</div>

									{#if tripError}
										<div class="rounded-[20px] bg-[#a44c39]/20 px-4 py-3 text-sm text-[#ffd2c6]">
											{tripError}
										</div>
									{/if}
									{#if tripMessage}
										<div class="rounded-[20px] bg-[#7fc7ae]/16 px-4 py-3 text-sm text-[#d9fff2]">
											{tripMessage}
										</div>
									{/if}
								</div>

								<div
									class="pointer-events-auto flex flex-wrap items-center justify-center gap-2 lg:justify-self-center"
								>
									<span
										class="rounded-full border border-white/10 bg-[rgba(11,13,17,0.84)] px-3 py-2 text-xs font-medium text-white/72 backdrop-blur-xl"
									>
										Destination: {currentRouteDestinationLabel}
									</span>
									<span
										class="rounded-full border border-white/10 bg-[rgba(11,13,17,0.84)] px-3 py-2 text-xs font-medium text-white/72 backdrop-blur-xl"
									>
										Path stays blue above traffic
									</span>
								</div>

								<div class="pointer-events-auto lg:justify-self-end">
									<button
										type="button"
										onclick={markArrived}
										disabled={tripStatus !== 'tracking' || tripBusy !== null}
										class="w-full min-w-[220px] rounded-[24px] border border-white/10 bg-[rgba(11,13,17,0.92)] px-6 py-5 text-lg font-semibold text-white/92 shadow-[0_24px_64px_rgba(0,0,0,0.34)] backdrop-blur-2xl disabled:opacity-50"
									>
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
										class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-black/8 bg-white text-black/70 shadow-[0_10px_24px_rgba(0,0,0,0.08)]"
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
															? 'border-[#78b8ff] bg-[#eaf4ff] shadow-[0_10px_24px_rgba(19,151,255,0.14)]'
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
										class="rounded-full bg-[#ececec] px-3 py-2.5 text-sm font-semibold text-black/70"
									>
										Later
									</button>
									<button
										type="button"
										onclick={() => void planRoute()}
										disabled={!routeDestination || routeLoading}
										class="rounded-full border border-black/10 bg-white px-3 py-2.5 text-sm font-semibold text-black/64 disabled:opacity-50"
									>
										Refresh
									</button>
									<button
										type="button"
										onclick={beginTrip}
										disabled={!selectedRoute || tripBusy !== null}
										class="rounded-full bg-[#1397ff] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
									>
										{tripBusy === 'starting' ? 'Starting...' : 'Go'}
									</button>
								</div>
							</div>
						</div>

						<div
							class="hidden gap-3 lg:grid lg:grid-cols-[250px_minmax(0,1fr)_320px] lg:items-start"
						>
							<div
								class="pointer-events-auto rounded-[24px] border border-white/10 bg-[rgba(11,13,17,0.88)] p-3 shadow-[0_20px_54px_rgba(0,0,0,0.28)] backdrop-blur-2xl"
							>
								<div class="flex items-start justify-between gap-3">
									<div class="min-w-0">
										<p class="text-[10px] tracking-[0.28em] text-white/40 uppercase">Destination</p>
										<p class="mt-2 truncate text-xl font-semibold tracking-[-0.04em] text-white/92">
											{currentRouteDestinationLabel}
										</p>
										<p class="mt-1 text-xs leading-5 text-white/60">
											{currentRouteDestinationDetail}
										</p>
									</div>
									<span
										class={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
											navigationRoute
												? getTrafficBadgeClass(navigationRoute.trafficLevel)
												: 'bg-white/10 text-white/72'
										}`}
									>
										{navigationRoute ? getTrafficLabel(navigationRoute.trafficLevel) : 'Standby'}
									</span>
								</div>

								<div class="mt-3 flex flex-wrap gap-1.5">
									{#each UNIVERSITY_SEEDS as university (university.id)}
										<button
											type="button"
											onclick={() => choosePresetDestination(university)}
											class={`rounded-full border px-2.5 py-1.5 text-[11px] font-medium ${
												routeDestination?.presetId === university.id
													? 'border-[#f1deba] bg-[#f1deba] text-[#171717]'
													: 'border-white/10 bg-white/[0.05] text-white/74 hover:bg-white/[0.08]'
											}`}
										>
											{university.shortName}
										</button>
									{/each}
									<button
										type="button"
										onclick={() => void planRoute()}
										disabled={!routeDestination || routeLoading}
										class="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1.5 text-[11px] font-medium text-white/82 hover:bg-white/[0.08] disabled:opacity-50"
									>
										{routeLoading ? 'Refreshing...' : 'Refresh'}
									</button>
								</div>

								<p class="mt-3 text-[11px] leading-4 text-white/46">
									Double-click to move the pin.
								</p>
							</div>

							<div class="pointer-events-auto lg:self-start lg:justify-self-center">
								<div
									class="mx-auto w-full max-w-[720px] rounded-[26px] border border-white/10 bg-[rgba(11,13,17,0.9)] px-4 py-3 shadow-[0_24px_68px_rgba(0,0,0,0.32)] backdrop-blur-2xl"
								>
									<div class="flex items-center gap-4">
										<div
											class="flex h-14 w-14 shrink-0 items-center justify-center rounded-[18px] bg-white text-black"
										>
											<svg
												viewBox="0 0 24 24"
												class="h-8 w-8"
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

										<div class="min-w-0">
											<p class="text-[10px] tracking-[0.28em] text-white/38 uppercase">
												Route preview
											</p>
											<p class="mt-1 text-2xl font-semibold tracking-[-0.05em] text-white">
												{navigationRoute ? nextCueDistanceLabel : 'Ready to plan'}
											</p>
											<p class="truncate text-sm font-medium text-[#55c6ff]">
												{navigationRoute?.navigationCue.roadName ?? currentRouteDestinationLabel}
											</p>
										</div>
									</div>

									<p class="mt-3 text-sm leading-6 text-white/74">
										{navigationRoute?.navigationCue.instruction ??
											'Pick or pin a destination and the map will load traffic-aware routes automatically.'}
									</p>

									<div class="mt-3 grid grid-cols-3 gap-2">
										<div class="rounded-[16px] border border-white/8 bg-white/[0.04] px-3 py-2.5">
											<p class="text-[10px] tracking-[0.24em] text-white/38 uppercase">ETA</p>
											<p class="mt-1 text-base font-semibold text-white">{nextArrivalLabel}</p>
										</div>
										<div class="rounded-[16px] border border-white/8 bg-white/[0.04] px-3 py-2.5">
											<p class="text-[10px] tracking-[0.24em] text-white/38 uppercase">Trip</p>
											<p class="mt-1 text-base font-semibold text-white">
												{navigationRoute ? formatMinutes(navigationRoute.durationSec) : '--'}
											</p>
										</div>
										<div class="rounded-[16px] border border-white/8 bg-white/[0.04] px-3 py-2.5">
											<p class="text-[10px] tracking-[0.24em] text-white/38 uppercase">Traffic</p>
											<p class="mt-1 truncate text-xs font-semibold text-white">
												{navigationRoute?.trafficSummary ?? 'Planning'}
											</p>
										</div>
									</div>
								</div>
							</div>

							<div
								class="pointer-events-auto hidden max-h-[calc(100svh-230px)] overflow-hidden rounded-[24px] border border-white/10 bg-[rgba(11,13,17,0.9)] shadow-[0_24px_68px_rgba(0,0,0,0.32)] backdrop-blur-2xl lg:block"
							>
								<div class="border-b border-white/8 px-3 py-2.5">
									<p class="text-[10px] tracking-[0.28em] text-white/40 uppercase">Route options</p>
									<p class="mt-1 text-base font-semibold text-white/92">
										{routeOptions.length > 0
											? `${routeOptions.length} choices live`
											: 'Waiting for routes'}
									</p>
								</div>

								<div class="max-h-[calc(100svh-300px)] space-y-2 overflow-y-auto p-2.5">
									{#if routeLoading}
										<div
											class="rounded-[22px] border border-white/8 bg-white/[0.04] px-4 py-4 text-sm text-white/64"
										>
											Loading traffic-aware routes for {currentRouteDestinationLabel}.
										</div>
									{:else if !routeDestination}
										<div
											class="rounded-[22px] border border-dashed border-white/10 bg-white/[0.04] px-4 py-4 text-sm text-white/64"
										>
											Double-click the map to pin a destination.
										</div>
									{:else if routeOptions.length === 0}
										<div
											class="rounded-[22px] border border-white/8 bg-white/[0.04] px-4 py-4 text-sm text-white/64"
										>
											No route options came back for this pin yet. Try moving the destination
											slightly.
										</div>
									{:else}
										{#each routeOptions as route (route.routeId)}
											<button
												type="button"
												onclick={() => selectRoute(route.routeId)}
												class={`block w-full rounded-[20px] border px-3 py-3 text-left transition ${
													selectedRouteId === route.routeId
														? 'border-[#55c6ff]/45 bg-[#55c6ff]/10'
														: 'border-white/8 bg-white/[0.04] hover:bg-white/[0.06]'
												}`}
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

												<p class="mt-2 text-sm text-white/70">{route.navigationCue.instruction}</p>

												<div class="mt-2 flex flex-wrap gap-1.5">
													<span
														class="rounded-full bg-white/[0.05] px-2 py-1 text-[11px] text-white/62"
													>
														{route.trafficSummary}
													</span>
													<span
														class="rounded-full bg-white/[0.05] px-2 py-1 text-[11px] text-white/62"
													>
														{route.incidentIds.length} incident matches
													</span>
													{#each route.explanationChips.slice(1, 3) as chip (chip)}
														<span
															class="rounded-full bg-white/[0.05] px-2 py-1 text-[11px] text-white/62"
														>
															{chip}
														</span>
													{/each}
												</div>
											</button>
										{/each}
									{/if}
								</div>
							</div>
						</div>

						<div class="hidden gap-3 lg:grid lg:grid-cols-[250px_minmax(0,1fr)_320px] lg:items-end">
							<div class="pointer-events-auto space-y-2">
								{#if profileError}
									<div class="rounded-[20px] border border-[#b86042]/30 bg-[#b86042]/12 px-4 py-3">
										<div class="flex items-center justify-between gap-3">
											<p class="text-sm text-[#ffd9cb]">{profileError}</p>
											<button
												type="button"
												onclick={() => void ensureTrafficProfile()}
												class="shrink-0 rounded-full border border-white/12 px-3 py-1.5 text-xs font-medium text-white/84 hover:bg-white/[0.08]"
											>
												Retry
											</button>
										</div>
									</div>
								{/if}
								{#if routeError}
									<div class="rounded-[20px] bg-[#a44c39]/20 px-4 py-3 text-sm text-[#ffd2c6]">
										{routeError}
									</div>
								{/if}
								{#if routeMessage}
									<div class="rounded-[20px] bg-[#f1deba]/12 px-4 py-3 text-sm text-[#f8e7c4]">
										{routeMessage}
									</div>
								{/if}
								{#if tripError}
									<div class="rounded-[20px] bg-[#a44c39]/20 px-4 py-3 text-sm text-[#ffd2c6]">
										{tripError}
									</div>
								{/if}
								{#if tripMessage}
									<div class="rounded-[20px] bg-[#7fc7ae]/16 px-4 py-3 text-sm text-[#d9fff2]">
										{tripMessage}
									</div>
								{/if}
							</div>

							<div class="pointer-events-auto lg:justify-self-center">
								<div
									class="mx-auto max-w-[520px] rounded-[24px] border border-white/10 bg-[rgba(11,13,17,0.9)] p-3 shadow-[0_20px_54px_rgba(0,0,0,0.3)] backdrop-blur-2xl"
								>
									<div class="grid grid-cols-2 gap-2">
										<button
											type="button"
											onclick={beginTrip}
											disabled={!selectedRoute || tripBusy !== null}
											class="rounded-[18px] bg-[#55c6ff] px-4 py-2.5 text-sm font-semibold text-[#08141c] disabled:opacity-50"
										>
											{tripBusy === 'starting' ? 'Starting...' : 'Start trip'}
										</button>
										<button
											type="button"
											onclick={markArrived}
											disabled={true}
											class="rounded-[18px] border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm font-semibold text-white/86 disabled:opacity-50"
										>
											{tripBusy === 'arriving' ? 'Saving...' : 'Arrived'}
										</button>
									</div>
									<p class="mt-2 text-[11px] leading-4 text-white/50">
										Tap a route line on the map or a card on the right to switch before starting.
										During a live trip, the navigation path stays blue above traffic.
									</p>
								</div>
							</div>
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<div
			class={`pointer-events-none absolute inset-x-0 bottom-0 z-30 px-3 pb-3 sm:px-4 sm:pb-4 ${
				activeTab === 'route' && tripStatus === 'tracking'
					? 'hidden'
					: activeTab === 'route' && showRouteHud
						? 'hidden sm:block'
						: ''
			}`}
		>
			<div class="mx-auto flex max-w-[1440px] flex-col items-center gap-3 lg:items-start">
				<div
					class="pointer-events-auto rounded-full border border-white/10 bg-[rgba(11,13,17,0.9)] p-1 shadow-[0_24px_64px_rgba(0,0,0,0.34)] backdrop-blur-2xl"
				>
					<div class="flex items-center gap-1">
						{#each dockItems as item (item.id)}
							<a
								href={resolve(item.href)}
								aria-current={activeTab === item.id ? 'page' : undefined}
								class={`rounded-full px-4 py-2.5 text-sm font-medium ${
									activeTab === item.id
										? 'bg-[#f1deba] text-[#171717]'
										: 'text-white/72 hover:bg-white/[0.08]'
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
									{#if profileError}
										<div
											class="flex items-center justify-between gap-3 rounded-[18px] border border-[#b86042]/30 bg-[#b86042]/12 px-4 py-3"
										>
											<p class="text-sm text-[#ffd9cb]">{profileError}</p>
											<button
												type="button"
												onclick={() => void ensureTrafficProfile()}
												class="shrink-0 rounded-full border border-white/12 px-3 py-1.5 text-xs font-medium text-white/84 hover:bg-white/[0.08]"
											>
												Retry
											</button>
										</div>
									{/if}

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
						class={`pointer-events-auto w-full max-w-[560px] overflow-hidden rounded-[30px] border shadow-[0_28px_80px_rgba(0,0,0,0.42)] backdrop-blur-2xl transition-all ${
							activeTab === 'pulse'
								? 'border-black/8 bg-[rgba(248,248,246,0.98)] text-[#141414]'
								: 'border-white/10 bg-[rgba(11,13,17,0.92)] text-white'
						} ${drawerExpanded ? 'max-h-[78svh]' : 'max-h-[220px]'}`}
					>
						<button
							type="button"
							onclick={() => (drawerExpanded = !drawerExpanded)}
							class="flex w-full items-center justify-between px-4 py-3 text-left"
						>
							<div>
								<p
									class={`text-[10px] tracking-[0.28em] uppercase ${
										activeTab === 'pulse' ? 'text-black/38' : 'text-white/40'
									}`}
								>
									{panelCopy[activeTab].subtitle}
								</p>
								<p
									class={`mt-1 text-lg font-semibold ${
										activeTab === 'pulse' ? 'text-[#141414]' : 'text-white/92'
									}`}
								>
									{panelCopy[activeTab].title}
								</p>
							</div>
							<span
								class={`rounded-full px-3 py-1 text-xs ${
									activeTab === 'pulse'
										? 'border border-black/8 bg-white text-black/56'
										: 'bg-white/[0.06] text-white/68'
								}`}
							>
								{drawerExpanded ? 'Collapse' : 'Expand'}
							</span>
						</button>

						<div
							class={`border-t px-4 pb-4 ${
								activeTab === 'pulse' ? 'border-black/8' : 'border-white/8'
							}`}
						>
							{#if profileError}
								<div
									class={`mt-4 flex items-center justify-between gap-3 rounded-[18px] border px-4 py-3 ${
										activeTab === 'pulse'
											? 'border-[#f1b7a4] bg-[#fff0eb]'
											: 'border-[#b86042]/30 bg-[#b86042]/12'
									}`}
								>
									<p
										class={`text-sm ${activeTab === 'pulse' ? 'text-[#7d2c1d]' : 'text-[#ffd9cb]'}`}
									>
										{profileError}
									</p>
									<button
										type="button"
										onclick={() => void ensureTrafficProfile()}
										class={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium ${
											activeTab === 'pulse'
												? 'border-black/8 bg-white text-black/76 hover:bg-black/[0.03]'
												: 'border-white/12 text-white/84 hover:bg-white/[0.08]'
										}`}
									>
										Retry
									</button>
								</div>
							{/if}

							{#if activeTab === 'pulse'}
								<div class="pt-4">
									<div
										class="rounded-[26px] border border-black/8 bg-[linear-gradient(180deg,rgba(255,248,239,0.96)_0%,rgba(247,248,250,0.98)_100%)] p-4 shadow-[0_12px_32px_rgba(0,0,0,0.06)]"
									>
										<div class="flex flex-wrap items-start justify-between gap-3">
											<div class="max-w-[28rem]">
												<p class="text-[10px] tracking-[0.3em] text-black/36 uppercase">
													Report composer
												</p>
												<p
													class="mt-2 text-[1.45rem] leading-none font-semibold tracking-[-0.05em] text-[#171717]"
												>
													Mark the exact spot before you post.
												</p>
												<p class="mt-2 text-sm leading-6 text-black/60">
													Double-click the map on desktop or press and hold on mobile to drop a
													report pin. Then choose the type and add a short note.
												</p>
											</div>

											<div class="grid min-w-[200px] grid-cols-2 gap-2 text-left">
												<div class="rounded-[18px] border border-black/8 bg-white px-3 py-3">
													<p class="text-[10px] tracking-[0.24em] text-black/36 uppercase">Live</p>
													<p class="mt-1 text-xl font-semibold text-[#171717]">
														{incidents.length}
													</p>
													<p class="text-xs text-black/46">reports in the city</p>
												</div>
												<div class="rounded-[18px] border border-black/8 bg-white px-3 py-3">
													<p class="text-[10px] tracking-[0.24em] text-black/36 uppercase">
														Status
													</p>
													<p class="mt-1 text-sm font-semibold text-[#171717]">{locationStatus}</p>
													<p class="text-xs text-black/46">map pinning enabled</p>
												</div>
											</div>
										</div>
									</div>

									<div
										class="mt-4 rounded-[24px] border border-black/8 bg-white p-3 shadow-[0_10px_24px_rgba(0,0,0,0.04)]"
									>
										<div class="flex items-start justify-between gap-3">
											<div class="min-w-0">
												<p class="text-[10px] tracking-[0.28em] text-black/36 uppercase">
													Location
												</p>
												<p class="mt-2 text-lg font-semibold tracking-[-0.04em] text-[#171717]">
													{reportLocationLabel}
												</p>
												<p class="mt-1 text-sm leading-6 text-black/58">{reportLocationDetail}</p>
											</div>
											<span
												class={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
													reportLocation
														? 'bg-[#ffede5] text-[#7f2e10]'
														: 'border border-black/8 bg-[#f5f5f2] text-black/56'
												}`}
											>
												{reportLocation ? 'Ready' : 'Waiting'}
											</span>
										</div>

										<div class="mt-3 flex flex-wrap gap-2 text-xs text-black/56">
											<span class="rounded-full border border-black/8 bg-[#f5f5f2] px-2.5 py-1">
												{reportLocationDistance ?? 'Select a spot to preview distance'}
											</span>
											<span class="rounded-full border border-black/8 bg-[#f5f5f2] px-2.5 py-1">
												{reportLocationMode === 'gps'
													? 'Using your live GPS'
													: reportLocation
														? 'Pinned manually on the map'
														: 'No report location chosen yet'}
											</span>
										</div>

										<div class="mt-4 flex flex-wrap gap-2">
											<button
												type="button"
												onclick={useLiveLocationForReport}
												class="rounded-full border border-black/8 bg-white px-3.5 py-2 text-sm font-medium text-black/78 hover:bg-black/[0.03]"
											>
												Use live location
											</button>
											<button
												type="button"
												onclick={clearReportLocation}
												disabled={!reportLocation}
												class="rounded-full border border-black/8 bg-[#f5f5f2] px-3.5 py-2 text-sm font-medium text-black/62 hover:bg-black/[0.03] disabled:opacity-45"
											>
												Clear pin
											</button>
										</div>
									</div>

									<div class="mt-4">
										<p class="text-[10px] tracking-[0.28em] text-black/36 uppercase">Type</p>
										<div class="mt-3 flex gap-2 overflow-x-auto pb-1">
											{#each INCIDENT_TYPES as incidentType (incidentType)}
												<button
													type="button"
													onclick={() => (selectedType = incidentType)}
													class={`shrink-0 rounded-full border px-3 py-2 text-sm font-medium transition ${
														selectedType === incidentType
															? 'border-[#ffd4ba] bg-[#fff1e6] text-[#171717] shadow-[0_8px_20px_rgba(255,133,72,0.16)]'
															: 'border-black/8 bg-white text-black/70'
													}`}
												>
													{INCIDENT_LABELS[incidentType].en}
												</button>
											{/each}
										</div>
									</div>

									<div
										class="mt-4 rounded-[24px] border border-black/8 bg-white p-3 shadow-[0_10px_24px_rgba(0,0,0,0.04)]"
									>
										<div class="flex items-center justify-between gap-3">
											<div>
												<p class="text-[10px] tracking-[0.28em] text-black/36 uppercase">Note</p>
												<p class="mt-1 text-sm text-black/58">
													Add a useful detail for nearby drivers.
												</p>
											</div>
											<span
												class="rounded-full border border-black/8 bg-[#f5f5f2] px-2.5 py-1 text-xs text-black/50"
											>
												{reportNote.length}/120
											</span>
										</div>

										<textarea
											bind:value={reportNote}
											maxlength="120"
											rows="3"
											class="mt-3 min-h-[104px] w-full resize-none rounded-[20px] border border-black/8 bg-[#fbfbf9] px-4 py-3 text-sm leading-6 text-[#171717] outline-none placeholder:text-black/34 focus:border-[#ffd4ba]"
											placeholder={`Example: ${INCIDENT_LABELS[selectedType].en.toLowerCase()} is blocking one lane, slow traffic near the intersection.`}
										></textarea>

										<div
											class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
										>
											<p class="text-xs text-black/48">
												Reports work best when the pin is exact and the note is specific.
											</p>
											<button
												type="button"
												onclick={submitIncident}
												disabled={reportSubmitting || profileState === 'loading' || !reportLocation}
												class="rounded-[18px] bg-[#f4d5be] px-4 py-3 text-sm font-semibold text-[#171717] shadow-[0_14px_26px_rgba(241,222,186,0.16)] hover:bg-[#ead19f] disabled:opacity-50"
											>
												{reportSubmitting ? 'Publishing...' : 'Publish report'}
											</button>
										</div>
									</div>

									{#if reportError}
										<div
											class="mt-3 rounded-[18px] border border-[#f1b7a4] bg-[#fff0eb] px-4 py-3 text-sm text-[#7d2c1d]"
										>
											{reportError}
										</div>
									{/if}

									{#if reportFeedback}
										<div
											class="mt-3 rounded-[18px] border border-[#b7e6d4] bg-[#eefbf5] px-4 py-3 text-sm text-[#155544]"
										>
											{reportFeedback}
										</div>
									{/if}

									<div class="mt-4 space-y-2">
										<div class="flex items-center justify-between gap-3">
											<div>
												<p class="text-[10px] tracking-[0.28em] text-black/36 uppercase">
													Live feed
												</p>
												<p class="mt-1 text-sm text-black/58">
													Recent reports from riders around Phnom Penh.
												</p>
											</div>
											<span
												class="rounded-full border border-black/8 bg-[#f5f5f2] px-3 py-1 text-xs text-black/58"
											>
												{visibleIncidents.length} shown
											</span>
										</div>

										{#if incidentsQuery.isLoading}
											<div
												class="rounded-[20px] border border-black/8 bg-white px-4 py-3 text-sm text-black/58"
											>
												Loading live reports...
											</div>
										{:else if visibleIncidents.length === 0}
											<div
												class="rounded-[20px] border border-black/8 bg-white px-4 py-3 text-sm text-black/58"
											>
												No active incidents right now. Your next report will appear here.
											</div>
										{:else}
											{#each visibleIncidents as incident (incident._id)}
												<div
													class="rounded-[22px] border border-black/8 bg-white px-4 py-3.5 shadow-[0_8px_20px_rgba(0,0,0,0.03)]"
												>
													<div class="flex items-start justify-between gap-3">
														<div class="min-w-0 flex-1">
															<div class="flex flex-wrap items-center gap-2">
																<span
																	class={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${getIncidentAccentClass(incident.type)}`}
																>
																	{INCIDENT_LABELS[incident.type].en}
																</span>
																<span class="text-xs text-black/42">
																	{formatRelativeTime(incident.createdAt)}
																</span>
															</div>
															<p class="mt-2 text-sm font-medium text-[#171717]">
																{INCIDENT_LABELS[incident.type].en}
															</p>
															<p class="mt-1 text-sm leading-6 text-black/55">
																{incident.description ?? 'No note attached.'}
															</p>
														</div>

														{#if activeIncidentIds.has(incident._id)}
															<span
																class="shrink-0 rounded-full border border-black/8 bg-[#f5f5f2] px-3 py-1.5 text-xs font-medium text-black/62"
															>
																Your report
															</span>
														{:else}
															<button
																type="button"
																onclick={() => confirmIncident(incident._id)}
																disabled={incidentActionId === incident._id}
																class="shrink-0 rounded-full border border-black/8 bg-white px-3 py-1.5 text-xs font-medium text-black/82 hover:bg-black/[0.03] disabled:opacity-50"
															>
																{incidentActionId === incident._id ? 'Saving...' : 'Confirm'}
															</button>
														{/if}
													</div>

													<div class="mt-3 flex flex-wrap gap-2 text-xs text-black/54">
														<span
															class="rounded-full border border-black/8 bg-[#f5f5f2] px-2.5 py-1"
														>
															{Math.round(incident.confidenceScore * 100)}% confidence
														</span>
														<span
															class="rounded-full border border-black/8 bg-[#f5f5f2] px-2.5 py-1"
														>
															{currentLocation
																? formatCompactDistance(
																		haversineMeters(currentLocation, incident.location)
																	)
																: `${incident.location.lat.toFixed(3)}, ${incident.location.lng.toFixed(3)}`}
														</span>
														<span
															class="rounded-full border border-black/8 bg-[#f5f5f2] px-2.5 py-1"
														>
															{incident.location.lat.toFixed(3)}, {incident.location.lng.toFixed(3)}
														</span>
													</div>
												</div>
											{/each}
										{/if}
									</div>
								</div>
							{:else}
								<div class="pt-4">
									<div class="grid grid-cols-3 gap-2">
										<div class="rounded-[18px] bg-white/[0.05] px-3 py-3">
											<p class="text-[10px] tracking-[0.24em] text-white/40 uppercase">Trust</p>
											<p class="mt-1 text-xl font-semibold text-white/90">
												{meQuery.data?.trustScore?.toFixed(1) ?? '2.0'}
											</p>
										</div>
										<div class="rounded-[18px] bg-white/[0.05] px-3 py-3">
											<p class="text-[10px] tracking-[0.24em] text-white/40 uppercase">Reports</p>
											<p class="mt-1 text-xl font-semibold text-white/90">
												{meQuery.data?.reportsCount ?? 0}
											</p>
										</div>
										<div class="rounded-[18px] bg-white/[0.05] px-3 py-3">
											<p class="text-[10px] tracking-[0.24em] text-white/40 uppercase">Confirm</p>
											<p class="mt-1 text-xl font-semibold text-white/90">
												{meQuery.data?.confirmedCount ?? 0}
											</p>
										</div>
									</div>

									{#if drawerExpanded}
										<div class="mt-4 space-y-2">
											<a
												href={resolve('/app/proof')}
												class="block rounded-[20px] bg-white/[0.05] px-4 py-3 text-sm font-medium text-white/88"
											>
												Open delay proof
											</a>
											{#if myIncidents.length === 0}
												<div class="rounded-[20px] bg-white/[0.04] px-4 py-3 text-sm text-white/58">
													No incident history yet.
												</div>
											{:else}
												{#each myIncidents.slice(0, 4) as incident (incident._id)}
													<div class="rounded-[20px] bg-white/[0.04] px-4 py-3">
														<p class="text-sm font-medium text-white/88">
															{INCIDENT_LABELS[incident.type].en}
														</p>
														<p class="mt-1 text-sm text-white/55">
															{(incident.confidenceScore * 100).toFixed(0)}% confidence
														</p>
													</div>
												{/each}
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
