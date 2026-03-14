import { authedQuery } from './helpers';

export const listActive = authedQuery({
	args: {},
	handler: async (ctx) => {
		return await ctx.db
			.query('shortcutSegments')
			.withIndex('by_city_active', (query) => query.eq('city', 'phnom_penh').eq('active', true))
			.collect();
	}
});
