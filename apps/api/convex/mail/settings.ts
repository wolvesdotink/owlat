/**
 * Per-user Postbox behavior preferences.
 *
 * One `mailUserSettings` row per BetterAuth user at most, spanning all of
 * the user's mailboxes (these are reader-behavior preferences of the
 * person, not properties of a mailbox). Currently a single preference:
 *
 *   - `autoAdvance` — what the thread reader does after the open message
 *     is triaged away (archive / trash / snooze / spam): open the next
 *     conversation in list order (default), the previous one, or go back
 *     to the list.
 *
 * Mirrors the vacation/forwarding modules' get/update shape; rows are
 * keyed by the session user rather than a mailbox id.
 */

import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { mailAutoAdvanceValidator } from '../lib/convexValidators';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';

// public: soft-auth — returns null for anonymous; the row is self-scoped to
// the session user, so nothing leaks.
export const get = publicQuery({
	args: {},
	handler: async (ctx) => {
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) return null;
		const row = await ctx.db
			.query('mailUserSettings')
			.withIndex('by_user', (q) => q.eq('userId', s.userId))
			.first();
		if (!row) return null;
		return { autoAdvance: row.autoAdvance };
	},
});

export const update = authedMutation({
	args: { autoAdvance: mailAutoAdvanceValidator },
	// authz: self-scoped — upserts only the caller's own settings row (keyed
	// by the session userId; no cross-user id is accepted).
	handler: async (ctx, args) => {
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s) return null; // unreachable past the authedMutation floor
		const existing = await ctx.db
			.query('mailUserSettings')
			.withIndex('by_user', (q) => q.eq('userId', s.userId))
			.first();
		const now = Date.now();
		if (existing) {
			await ctx.db.patch(existing._id, { autoAdvance: args.autoAdvance, updatedAt: now });
			return existing._id;
		}
		return ctx.db.insert('mailUserSettings', {
			userId: s.userId,
			autoAdvance: args.autoAdvance,
			createdAt: now,
			updatedAt: now,
		});
	},
});
