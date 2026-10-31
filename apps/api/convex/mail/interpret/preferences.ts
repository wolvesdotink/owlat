/**
 * Read on arrival: `mailUserSettings.isReadOnArrival`, absent = on, written
 * through `mail/settings.ts update`; read here by the run's depth decision and
 * the deferral (`isReadOnArrivalOn`) and by the reader and Settings
 * (`getArrivalPreference`, self-scoped to the session user's row).
 */

import { v } from 'convex/values';
import { publicQuery } from '../../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../../lib/sessionOrganization';
import { internalQuery, type QueryCtx } from '../../_generated/server';

/**
 * Read on arrival: whether `userId` lets their AI provider read
 * personal mail when it arrives, including mail they never open. Absent = on.
 */
export async function isReadOnArrivalOn(
	ctx: Pick<QueryCtx, 'db'>,
	userId: string
): Promise<boolean> {
	const row = await ctx.db
		.query('mailUserSettings')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.first();
	return row?.isReadOnArrival !== false;
}

/** {@link isReadOnArrivalOn} for an action (the digest, final review F2). */
export const readOnArrivalOf = internalQuery({
	args: { userId: v.string() },
	handler: (ctx, args): Promise<boolean> => isReadOnArrivalOn(ctx, args.userId),
});

/** Read on arrival: the viewer's own preference, for the reader and Settings. */
// public: soft-auth — returns null for anonymous; the row is self-scoped to
// the session user, so nothing leaks.
// authz: self-scoped — the settings row is keyed by the session user id.
export const getArrivalPreference = publicQuery({
	args: {},
	returns: v.union(v.null(), v.object({ isReadOnArrival: v.boolean() })),
	handler: async (ctx) => {
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) return null;
		return { isReadOnArrival: await isReadOnArrivalOn(ctx, s.userId) };
	},
});
