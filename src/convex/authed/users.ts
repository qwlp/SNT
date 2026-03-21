import { DEFAULT_TRUST_SCORE } from '../../lib/domain/traffic';
import { DEFAULT_ROUTING_PREFERENCES } from '../../lib/domain/routing';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { v } from 'convex/values';
import { authedMutation, authedQuery } from './helpers';

type AuthedIdentity = {
	subject: string;
	name?: string | null;
	email?: string | null;
};

type AuthedQueryCtx = QueryCtx & { identity: AuthedIdentity };
type AuthedMutationCtx = MutationCtx & { identity: AuthedIdentity };

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

const getDisplayName = (identity: AuthedIdentity) =>
	identity.name ?? identity.email?.split('@')[0] ?? identity.subject.slice(0, 8);

export const findAuthedUser = async (ctx: AuthedQueryCtx | AuthedMutationCtx) =>
	await ctx.db
		.query('users')
		.withIndex('by_clerk', (query) => query.eq('clerkId', ctx.identity.subject))
		.unique();

export const getOrCreateAuthedUser = async (ctx: AuthedMutationCtx): Promise<Doc<'users'>> => {
	const now = Date.now();
	const displayName = getDisplayName(ctx.identity);
	const existing = await findAuthedUser(ctx);

	if (existing) {
		await ctx.db.patch(existing._id, {
			displayName,
			lastActiveAt: now,
			routingPreferences: existing.routingPreferences ?? DEFAULT_ROUTING_PREFERENCES
		});

		return {
			...existing,
			displayName,
			lastActiveAt: now,
			routingPreferences: existing.routingPreferences ?? DEFAULT_ROUTING_PREFERENCES
		};
	}

	const userId = await ctx.db.insert('users', {
		clerkId: ctx.identity.subject,
		displayName,
		phone: undefined,
		trustScore: DEFAULT_TRUST_SCORE,
		reportsCount: 0,
		confirmedCount: 0,
		role: 'citizen',
		city: 'phnom_penh',
		homeUniversityId: undefined,
		routingPreferences: DEFAULT_ROUTING_PREFERENCES,
		createdAt: now,
		lastActiveAt: now
	});

	const created = await ctx.db.get(userId);
	if (!created) {
		throw new Error('Unable to create user profile.');
	}

	return created;
};

export const ensureProfile = authedMutation({
	args: {},
	handler: async (ctx) => await getOrCreateAuthedUser(ctx)
});

export const me = authedQuery({
	args: {},
	handler: async (ctx) => await findAuthedUser(ctx)
});

export const updateRoutingPreferences = authedMutation({
	args: {
		routingPreferences: routingPreferencesValidator
	},
	handler: async (ctx, args) => {
		const user = await getOrCreateAuthedUser(ctx);

		await ctx.db.patch(user._id, {
			routingPreferences: args.routingPreferences,
			lastActiveAt: Date.now()
		});

		return await ctx.db.get(user._id);
	}
});
