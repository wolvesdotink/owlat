/**
 * A Team Inbox reply settles the thread's older messages (#1346).
 *
 * An agent reply answers the inbound message it was drafted for, and the
 * Send lifecycle closes that message (`approved → sent`). Older messages of
 * the same conversation that the agent was still working on are answered too:
 * their AI draft or pending questions would otherwise stay selectable and
 * invite a second reply. Once the reply is sent they are archived (reason
 * `answered_in_thread`), which drops the draft and the questions; a late
 * pipeline step cannot reopen an archived message, and `recordDraftOutput`
 * drops a late draft for one.
 *
 * A person's work stays: a message whose draft someone edited or saved, or
 * that someone took over to write the reply, is left as it is. So is anything
 * newer than the answered message, and anything the agent is not working on
 * (an approved send, an update, a closed message).
 */

import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';

/** The archive reason of a message a newer reply in its thread answered. */
export const ANSWERED_IN_THREAD = 'answered_in_thread';

/** Agent states whose draft or questions a newer reply makes obsolete. */
const AGENT_OPEN_STATES: ReadonlySet<Doc<'inboundMessages'>['processingStatus']> = new Set([
	'classifying',
	'drafting',
	'draft_ready',
	'awaiting_clarification',
]);

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

/** The agent reply to `answeredId` was sent: settle the thread's older messages. */
export async function settleAnsweredTeamThread(
	ctx: MutationCtx,
	answeredId: Id<'inboundMessages'>,
	at: number
): Promise<void> {
	const answered = await ctx.db.get(answeredId);
	if (!answered?.threadId) return;
	const threadId = answered.threadId;
	const messages = await ctx.db
		.query('inboundMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.collect(); // bounded: one conversation's messages
	for (const message of messages) {
		if (message._id === answered._id || message.receivedAt > answered.receivedAt) continue;
		if (!AGENT_OPEN_STATES.has(message.processingStatus) || hasHumanWork(message)) continue;
		await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: message._id,
			input: { to: 'archived', at, reason: ANSWERED_IN_THREAD },
		});
	}
}
