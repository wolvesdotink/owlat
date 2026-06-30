import { internalQuery } from './_generated/server';

// Internal query to get instance info for email
export const getTeamInfo = internalQuery({
	args: {},
	handler: async (ctx) => {
		// Get instance settings for default sender info
		const settings = await ctx.db
			.query('instanceSettings')
			.first();

		return {
			name: settings?.defaultFromName ?? null,
			defaultFromName: settings?.defaultFromName ?? null,
			defaultFromEmail: settings?.defaultFromEmail ?? null,
		};
	},
});
