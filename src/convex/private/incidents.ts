import type { Doc } from '../_generated/dataModel';
import { v } from 'convex/values';
import {
	calculateIncidentExpiry,
	clampTrustScore,
	isPointInViewport
} from '../../lib/domain/traffic';
import { privateMutation, privateQuery } from './helpers';

const incidentTypeValidator = v.union(
	v.literal('roadblock'),
	v.literal('vip'),
	v.literal('wedding'),
	v.literal('flood'),
	v.literal('accident'),
	v.literal('police')
);

const viewportValidator = v.optional(
	v.object({
		north: v.number(),
		south: v.number(),
		east: v.number(),
		west: v.number()
	})
);

export const createInternal = privateMutation({
	args: {
		type: incidentTypeValidator,
		location: v.object({
			lat: v.number(),
			lng: v.number()
		}),
		reporterUserId: v.id('users'),
		description: v.optional(v.string()),
		timestamp: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const reporter = await ctx.db.get(args.reporterUserId);

		if (!reporter) {
			throw new Error('Reporter not found');
		}

		const now = args.timestamp ?? Date.now();
		return await ctx.db.insert('incidents', {
			type: args.type,
			status: 'active',
			location: args.location,
			reporterUserId: args.reporterUserId,
			reporterTrustAtCreate: reporter.trustScore,
			confidenceScore: Math.max(0.35, Math.min(0.8, reporter.trustScore / 4)),
			expiresAt: calculateIncidentExpiry(args.type, now),
			city: 'phnom_penh',
			description: args.description,
			createdAt: now,
			updatedAt: now
		});
	}
});

export const updateConfidence = privateMutation({
	args: {
		incidentId: v.id('incidents'),
		confidenceScore: v.number(),
		status: v.optional(v.union(v.literal('active'), v.literal('expired')))
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.incidentId, {
			confidenceScore: Math.max(0, Math.min(1, args.confidenceScore)),
			status: args.status,
			updatedAt: Date.now()
		});

		return await ctx.db.get(args.incidentId);
	}
});

export const expireStale = privateMutation({
	args: {
		now: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const now = args.now ?? Date.now();
		const incidents = (await ctx.db.query('incidents').collect()) as Doc<'incidents'>[];

		let expiredCount = 0;
		for (const incident of incidents) {
			if (
				incident.status === 'expired' ||
				incident.city !== 'phnom_penh' ||
				incident.expiresAt >= now
			) {
				continue;
			}

			expiredCount += 1;
			await ctx.db.patch(incident._id, {
				status: 'expired',
				updatedAt: now
			});

			if (incident.confidenceScore < 0.55) {
				const reporter = await ctx.db.get(incident.reporterUserId);
				if (reporter) {
					await ctx.db.patch(reporter._id, {
						trustScore: clampTrustScore(reporter.trustScore - 0.18),
						lastActiveAt: now
					});
				}
			}
		}

		return { expiredCount };
	}
});

export const listForRouteWindow = privateQuery({
	args: {
		startedAt: v.number(),
		endedAt: v.optional(v.number()),
		viewport: viewportValidator
	},
	handler: async (ctx, args) => {
		const incidents = (await ctx.db.query('incidents').collect()) as Doc<'incidents'>[];

		const end = args.endedAt ?? Date.now();

		return incidents.filter(
			(incident: Doc<'incidents'>) =>
				incident.city === 'phnom_penh' &&
				incident.createdAt <= end &&
				incident.status === 'active' &&
				incident.expiresAt >= args.startedAt &&
				isPointInViewport(incident.location, args.viewport)
		);
	}
});
