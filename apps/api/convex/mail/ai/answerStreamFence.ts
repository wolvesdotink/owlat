/**
 * Answer mode and the stale fence (mail/interpret/staleFence.ts): which
 * Postbox thread an ask session's draft reads, and whether a "Draft with AI"
 * stream is a draft from a thread whose reading is now fenced off.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import type { AnswerAskTarget } from '../../lib/validators/answerAsk';
import { isThreadInterpretationFenced } from '../interpret/staleFence';

/** The Postbox thread a target replies in, or null (a team thread, a draft without one). */
export async function mailThreadOf(
	ctx: Pick<QueryCtx, 'db'>,
	target: AnswerAskTarget
): Promise<Id<'mailThreads'> | null> {
	if (target.kind !== 'mailDraft') return null;
	return (await ctx.db.get(target.draftId))?.threadId ?? null;
}

/**
 * Is an Answer mode stream a draft from a thread whose reading is fenced off
 * (interpret/staleFence.ts)? Resolved through the session that owns it, so
 * every stream is covered, whenever it was opened. Fails closed: an Answer
 * stream whose session or draft is gone reads as paused. Other streams
 * (revise, suggested replies) read the person's own draft, not the thread's
 * reading.
 */
export async function isAnswerStreamFenced(
	ctx: Pick<QueryCtx, 'db'>,
	stream: Pick<Doc<'aiDraftStreams'>, '_id' | 'surface'>
): Promise<boolean> {
	if (stream.surface !== 'answer') return false;
	const session = await ctx.db
		.query('answerAskSessions')
		.withIndex('by_stream', (q) => q.eq('streamId', stream._id))
		.first();
	if (!session) return true;
	if (session.target.kind !== 'mailDraft') return false;
	const draft = await ctx.db.get(session.target.draftId);
	if (!draft) return true;
	return draft.threadId !== undefined && isThreadInterpretationFenced(ctx, draft.threadId);
}
