import { command, getRequestEvent, query } from '$app/server';
import { Effect } from 'effect';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { DEFAULT_ROUTING_PREFERENCES, type RoutingPreferences } from '$lib/domain/routing';
import { effectRunner, createGenericError } from '$lib/runtime';
import { CITY, UNIVERSITY_SEEDS, type GeoPoint, type UniversityId } from '$lib/domain/traffic';
import { requestRankedRoutes } from '$lib/services/route-engine';
import { buildProofPdf, evaluateProofEligibility } from '$lib/services/proof';
import { ClerkService } from '$lib/services/clerk';
import { ConvexPrivateService } from '$lib/services/convex';

const toRouteSessionId = (value: string) => value as Id<'routeSessions'>;

const getAuthenticatedTrafficUser = Effect.gen(function* () {
	const event = getRequestEvent();
	const clerk = yield* ClerkService;
	const convex = yield* ConvexPrivateService;
	const authUser = yield* clerk.validateAuth(event);
	const trafficUser = yield* convex.query({
		func: api.private.users.getByClerkId,
		args: {
			clerkId: authUser.id
		}
	});

	if (!trafficUser) {
		return yield* Effect.fail(
			createGenericError({
				message: 'Traffic profile missing. Refresh the app and try again.',
				status: 401,
				kind: 'profile_missing'
			})
		);
	}

	return {
		authUser,
		trafficUser,
		origin: event.url.origin
	};
});

export const requestRoute = query(
	'unchecked',
	async ({
		origin,
		destination,
		preferences = DEFAULT_ROUTING_PREFERENCES
	}: {
		origin: GeoPoint;
		destination: GeoPoint;
		preferences?: RoutingPreferences;
	}) =>
		await effectRunner(
			Effect.gen(function* () {
				yield* getAuthenticatedTrafficUser;
				return yield* requestRankedRoutes({ origin, destination, preferences }).pipe(
					Effect.mapError((error) =>
						createGenericError({
							message: error instanceof Error ? error.message : 'Unable to request routes.',
							status: 502,
							kind: 'route_request_failed',
							cause: error
						})
					)
				);
			})
		)
);

export const trafficDashboard = query(
	async () =>
		await effectRunner(
			Effect.gen(function* () {
				const { trafficUser } = yield* getAuthenticatedTrafficUser;
				const convex = yield* ConvexPrivateService;
				const [routeSessions, certificates] = yield* Effect.all([
					convex.query({
						func: api.private.routes.listForUser,
						args: {
							userId: trafficUser._id
						}
					}),
					convex.query({
						func: api.private.proofs.listForUser,
						args: {
							userId: trafficUser._id
						}
					})
				]);

				return {
					city: CITY,
					user: trafficUser,
					routeSessions,
					certificates,
					universities: UNIVERSITY_SEEDS
				};
			})
		)
);

export const startTrip = command(
	'unchecked',
	async ({
		routeId,
		origin,
		destination,
		preferences = DEFAULT_ROUTING_PREFERENCES
	}: {
		routeId: string;
		origin: GeoPoint;
		destination: GeoPoint;
		preferences?: RoutingPreferences;
	}) =>
		await effectRunner(
			Effect.gen(function* () {
				const { trafficUser } = yield* getAuthenticatedTrafficUser;
				const convex = yield* ConvexPrivateService;
				const rankedRoutes = yield* requestRankedRoutes({ origin, destination, preferences }).pipe(
					Effect.mapError((error) =>
						createGenericError({
							message: error instanceof Error ? error.message : 'Unable to request routes.',
							status: 502,
							kind: 'route_request_failed',
							cause: error
						})
					)
				);
				const selectedRoute = rankedRoutes.routes.find(
					(route: { routeId: string }) => route.routeId === routeId
				);

				if (!selectedRoute) {
					return yield* Effect.fail(
						createGenericError({
							message: 'Selected route is no longer available.',
							status: 400,
							kind: 'route_missing'
						})
					);
				}

				return yield* convex.mutation({
					func: api.private.routes.createSession,
					args: {
						userId: trafficUser._id,
						origin,
						destination,
						baselineEtaSec: selectedRoute.durationSec,
						selectedRoute,
						alternativeRoutes: rankedRoutes.routes.filter(
							(route: { routeId: string }) => route.routeId !== routeId
						),
						incidentIds: selectedRoute.incidentIds,
						shortcutIds: selectedRoute.shortcutIds,
						preferenceSnapshot: preferences,
						startedAt: Date.now()
					}
				});
			})
		)
);

export const appendTripSample = command(
	'unchecked',
	async ({
		routeSessionId,
		location,
		recordedAt
	}: {
		routeSessionId: string;
		location: GeoPoint;
		recordedAt: number;
	}) =>
		await effectRunner(
			Effect.gen(function* () {
				yield* getAuthenticatedTrafficUser;
				const convex = yield* ConvexPrivateService;

				return yield* convex.mutation({
					func: api.private.routes.appendSample,
					args: {
						routeSessionId: toRouteSessionId(routeSessionId),
						location,
						recordedAt
					}
				});
			})
		)
);

export const completeTrip = command(
	'unchecked',
	async ({
		routeSessionId,
		location,
		recordedAt
	}: {
		routeSessionId: string;
		location: GeoPoint;
		recordedAt: number;
	}) =>
		await effectRunner(
			Effect.gen(function* () {
				yield* getAuthenticatedTrafficUser;
				const convex = yield* ConvexPrivateService;

				return yield* convex.mutation({
					func: api.private.routes.completeSession,
					args: {
						routeSessionId: toRouteSessionId(routeSessionId),
						location,
						recordedAt
					}
				});
			})
		)
);

export const requestProof = command(
	'unchecked',
	async ({
		routeSessionId,
		universityId
	}: {
		routeSessionId: string;
		universityId: UniversityId;
	}) =>
		await effectRunner(
			Effect.gen(function* () {
				const { authUser, trafficUser, origin } = yield* getAuthenticatedTrafficUser;
				const convex = yield* ConvexPrivateService;
				const proofContext = yield* convex.query({
					func: api.private.routes.getSessionForProof,
					args: {
						routeSessionId: toRouteSessionId(routeSessionId),
						userId: trafficUser._id
					}
				});

				if (!proofContext) {
					return yield* Effect.fail(
						createGenericError({
							message: 'Trip not found.',
							status: 404,
							kind: 'trip_missing'
						})
					);
				}

				const eligibility = yield* evaluateProofEligibility({
					baselineEtaSec: proofContext.session.baselineEtaSec,
					actualDurationSec: proofContext.session.actualDurationSec,
					locationSamplesCount: proofContext.session.locationSamplesCount,
					arrivedAt: proofContext.session.arrivedAt,
					incidentCount: proofContext.incidents.length,
					routeExplanationChips: proofContext.session.selectedRoute.explanationChips
				});

				if (!eligibility.eligible) {
					return yield* Effect.fail(
						createGenericError({
							message: eligibility.reasons.join(' '),
							status: 400,
							kind: 'proof_ineligible'
						})
					);
				}

				const token = crypto.randomUUID();
				const certificate = yield* convex.mutation({
					func: api.private.proofs.createCertificate,
					args: {
						userId: trafficUser._id,
						routeSessionId: toRouteSessionId(routeSessionId),
						universityId,
						delayMinutes: eligibility.delayMinutes,
						token,
						evidenceSummary: eligibility.evidenceSummary,
						routeExplanationChips: proofContext.session.selectedRoute.explanationChips,
						incidentIds: proofContext.session.incidentIds
					}
				});

				const verificationUrl = `${origin}/verify/${certificate.token}`;
				yield* buildProofPdf({
					token: certificate.token,
					universityId: certificate.universityId,
					issuedAt: certificate.issuedAt,
					delayMinutes: certificate.delayMinutes,
					studentName:
						authUser.fullName ??
						authUser.primaryEmailAddress?.emailAddress ??
						trafficUser.displayName,
					evidenceSummary: certificate.evidenceSummary,
					verificationUrl
				}).pipe(
					Effect.mapError((error) =>
						createGenericError({
							message:
								error instanceof Error ? error.message : 'Failed to generate certificate PDF.',
							status: 500,
							kind: 'proof_pdf_failed',
							cause: error
						})
					)
				);

				return {
					...certificate,
					verificationUrl,
					pdfUrl: `${origin}/verify/${certificate.token}/certificate.pdf`
				};
			})
		)
);
