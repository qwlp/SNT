import { DEFAULT_TRUST_SCORE } from '../../lib/domain/traffic';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { authedMutation, authedQuery } from './helpers';

type AuthedIdentity = {
	subject: string;
	name?: string | null;
	email?: string | null;
};

type AuthedQueryCtx = QueryCtx & { identity: AuthedIdentity };
type AuthedMutationCtx = MutationCtx & { identity: AuthedIdentity };

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
			lastActiveAt: now
		});

		return {
			...existing,
			displayName,
			lastActiveAt: now
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
