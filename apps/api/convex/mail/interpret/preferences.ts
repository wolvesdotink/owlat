/**
 * "Open threads on: Overview / Conversation" (SPEC §2 `mailUserSettings`,
 * §7 Settings → Mail): the viewer's saved default view for personal threads.
 *
 * Self-scoped to the session user's `mailUserSettings` row. The write uses
 * `threadBriefMutation` (any of the Postbox flags or `inbox`), not
 * `postboxMutation`, so it also works on a team-only install.
 *
 * D1: a user who turned "auto-summarize" off and never chose a view keeps
 * Conversation as the default; everyone else defaults to Overview. A
 * per-thread override (`brief.setViewOverride`) wins over this default; a cite
 * link never writes either.
 */

import { v } from 'convex/values';
import type { ThreadView } from '@owlat/shared/threadBrief';
import { publicQuery } from '../../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../../lib/sessionOrganization';
import { threadViewValidator } from '../../lib/validators/threadBrief';
import { threadBriefMutation } from '../_helpers';

/** The effective default view (D1). Pure. */
export function resolveThreadDefaultView(
	row: { threadDefaultView?: ThreadView; isAutoSummarizeOn?: boolean } | null
): ThreadView {
	if (row?.threadDefaultView) return row.threadDefaultView;
	return row?.isAutoSummarizeOn === false ? 'conversation' : 'overview';
}

// public: soft-auth — returns null for anonymous; the row is self-scoped to
// the session user, so nothing leaks.
// authz: self-scoped — the settings row is keyed by the session user id.
export const getViewPreference = publicQuery({
	args: {},
	returns: v.union(
		v.null(),
		v.object({ threadDefaultView: threadViewValidator, isExplicit: v.boolean() })
	),
	handler: async (ctx) => {
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) return null;
		const row = await ctx.db
			.query('mailUserSettings')
			.withIndex('by_user', (q) => q.eq('userId', s.userId))
			.first();
		return {
			threadDefaultView: resolveThreadDefaultView(row),
			isExplicit: row?.threadDefaultView !== undefined,
		};
	},
});

export const setThreadDefaultView = threadBriefMutation({
	args: { view: threadViewValidator },
	// authz: self-scoped — upserts only the caller's own settings row (keyed by
	// the session userId; no cross-user id is accepted).
	handler: async (ctx, args, session) => {
		const existing = await ctx.db
			.query('mailUserSettings')
			.withIndex('by_user', (q) => q.eq('userId', session.userId))
			.first();
		const now = Date.now();
		if (existing) {
			await ctx.db.patch(existing._id, { threadDefaultView: args.view, updatedAt: now });
			return null;
		}
		await ctx.db.insert('mailUserSettings', {
			// A fresh row needs a concrete autoAdvance (mail/settings.ts does the same).
			autoAdvance: 'next',
			threadDefaultView: args.view,
			userId: session.userId,
			createdAt: now,
			updatedAt: now,
		});
		return null;
	},
});
