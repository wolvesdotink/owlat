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
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { throwInvalidInput } from '../_utils/errors';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { MAX_COEDIT_ID_LENGTH } from './sessionOps';

/** Upper bound on notices one tab is shown at a time. */
const MAX_NOTICES = 20;

/**
 * Whether the editor tab `clientId` is the caller's own. Tab ids are visible
 * to every member through `presence.list`, so the id alone does not prove it;
 * the tab's presence row names its user (`presence.heartbeat` never lets one
 * user take over another's tab id).
 */
async function isOwnTab(
	ctx: QueryCtx | MutationCtx,
	clientId: string,
	userId: string
): Promise<boolean> {
	const presence = await ctx.db
		.query('emailEditorPresence')
		.withIndex('by_client', (q) => q.eq('clientId', clientId))
		.first();
	return presence?.userId === userId;
}

/** The notices for one of the caller's editor tabs, oldest first. */
// authz: only the caller's own tab (its presence row names the caller, checked below)
export const listForClient = authedQuery({
	args: { clientId: v.string() },
	handler: async (ctx, args, session) => {
		if (args.clientId.length > MAX_COEDIT_ID_LENGTH)
			throwInvalidInput('The editor id is not valid.');
		if (!(await isOwnTab(ctx, args.clientId, session.userId))) return [];
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
// authz: only the caller's own tab the notice is addressed to can dismiss it (checked below)
export const dismiss = authedMutation({
	args: { noticeId: v.id('emailCoeditNotices'), clientId: v.string() },
	handler: async (ctx, args, session) => {
		const notice = await ctx.db.get(args.noticeId);
		if (
			notice &&
			notice.clientId === args.clientId &&
			(await isOwnTab(ctx, args.clientId, session.userId))
		) {
			await ctx.db.delete(notice._id);
		}
		return null;
	},
});
