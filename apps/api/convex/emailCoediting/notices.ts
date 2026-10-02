/**
 * "Your change to this block was replaced" (docs/adr/0071-email-coediting.md).
 *
 * `sessions.ts:applyOps` writes a notice when an edit overwrote a block or
 * field another editor tab wrote after the sender last saw it. The notice is
 * addressed to that tab (`clientId`) and carries the replaced value, so the
 * tab can show who replaced it and put it back. Notices are transient: the
 * tab dismisses them, and the sweep drops them after an hour.
 */

import { v } from 'convex/values';
import { throwInvalidInput } from '../_utils/errors';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { MAX_COEDIT_ID_LENGTH } from './sessionOps';

/** Upper bound on notices one tab is shown at a time. */
const MAX_NOTICES = 20;

/** The notices for one editor tab, oldest first. */
// all-members: a notice holds a block of an email every member can read; scoped to the caller's tab id
export const listForClient = authedQuery({
	args: { clientId: v.string() },
	handler: async (ctx, args) => {
		if (args.clientId.length > MAX_COEDIT_ID_LENGTH)
			throwInvalidInput('The editor id is not valid.');
		const rows = await ctx.db
			.query('emailCoeditNotices')
			.withIndex('by_client', (q) => q.eq('clientId', args.clientId))
			.take(MAX_NOTICES);
		return rows.map((row) => ({
			noticeId: row._id,
			key: row.key,
			replacedBy: row.replacedBy,
			replacedValue: row.replacedValue,
			createdAt: row.createdAt,
		}));
	},
});

/** Dismiss a notice (after reading it or putting the change back). */
// authz: only the tab the notice is addressed to can dismiss it (clientId checked below)
export const dismiss = authedMutation({
	args: { noticeId: v.id('emailCoeditNotices'), clientId: v.string() },
	handler: async (ctx, args) => {
		const notice = await ctx.db.get(args.noticeId);
		if (notice && notice.clientId === args.clientId) await ctx.db.delete(notice._id);
		return null;
	},
});
