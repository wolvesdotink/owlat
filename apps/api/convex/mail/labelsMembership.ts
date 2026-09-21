/**
 * Label MEMBERSHIP writes — the two row-level helpers behind every "add or
 * remove this label" mutation in `mail/labels.ts`.
 *
 * Split out for the ~500 LOC rule in CONVENTIONS.md, but they belong together
 * on their own terms: one writes a message, the other re-derives the thread
 * from its messages, and the ORDER matters. A thread carries a label when any
 * of its messages does, so the thread pass has to run after the message rows
 * are written — and once per touched thread, not once per message, or a batch
 * that labels twenty messages of one conversation pays twenty sibling scans.
 *
 * Callers gate mailbox access before they get here.
 */

import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';

/**
 * Write one message's label membership. Returns false when the message already
 * had the requested state (nothing patched), so batch callers can skip the
 * thread reconciliation for a no-op.
 */
export async function applyLabelToMessage(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>,
	labelId: Id<'mailLabels'>,
	add: boolean,
	now: number
): Promise<boolean> {
	const has = message.labelIds.includes(labelId);
	if (add === has) return false;

	// Bump modseq so IMAP CONDSTORE clients pick up the change
	const folder = await ctx.db.get(message.folderId);
	if (!folder) return false;
	const modseq = folder.highestModseq + 1;
	await ctx.db.patch(folder._id, { highestModseq: modseq, updatedAt: now });

	await ctx.db.patch(message._id, {
		labelIds: add
			? [...message.labelIds, labelId]
			: message.labelIds.filter((id) => id !== labelId),
		modseq,
		updatedAt: now,
	});
	return true;
}

/**
 * Re-derive whether a thread still carries a label from its messages, AFTER
 * their rows have been written. Done once per touched thread (not once per
 * message) so a batch that labels twenty messages of one conversation pays a
 * single sibling scan.
 */
export async function reconcileThreadLabel(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	labelId: Id<'mailLabels'>,
	now: number
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (!thread) return;
	const siblings = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.collect(); // bounded: one thread's messages
	const stillUsed = siblings.some((m) => m.labelIds.includes(labelId));
	if (stillUsed === thread.labelIds.includes(labelId)) return;
	const threadLabels = new Set(thread.labelIds);
	if (stillUsed) threadLabels.add(labelId);
	else threadLabels.delete(labelId);
	await ctx.db.patch(threadId, { labelIds: Array.from(threadLabels), updatedAt: now });
}
