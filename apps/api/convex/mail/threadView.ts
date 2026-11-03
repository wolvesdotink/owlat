/**
 * The reader view a person picked for one Postbox thread: the stacked
 * conversation, or the chat layout (one bubble per message, quoted history
 * and signature stripped).
 *
 * The choice is `threadViewerState.viewOverride` on the viewer's own row, so
 * it follows them across devices and leaves every other reader of the thread
 * alone. Personal mailboxes only: a team inbox has no view switch, and
 * `mail/interpret/scopeChange.ts` clears the overrides when a mailbox becomes
 * one.
 */

import { v } from 'convex/values';
import { getOrThrow, throwForbidden, throwInvalidState } from '../_utils/errors';
import { threadViewValidator } from '../lib/validators/threadBrief';
import { threadRefToFields, type ThreadRef } from '../lib/validators/threadRef';
import { postboxMutation, postboxQuery } from './_helpers';
import { requireMailboxAccess } from './permissions';
import { mailboxScope } from './mailbox/shared';
import { readViewerState } from './interpret/briefRead';
import { loadBriefRow } from './interpret/briefRow';

/** The caller's view of the thread, or null when they picked none (or may not read it). */
export const get = postboxQuery({
	args: { threadId: v.id('mailThreads') },
	returns: v.union(threadViewValidator, v.null()),
	handler: async (ctx, args, session) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return null;
		const owned = await requireMailboxAccess(ctx, thread.mailboxId, 'member', session);
		if (!owned.ok || mailboxScope(owned.mailbox) !== 'personal') return null;
		const row = await readViewerState(ctx, { kind: 'mail', id: thread._id }, session.userId);
		return row?.viewOverride ?? null;
	},
});

/** Remember the caller's view of the thread. */
export const set = postboxMutation({
	args: { threadId: v.id('mailThreads'), view: threadViewValidator },
	returns: v.null(),
	handler: async (ctx, args, session) => {
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const owned = await requireMailboxAccess(ctx, thread.mailboxId, 'member', session);
		if (!owned.ok) throwForbidden('Thread not accessible');
		if (mailboxScope(owned.mailbox) !== 'personal') {
			throwInvalidState('A team inbox thread has no view switch');
		}
		const ref: ThreadRef = { kind: 'mail', id: thread._id };
		const now = Date.now();
		const existing = await readViewerState(ctx, ref, session.userId);
		if (existing) {
			await ctx.db.patch(existing._id, { viewOverride: args.view, updatedAt: now });
			return null;
		}
		// The row also carries "since you last looked". Without a row the brief
		// shows nothing as new; a row starting at zero would mark its whole
		// history new, so it starts at the brief as it stands.
		const brief = await loadBriefRow(ctx, ref);
		await ctx.db.insert('threadViewerState', {
			...threadRefToFields(ref),
			userId: session.userId,
			viewOverride: args.view,
			seenInterpretationRevision: brief?.interpretationRevision ?? 0,
			seenActivitySeq: brief?.lastActivitySeq ?? 0,
			updatedAt: now,
		});
		return null;
	},
});
