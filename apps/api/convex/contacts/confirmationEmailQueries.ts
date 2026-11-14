/**
 * The instance's default sender, read by the system mails that go out under
 * it (the DOI confirmation and the delivery test).
 */
import { v } from 'convex/values';
import { internalQuery, type QueryCtx } from '../_generated/server';
import { checkEmailDomainVerification } from '../domains/domains';

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

/** The one sending-domain verdict, for an action that sends under the default sender. */
export const getSenderDomainVerification = internalQuery({
	args: { email: v.string() },
	handler: async (ctx, args) => await checkEmailDomainVerification(ctx, args.email),
});
