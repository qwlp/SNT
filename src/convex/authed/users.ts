import { DEFAULT_TRUST_SCORE, SHORTCUT_SEEDS, UNIVERSITY_SEEDS } from '../../lib/domain/traffic';
import { authedMutation, authedQuery } from './helpers';

export const ensureProfile = authedMutation({
	args: {},
	handler: async (ctx) => {
		const [universities, shortcuts] = await Promise.all([
			ctx.db.query('universityPartners').collect(),
			ctx.db.query('shortcutSegments').collect()
		]);

		if (universities.length === 0) {
			const now = Date.now();
			for (const university of UNIVERSITY_SEEDS) {
				await ctx.db.insert('universityPartners', {
					universityId: university.id,
					name: university.name,
					shortName: university.shortName,
					targetUsers: university.targetUsers,
					repTarget: university.repTarget,
					city: 'phnom_penh',
					createdAt: now
				});
			}
		}

		if (shortcuts.length === 0) {
			const now = Date.now();
			for (const shortcut of SHORTCUT_SEEDS) {
				await ctx.db.insert('shortcutSegments', {
					name: shortcut.name,
					polyline: shortcut.polyline,
					weight: shortcut.weight,
					source: shortcut.source,
					active: true,
					city: 'phnom_penh',
					createdAt: now
				});
			}
		}

		const now = Date.now();
		const clerkId = ctx.identity.subject;
		const existing = await ctx.db
			.query('users')
			.withIndex('by_clerk', (query) => query.eq('clerkId', clerkId))
			.unique();

		const displayName =
			ctx.identity.name ?? ctx.identity.email?.split('@')[0] ?? ctx.identity.subject.slice(0, 8);

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
			clerkId,
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

		return await ctx.db.get(userId);
	}
});

export const me = authedQuery({
	args: {},
	handler: async (ctx) => {
		return await ctx.db
			.query('users')
			.withIndex('by_clerk', (query) => query.eq('clerkId', ctx.identity.subject))
			.unique();
	}
});
