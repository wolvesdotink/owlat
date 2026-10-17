/**
 * A stale "Waiting on others" item (mail/nudges.ts) as an Answer queue row:
 * the same `followup` card a "Remind me if no reply" reminder makes, offering
 * "Draft a nudge". Kept beside `needsReply.ts`, which is at the file-size cap.
 *
 * Not a Convex function.
 */

import type { Infer } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import type { needsReplyClarificationValidator } from '../lib/validators/clarification';
import { urgencyFallbackScore } from './ai/priorityScore';
import { resolveCounterpartName } from './counterpartName';
import { modeOfMailbox, openBriefTop } from './interpret/briefTop';
import { itemNudge, type NudgeQueueRow } from './nudges';

/** The card of one nudge row, in `listQueue`'s follow-up shape. */
export async function nudgeQueueItem(ctx: QueryCtx, mailbox: Doc<'mailboxes'>, row: NudgeQueueRow) {
	const { thread, item, message } = row;
	const waitingOn = item.responsible.email ?? message.toAddresses[0] ?? message.fromAddress;
	return {
		kind: 'followup' as const,
		threadId: thread._id,
		messageId: message._id,
		urgency: 'normal' as const,
		priorityScore: urgencyFallbackScore('normal'),
		askSummary: undefined,
		dueHint: undefined,
		detectedAt: row.since,
		source: 'heuristic' as const,
		waitingOn,
		clarification: undefined as Infer<typeof needsReplyClarificationValidator> | undefined,
		hasDraftSlot: false,
		fromAddress: waitingOn,
		fromName:
			item.responsible.name?.trim() ||
			(await resolveCounterpartName(ctx, mailbox._id, thread._id, waitingOn)),
		subject: message.subject,
		snippet: thread.latestSnippet,
		receivedAt: message.receivedAt,
		briefTop: await openBriefTop(thread, modeOfMailbox(mailbox)),
		nudge: itemNudge(row),
	};
}
