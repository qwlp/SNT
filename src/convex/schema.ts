import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

const cityValidator = v.literal('phnom_penh');
const geoPointValidator = v.object({
	lat: v.number(),
	lng: v.number()
});
const incidentTypeValidator = v.union(
	v.literal('roadblock'),
	v.literal('vip'),
	v.literal('wedding'),
	v.literal('flood'),
	v.literal('accident'),
	v.literal('police')
);
const incidentStatusValidator = v.union(v.literal('active'), v.literal('expired'));
const proofStatusValidator = v.union(v.literal('valid'), v.literal('revoked'));
const userRoleValidator = v.union(v.literal('citizen'), v.literal('campus_rep'));
const universityIdValidator = v.union(v.literal('rupp'), v.literal('itc'), v.literal('num'));
const routingModeValidator = v.union(
	v.literal('car'),
	v.literal('scooter'),
	v.literal('bike'),
	v.literal('pedestrian'),
	v.literal('heavy_vehicle')
);
const routingCostPriorityValidator = v.union(
	v.literal('balanced'),
	v.literal('fastest'),
	v.literal('lowest_tolls'),
	v.literal('lowest_fuel')
);
const routingPreferencesValidator = v.object({
	avoidHighways: v.boolean(),
	avoidUTurns: v.boolean(),
	preferWellLitStreets: v.boolean(),
	preferFewerTurns: v.boolean(),
	mode: routingModeValidator,
	costPriority: routingCostPriorityValidator
});
const routeOptionValidator = v.object({
	routeId: v.string(),
	providerRouteId: v.optional(v.string()),
	label: v.string(),
	geometry: v.array(geoPointValidator),
	distanceMeters: v.number(),
	durationSec: v.number(),
	adjustedScore: v.number(),
	estimatedFuelLiters: v.optional(v.number()),
	estimatedTollCostUsd: v.optional(v.number()),
	explanationChips: v.array(v.string()),
	incidentIds: v.array(v.id('incidents')),
	shortcutIds: v.array(v.id('shortcutSegments'))
});

export default defineSchema({
	users: defineTable({
		clerkId: v.string(),
		displayName: v.string(),
		phone: v.optional(v.string()),
		trustScore: v.number(),
		reportsCount: v.number(),
		confirmedCount: v.number(),
		role: userRoleValidator,
		city: cityValidator,
		homeUniversityId: v.optional(universityIdValidator),
		routingPreferences: v.optional(routingPreferencesValidator),
		createdAt: v.number(),
		lastActiveAt: v.number()
	}).index('by_clerk', ['clerkId']),
	incidents: defineTable({
		type: incidentTypeValidator,
		status: incidentStatusValidator,
		location: geoPointValidator,
		reporterUserId: v.id('users'),
		reporterTrustAtCreate: v.number(),
		confidenceScore: v.number(),
		expiresAt: v.number(),
		city: cityValidator,
		description: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_city_expiry', ['city', 'expiresAt'])
		.index('by_reporter', ['reporterUserId', 'createdAt']),
	incidentConfirmations: defineTable({
		incidentId: v.id('incidents'),
		userId: v.id('users'),
		vote: v.literal('confirm'),
		createdAt: v.number()
	})
		.index('by_incident', ['incidentId', 'createdAt'])
		.index('by_incident_user', ['incidentId', 'userId']),
	shortcutSegments: defineTable({
		name: v.string(),
		polyline: v.array(geoPointValidator),
		weight: v.number(),
		city: cityValidator,
		source: v.string(),
		active: v.boolean(),
		createdAt: v.number()
	}).index('by_city_active', ['city', 'active']),
	routeSessions: defineTable({
		userId: v.id('users'),
		origin: geoPointValidator,
		destination: geoPointValidator,
		baselineEtaSec: v.number(),
		selectedRoute: routeOptionValidator,
		alternativeRoutes: v.array(routeOptionValidator),
		incidentIds: v.array(v.id('incidents')),
		shortcutIds: v.array(v.id('shortcutSegments')),
		preferenceSnapshot: v.optional(routingPreferencesValidator),
		startedAt: v.number(),
		arrivedAt: v.optional(v.number()),
		locationSamplesCount: v.number(),
		actualDurationSec: v.optional(v.number()),
		city: cityValidator
	}).index('by_user_startedAt', ['userId', 'startedAt']),
	routeLocationSamples: defineTable({
		routeSessionId: v.id('routeSessions'),
		location: geoPointValidator,
		recordedAt: v.number()
	}).index('by_route_session', ['routeSessionId', 'recordedAt']),
	proofCertificates: defineTable({
		userId: v.id('users'),
		routeSessionId: v.id('routeSessions'),
		universityId: universityIdValidator,
		delayMinutes: v.number(),
		token: v.string(),
		pdfStorageId: v.optional(v.string()),
		status: proofStatusValidator,
		issuedAt: v.number(),
		verifiedAt: v.optional(v.number()),
		city: cityValidator,
		evidenceSummary: v.array(v.string()),
		routeExplanationChips: v.array(v.string()),
		incidentIds: v.array(v.id('incidents'))
	})
		.index('by_token', ['token'])
		.index('by_user_issuedAt', ['userId', 'issuedAt'])
		.index('by_route_session', ['routeSessionId']),
	universityPartners: defineTable({
		universityId: universityIdValidator,
		name: v.string(),
		shortName: v.string(),
		targetUsers: v.number(),
		repTarget: v.number(),
		city: cityValidator,
		createdAt: v.number()
	}).index('by_university_id', ['universityId'])
});
