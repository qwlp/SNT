import type { Doc } from '../_generated/dataModel';
import { privateQuery } from './helpers';

export const listActive = privateQuery({
	args: {},
	handler: async (ctx) => {
		const shortcuts = (await ctx.db
			.query('shortcutSegments')
			.collect()) as Doc<'shortcutSegments'>[];
		return shortcuts.filter((shortcut) => shortcut.city === 'phnom_penh' && shortcut.active);
	}
});
