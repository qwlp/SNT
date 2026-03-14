import type { Doc } from '../_generated/dataModel';
import { v } from 'convex/values';
import { clampTrustScore } from '../../lib/domain/traffic';
import { privateMutation, privateQuery } from './helpers';

export const getByClerkId = privateQuery({
	args: {
		clerkId: v.string()
	},
	handler: async (ctx, args) => {
		const users = (await ctx.db.query('users').collect()) as Doc<'users'>[];
		return users.find((user) => user.clerkId === args.clerkId) ?? null;
	}
});

export const patchTrust = privateMutation({
	args: {
		userId: v.id('users'),
		trustScore: v.number(),
		reportsCountDelta: v.optional(v.number()),
		confirmedCountDelta: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const user = await ctx.db.get(args.userId);

		if (!user) {
			throw new Error('User not found');
		}

		await ctx.db.patch(args.userId, {
			trustScore: clampTrustScore(args.trustScore),
			reportsCount: user.reportsCount + (args.reportsCountDelta ?? 0),
			confirmedCount: user.confirmedCount + (args.confirmedCountDelta ?? 0),
			lastActiveAt: Date.now()
		});

		return await ctx.db.get(args.userId);
	}
});
