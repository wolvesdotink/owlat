/**
 * The instance's default sender, read by the system mails that go out under
 * it (the DOI confirmation and the delivery test).
 *
 * The builder's body is an exported helper, so the previous release's path
 * (`confirmationEmailQueries.ts` at the convex root) runs the same code.
 */
import { internalQuery, type QueryCtx } from '../_generated/server';

/** The instance's default sender name and address, from its settings row. */
export async function readTeamInfo(ctx: QueryCtx) {
	// Get instance settings for default sender info
	const settings = await ctx.db.query('instanceSettings').first();

	return {
		name: settings?.defaultFromName ?? null,
		defaultFromName: settings?.defaultFromName ?? null,
		defaultFromEmail: settings?.defaultFromEmail ?? null,
	};
}

export const getTeamInfo = internalQuery({
	args: {},
	handler: async (ctx) => await readTeamInfo(ctx),
});
