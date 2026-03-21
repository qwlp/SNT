import type { Doc } from '../_generated/dataModel';
import { v } from 'convex/values';
import { privateMutation, privateQuery } from './helpers';

const geoPointValidator = v.object({
	lat: v.number(),
	lng: v.number()
});

const routeOptionValidator = v.object({
	routeId: v.string(),
	providerRouteId: v.optional(v.string()),
	label: v.string(),
	geometry: v.array(geoPointValidator),
	distanceMeters: v.number(),
	durationSec: v.number(),
	adjustedScore: v.number(),
	estimatedFuelLiters: v.number(),
	estimatedTollCostUsd: v.number(),
	explanationChips: v.array(v.string()),
	incidentIds: v.array(v.id('incidents')),
	shortcutIds: v.array(v.id('shortcutSegments'))
});

const routingPreferencesValidator = v.object({
	avoidHighways: v.boolean(),
	avoidUTurns: v.boolean(),
	preferWellLitStreets: v.boolean(),
	preferFewerTurns: v.boolean(),
	mode: v.union(
		v.literal('car'),
		v.literal('scooter'),
		v.literal('bike'),
		v.literal('pedestrian'),
		v.literal('heavy_vehicle')
	),
	costPriority: v.union(
		v.literal('balanced'),
		v.literal('fastest'),
		v.literal('lowest_tolls'),
		v.literal('lowest_fuel')
	)
});

export const createSession = privateMutation({
	args: {
		userId: v.id('users'),
		origin: geoPointValidator,
		destination: geoPointValidator,
		baselineEtaSec: v.number(),
		selectedRoute: routeOptionValidator,
		alternativeRoutes: v.array(routeOptionValidator),
		incidentIds: v.array(v.id('incidents')),
		shortcutIds: v.array(v.id('shortcutSegments')),
		preferenceSnapshot: routingPreferencesValidator,
		startedAt: v.number()
	},
	handler: async (ctx, args) => {
		const routeSessionId = await ctx.db.insert('routeSessions', {
			...args,
			locationSamplesCount: 0,
			city: 'phnom_penh'
		});

		return await ctx.db.get(routeSessionId);
	}
});

export const appendSample = privateMutation({
	args: {
		routeSessionId: v.id('routeSessions'),
		location: geoPointValidator,
		recordedAt: v.number()
	},
	handler: async (ctx, args) => {
		const session = await ctx.db.get(args.routeSessionId);
		if (!session) {
			throw new Error('Route session not found');
		}

		await ctx.db.insert('routeLocationSamples', args);
		await ctx.db.patch(args.routeSessionId, {
			locationSamplesCount: session.locationSamplesCount + 1
		});

		return { locationSamplesCount: session.locationSamplesCount + 1 };
	}
});

export const completeSession = privateMutation({
	args: {
		routeSessionId: v.id('routeSessions'),
		location: geoPointValidator,
		recordedAt: v.number()
	},
	handler: async (ctx, args) => {
		const session = await ctx.db.get(args.routeSessionId);
		if (!session) {
			throw new Error('Route session not found');
		}

		await ctx.db.insert('routeLocationSamples', args);
		const locationSamplesCount = session.locationSamplesCount + 1;
		const actualDurationSec = Math.max(0, Math.round((args.recordedAt - session.startedAt) / 1000));

		await ctx.db.patch(args.routeSessionId, {
			arrivedAt: args.recordedAt,
			locationSamplesCount,
			actualDurationSec
		});

		return await ctx.db.get(args.routeSessionId);
	}
});

export const getSessionForProof = privateQuery({
	args: {
		routeSessionId: v.id('routeSessions'),
		userId: v.id('users')
	},
	handler: async (ctx, args) => {
		const session = await ctx.db.get(args.routeSessionId);
		if (!session || session.userId !== args.userId) {
			return null;
		}

		const samples = (await ctx.db
			.query('routeLocationSamples')
			.collect()) as Doc<'routeLocationSamples'>[];
		const sessionSamples = samples.filter(
			(sample) => sample.routeSessionId === args.routeSessionId
		);

		const incidents = await Promise.all(
			session.incidentIds.map((incidentId: Doc<'incidents'>['_id']) => ctx.db.get(incidentId))
		);
		return {
			session,
			samples: sessionSamples,
			incidents: incidents.filter(Boolean)
		};
	}
});

export const listForUser = privateQuery({
	args: {
		userId: v.id('users')
	},
	handler: async (ctx, args) => {
		const sessions = (await ctx.db.query('routeSessions').collect()) as Doc<'routeSessions'>[];

		return sessions
			.filter((session) => session.userId === args.userId)
			.sort((left, right) => right.startedAt - left.startedAt);
	}
});
