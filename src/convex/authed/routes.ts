import { v } from 'convex/values';
import { authedMutation, authedQuery } from './helpers';
import { findAuthedUser, getOrCreateAuthedUser } from './users';

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

export const listMine = authedQuery({
	args: {},
	handler: async (ctx) => {
		const user = await findAuthedUser(ctx);

		if (!user) {
			return [];
		}

		return await ctx.db
			.query('routeSessions')
			.withIndex('by_user_startedAt', (query) => query.eq('userId', user._id))
			.order('desc')
			.collect();
	}
});

export const createSession = authedMutation({
	args: {
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
		const user = await getOrCreateAuthedUser(ctx);

		const activeSession = (
			await ctx.db
				.query('routeSessions')
				.withIndex('by_user_startedAt', (query) => query.eq('userId', user._id))
				.order('desc')
				.take(10)
		).find((session) => session.arrivedAt === undefined);

		if (activeSession) {
			throw new Error('Complete your current trip before starting a new one.');
		}

		const routeSessionId = await ctx.db.insert('routeSessions', {
			userId: user._id,
			origin: args.origin,
			destination: args.destination,
			baselineEtaSec: args.baselineEtaSec,
			selectedRoute: args.selectedRoute,
			alternativeRoutes: args.alternativeRoutes,
			incidentIds: args.incidentIds,
			shortcutIds: args.shortcutIds,
			preferenceSnapshot: args.preferenceSnapshot,
			startedAt: args.startedAt,
			locationSamplesCount: 0,
			city: 'phnom_penh'
		});

		return await ctx.db.get(routeSessionId);
	}
});

export const appendSample = authedMutation({
	args: {
		routeSessionId: v.id('routeSessions'),
		location: geoPointValidator,
		recordedAt: v.number()
	},
	handler: async (ctx, args) => {
		const user = await findAuthedUser(ctx);

		if (!user) {
			throw new Error('User profile missing for this trip.');
		}

		const session = await ctx.db.get(args.routeSessionId);

		if (!session || session.userId !== user._id) {
			throw new Error('Route session not found');
		}

		if (session.arrivedAt !== undefined) {
			throw new Error('Trip already completed');
		}

		await ctx.db.insert('routeLocationSamples', args);

		const locationSamplesCount = session.locationSamplesCount + 1;
		await ctx.db.patch(args.routeSessionId, {
			locationSamplesCount
		});

		return { locationSamplesCount };
	}
});

export const completeSession = authedMutation({
	args: {
		routeSessionId: v.id('routeSessions'),
		location: geoPointValidator,
		recordedAt: v.number()
	},
	handler: async (ctx, args) => {
		const user = await findAuthedUser(ctx);

		if (!user) {
			throw new Error('User profile missing for this trip.');
		}

		const session = await ctx.db.get(args.routeSessionId);

		if (!session || session.userId !== user._id) {
			throw new Error('Route session not found');
		}

		if (session.arrivedAt !== undefined) {
			return session;
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
