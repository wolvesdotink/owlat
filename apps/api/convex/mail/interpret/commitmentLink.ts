/**
 * Link a Daily Brief commitment (`mailCommitments`, `mail/commitments.ts`) to
 * the thread brief item for the same obligation (SPEC §5 "Commitments").
 *
 * Both are derived from one message, independently and in either order: the
 * commitment extraction runs from the sweep, the interpretation from ingest
 * or the send. So both writers call {@link linkCommitmentsForMessage} after
 * they write (`commitments.applyCommitment`, and `reduce.applyInterpretation`
 * after it inserts items for a mail source), and whichever lands second
 * makes the link:
 *   - `mailCommitments.threadItemId` → the item;
 *   - `threadItems.commitmentId` → the commitment (when the item has none).
 *
 * The match: an item of the commitment's thread that the owner is
 * responsible for (`responsibility: 'us'`) and whose evidence quotes the
 * commitment's message. An outbound commitment (a promise the owner made)
 * prefers a `promise` item; an inbound one (a deadline someone gave the
 * owner) prefers the ask. Then an item with a due date, then the oldest.
 *
 * Only the link is written. Status stays apart: the commitment's reminder
 * state (`open → reminded → done | lapsed`) lives on the commitment, and the
 * item's lifecycle on the item; closing one never closes the other. Linking
 * does not bump the item's revision (nothing about the obligation changed).
 *
 * Isolate-safe helper, no Convex functions.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';

/** Items of one thread read per status when matching (a thread has a handful). */
const ITEM_READ_LIMIT = 100;

type LinkItem = Pick<
	Doc<'threadItems'>,
	'_id' | 'intent' | 'responsibility' | 'evidence' | 'due' | 'askedAt' | 'commitmentId'
>;

function quotesMessage(item: LinkItem, messageId: Id<'mailMessages'>): boolean {
	return item.evidence.some(
		(e) =>
			(e.source.kind === 'mail' || e.source.kind === 'outboundMail') && e.source.id === messageId
	);
}

/** The item a commitment tracks, or null. Pure. */
export function pickCommitmentItem<T extends LinkItem>(
	commitment: Pick<Doc<'mailCommitments'>, '_id' | 'messageId' | 'direction'>,
	items: readonly T[]
): T | null {
	const candidates = items.filter(
		(item) =>
			item.responsibility === 'us' &&
			quotesMessage(item, commitment.messageId) &&
			(item.commitmentId === undefined || item.commitmentId === commitment._id)
	);
	const wantsPromise = commitment.direction === 'outbound';
	const rank = (item: T) =>
		((item.intent === 'promise') === wantsPromise ? 0 : 2) + (item.due ? 0 : 1);
	return [...candidates].sort((a, b) => rank(a) - rank(b) || a.askedAt - b.askedAt)[0] ?? null;
}

/** Link every commitment of `messageId` that has no live item link yet. */
export async function linkCommitmentsForMessage(
	ctx: MutationCtx,
	messageId: Id<'mailMessages'>
): Promise<void> {
	const commitments = await ctx.db
		.query('mailCommitments')
		.withIndex('by_message', (q) => q.eq('messageId', messageId))
		.take(2); // bounded: one per direction (the dedup key)
	for (const commitment of commitments) {
		if (commitment.threadItemId && (await ctx.db.get(commitment.threadItemId))) continue;
		const items: Doc<'threadItems'>[] = [];
		for (const status of ['open', 'done'] as const) {
			items.push(
				...(await ctx.db
					.query('threadItems')
					.withIndex('by_mail_thread_and_status', (q) =>
						q.eq('mailThreadId', commitment.threadId).eq('status', status)
					)
					.take(ITEM_READ_LIMIT))
			);
		}
		const item = pickCommitmentItem(commitment, items);
		if (!item) continue;
		await ctx.db.patch(commitment._id, { threadItemId: item._id, updatedAt: Date.now() });
		if (item.commitmentId === undefined) {
			await ctx.db.patch(item._id, { commitmentId: commitment._id });
		}
	}
}
