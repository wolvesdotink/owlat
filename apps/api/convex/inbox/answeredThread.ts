/**
 * A Team Inbox reply settles the thread's older messages (#1346).
 *
 * An agent reply answers the inbound message it was drafted for, and the
 * Send lifecycle closes that message (`approved → sent`). Older messages of
 * the same conversation that the agent was still working on are answered too:
 * their AI draft or pending questions would otherwise stay selectable and
 * invite a second reply. Once the reply is sent they are archived (reason
 * `answered_in_thread`); what the agent had there (status, draft, questions)
 * moves into `answeredStash`. A closed message cannot be reopened by a late
 * pipeline step, and `recordDraftOutput` drops a late draft for one.
 *
 * Reversible: if that reply later bounces or fails, every message it settled
 * goes back to where it was (`restoreAnsweredTeamThread`). After the retention
 * window the stash is dropped for good (`purgeAnsweredStashes`).
 *
 * A person's work stays: a message whose draft someone edited or saved, or
 * that someone took over to write the reply, is left as it is. So is anything
 * newer than the answered message, and anything the agent is not working on
 * (an approved send, an update, a closed message).
 */

import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { ANSWERED_RETENTION_MS, withAnsweringReply } from '../mail/answeredReply';

/** The archive reason of a message a newer reply in its thread answered. */
export const ANSWERED_IN_THREAD = 'answered_in_thread';

type Stash = NonNullable<Doc<'inboundMessages'>['answeredStash']>;

/** Agent states whose draft or questions a newer reply makes obsolete. */
const AGENT_OPEN_STATES: ReadonlySet<string> = new Set([
	'classifying',
	'drafting',
	'draft_ready',
	'awaiting_clarification',
]);

function isAgentOpen(
	status: Doc<'inboundMessages'>['processingStatus']
): status is Stash['processingStatus'] {
	return AGENT_OPEN_STATES.has(status);
}

/** Whether a person has worked on this message's reply. */
function hasHumanWork(message: Doc<'inboundMessages'>): boolean {
	return (
		message.isDraftEdited === true ||
		message.draftSavedAt !== undefined ||
		message.manualTakeoverAt !== undefined
	);
}

/** Archived because a newer reply in its thread answered it. */
export function isAnsweredInThread(message: Doc<'inboundMessages'>): boolean {
	return message.processingStatus === 'archived' && message.archiveReason === ANSWERED_IN_THREAD;
}

async function threadMessages(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>
): Promise<Doc<'inboundMessages'>[]> {
	return await ctx.db
		.query('inboundMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.collect(); // bounded: one conversation's messages
}

/** The agent reply to `answeredId` was sent: settle the thread's older messages. */
export async function settleAnsweredTeamThread(
	ctx: MutationCtx,
	answeredId: Id<'inboundMessages'>,
	at: number
): Promise<void> {
	const answered = await ctx.db.get(answeredId);
	if (!answered?.threadId) return;
	for (const message of await threadMessages(ctx, answered.threadId)) {
		if (message._id === answered._id || message.receivedAt > answered.receivedAt) continue;
		// This reply answers it: a bounce obligation on it ends (SLA bookkeeping
		// only; a person's draft below stays exactly as it is).
		if (message.answerBouncedAt !== undefined) {
			await ctx.db.patch(message._id, { answerBouncedAt: undefined });
		}
		// Already settled by another sent reply: this one answers it too, so a
		// bounce of either alone leaves it answered.
		const stash = message.answeredStash;
		if (stash && isAnsweredInThread(message)) {
			if (stash.isUntracked || stash.byInboundMessageIds.includes(answered._id)) continue;
			// A distinct reply: it joins the set and renews retention (capped,
			// see MAX_TRACKED_ANSWERS in mail/answeredReply.ts).
			const next = withAnsweringReply(stash.byInboundMessageIds, answered._id, at);
			await ctx.db.patch(message._id, {
				answeredStash: {
					...stash,
					byInboundMessageIds: next.ids,
					...(next.at !== undefined ? { at: next.at } : {}),
					...(next.isUntracked ? { isUntracked: true as const } : {}),
				},
			});
			continue;
		}
		const status = message.processingStatus;
		if (!isAgentOpen(status) || hasHumanWork(message)) continue;
		const archived = await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: message._id,
			input: { to: 'archived', at, reason: ANSWERED_IN_THREAD },
		});
		if (!archived.ok) continue;
		await ctx.db.patch(message._id, {
			answeredStash: {
				byInboundMessageIds: [answered._id],
				at,
				processingStatus: status,
				...(message.draftResponse !== undefined ? { draftResponse: message.draftResponse } : {}),
				...(message.pendingClarification
					? { pendingClarification: message.pendingClarification }
					: {}),
			},
			draftResponse: undefined,
			pendingClarification: undefined,
		});
	}
}

/**
 * The agent reply to `answeredId` bounced or failed after it had settled the
 * thread: every message only it answered goes back to where the agent left
 * it; one another sent reply also answered stays archived. A message a person
 * has since reopened (no longer archived as answered) is left alone.
 */
export async function restoreAnsweredTeamThread(
	ctx: MutationCtx,
	answeredId: Id<'inboundMessages'>,
	at: number
): Promise<void> {
	const answered = await ctx.db.get(answeredId);
	if (!answered?.threadId) return;
	for (const message of await threadMessages(ctx, answered.threadId)) {
		const stash = message.answeredStash;
		// An untracked stash stays archived: its set no longer says who answered it.
		if (!stash || stash.isUntracked || !stash.byInboundMessageIds.includes(answeredId)) continue;
		if (!isAnsweredInThread(message)) {
			await ctx.db.patch(message._id, { answeredStash: undefined });
			continue;
		}
		// Another sent reply still answers it: it stays archived behind that one.
		const rest = stash.byInboundMessageIds.filter((id) => id !== answeredId);
		if (rest.length > 0) {
			await ctx.db.patch(message._id, { answeredStash: { ...stash, byInboundMessageIds: rest } });
			continue;
		}
		const reopened = await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: message._id,
			input:
				stash.processingStatus === 'awaiting_clarification'
					? {
							to: 'awaiting_clarification',
							at,
							reopenAnswered: true,
							...(stash.pendingClarification
								? { pendingClarification: stash.pendingClarification }
								: {}),
						}
					: {
							to: 'draft_ready',
							at,
							reopenAnswered: true,
							...(stash.draftResponse !== undefined ? { draftResponse: stash.draftResponse } : {}),
						},
		});
		if (reopened.ok) {
			await ctx.db.patch(message._id, {
				answeredStash: undefined,
				archiveReason: undefined,
				// Owed again, whatever came after it (inbox/sla/threadClock.ts).
				answerBouncedAt: at,
			});
		}
	}
}

/**
 * Per purge run: a read budget well under the transaction's 16 MiB (a Team
 * Inbox message can be large). The row that crosses it is still returned, so
 * every run makes progress.
 */
const PURGE_PAGE = { numItems: 32, maximumBytesRead: 4 * 1024 * 1024 } as const;

/** Drop the stashes older than the retention window: those messages stay answered. */
export const purgeAnsweredStashes = internalMutation({
	args: {},
	handler: async (ctx): Promise<{ purged: number }> => {
		const cutoff = Date.now() - ANSWERED_RETENTION_MS;
		const page = await ctx.db
			.query('inboundMessages')
			.withIndex('by_answered_stash_at', (q) =>
				q.gt('answeredStash.at', 0).lt('answeredStash.at', cutoff)
			)
			.paginate({ cursor: null, ...PURGE_PAGE });
		for (const row of page.page) await ctx.db.patch(row._id, { answeredStash: undefined });
		if (!page.isDone && page.page.length > 0) {
			await ctx.scheduler.runAfter(0, internal.inbox.answeredThread.purgeAnsweredStashes, {});
		}
		return { purged: page.page.length };
	},
});
