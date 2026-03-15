import type { Doc } from '../_generated/dataModel';
import { v } from 'convex/values';
import {
	calculateIncidentExpiry,
	clampTrustScore,
	isPointInViewport
} from '../../lib/domain/traffic';
import { authedMutation, authedQuery } from './helpers';
import { findAuthedUser, getOrCreateAuthedUser } from './users';

const viewportValidator = v.optional(
	v.object({
		north: v.number(),
		south: v.number(),
		east: v.number(),
		west: v.number()
	})
);

const incidentTypeValidator = v.union(
	v.literal('roadblock'),
	v.literal('vip'),
	v.literal('wedding'),
	v.literal('flood'),
	v.literal('accident'),
	v.literal('police')
);

export const listActive = authedQuery({
	args: {
		viewport: viewportValidator
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const incidents = (await ctx.db.query('incidents').collect()) as Doc<'incidents'>[];

		return incidents
			.filter(
				(incident) =>
					incident.city === 'phnom_penh' &&
					incident.expiresAt > now &&
					incident.status === 'active' &&
					isPointInViewport(incident.location, args.viewport)
			)
			.sort((left, right) => right.createdAt - left.createdAt);
	}
});

export const create = authedMutation({
	args: {
		type: incidentTypeValidator,
		location: v.object({
			lat: v.number(),
			lng: v.number()
		}),
		description: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const user = await getOrCreateAuthedUser(ctx);

		const now = Date.now();
		const incidentId = await ctx.db.insert('incidents', {
			type: args.type,
			status: 'active',
			location: args.location,
			reporterUserId: user._id,
			reporterTrustAtCreate: user.trustScore,
			confidenceScore: Math.max(0.35, Math.min(0.8, user.trustScore / MAX_CONFIDENCE_DIVISOR)),
			expiresAt: calculateIncidentExpiry(args.type, now),
			city: 'phnom_penh',
			description: args.description,
			createdAt: now,
			updatedAt: now
		});

		await ctx.db.patch(user._id, {
			reportsCount: user.reportsCount + 1,
			lastActiveAt: now
		});

		return incidentId;
	}
});

const MAX_CONFIDENCE_DIVISOR = 4;

export const confirm = authedMutation({
	args: {
		incidentId: v.id('incidents')
	},
	handler: async (ctx, args) => {
		const user = await getOrCreateAuthedUser(ctx);

		const incident = await ctx.db.get(args.incidentId);

		if (!incident || incident.status !== 'active' || incident.expiresAt <= Date.now()) {
			throw new Error('Incident is no longer active');
		}

		if (incident.reporterUserId === user._id) {
			throw new Error('Self confirmation is not allowed');
		}

		const confirmations = (await ctx.db
			.query('incidentConfirmations')
			.collect()) as Doc<'incidentConfirmations'>[];
		const existingConfirmation =
			confirmations.find(
				(entry) => entry.incidentId === args.incidentId && entry.userId === user._id
			) ?? null;

		if (existingConfirmation) {
			throw new Error('Incident already confirmed by this user');
		}

		const now = Date.now();
		await ctx.db.insert('incidentConfirmations', {
			incidentId: args.incidentId,
			userId: user._id,
			vote: 'confirm',
			createdAt: now
		});

		const incidentConfirmations = (await ctx.db
			.query('incidentConfirmations')
			.collect()) as Doc<'incidentConfirmations'>[];
		const relatedConfirmations = incidentConfirmations.filter(
			(entry) => entry.incidentId === args.incidentId
		);

		const confidenceScore = Math.min(
			1,
			incident.confidenceScore +
				0.12 +
				clampTrustScore(user.trustScore) * 0.05 +
				relatedConfirmations.length * 0.03
		);

		await ctx.db.patch(args.incidentId, {
			confidenceScore,
			updatedAt: now
		});

		await ctx.db.patch(user._id, {
			confirmedCount: user.confirmedCount + 1,
			trustScore: clampTrustScore(user.trustScore + 0.08),
			lastActiveAt: now
		});

		const reporter = await ctx.db.get(incident.reporterUserId);
		if (reporter) {
			await ctx.db.patch(reporter._id, {
				trustScore: clampTrustScore(reporter.trustScore + 0.16),
				lastActiveAt: now
			});
		}

		return { confidenceScore };
	}
});

export const listMine = authedQuery({
	args: {},
	handler: async (ctx) => {
		const user = await findAuthedUser(ctx);

		if (!user) {
			return [];
		}

		const incidents = (await ctx.db.query('incidents').collect()) as Doc<'incidents'>[];

		return incidents
			.filter((incident) => incident.reporterUserId === user._id)
			.sort((left, right) => right.createdAt - left.createdAt);
	}
});
