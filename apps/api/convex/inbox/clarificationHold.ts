/**
 * A team message held on the agent's questions (#1343): when it still needs
 * someone, and who that someone is.
 *
 * Nothing drafts around an unanswered question any more, so a message can sit
 * in `awaiting_clarification` for as long as nobody answers. It belongs in the
 * Answer queue and may be asked about again (`processingLifecycle.
 * reconcileAbandonedClarifications`) only while its conversation is still
 * open: a thread someone resolved or closed needs no answer, and a notice
 * queued before that happened is not delivered (`push/dispatch.ts`).
 */

import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { listSharedInboxReaderIds } from './access';

/** Thread statuses that need no answer. */
const SETTLED_THREAD_STATUSES: ReadonlySet<string> = new Set(['resolved', 'closed']);

/** Whether `message` still waits on an answer to the agent's questions. */
export async function isClarificationLive(
	ctx: QueryCtx | MutationCtx,
	message: Pick<Doc<'inboundMessages'>, 'processingStatus' | 'threadId'>
): Promise<boolean> {
	if (message.processingStatus !== 'awaiting_clarification') return false;
	if (!message.threadId) return true;
	const thread = await ctx.db.get(message.threadId);
	return !thread || !SETTLED_THREAD_STATUSES.has(thread.status);
}

/**
 * Who has to answer the agent's questions: the message's assignee, else the
 * thread's, else every shared-inbox reader (owner / admin), the set that sees
 * the review queue. An assignee counts only while they still read the shared
 * inbox: one who left the organization or lost the role would get a notice
 * they cannot open, and nobody who can would hear of it.
 */
export async function resolveClarificationRecipients(
	ctx: MutationCtx,
	message: Pick<Doc<'inboundMessages'>, 'assignedTo' | 'threadId'>
): Promise<string[]> {
	const readers = await listSharedInboxReaderIds(ctx);
	const isReader = (userId: string | undefined): userId is string =>
		userId !== undefined && readers.includes(userId);
	if (isReader(message.assignedTo)) return [message.assignedTo];
	const thread = message.threadId ? await ctx.db.get(message.threadId) : null;
	if (isReader(thread?.assignedTo)) return [thread.assignedTo];
	return readers;
}
