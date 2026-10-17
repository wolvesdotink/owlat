/**
 * Read on arrival: the digest's state transitions that keep item text bounded
 * (SPEC §6.5). Lane rules builds the digest and MUST move a digest through
 * these helpers, because message purge relies on what they guarantee
 * (`purgeRanges.ts`).
 *
 * INVARIANTS (`mailDigests`):
 *  1. Only a `generated` digest holds `items` (the sealed span lines).
 *     `claimed` has none yet; generation writes items and `generated` in one
 *     mutation. `failed` and `sent` keep `visited`, `overflowByKind` and
 *     `overflowLabel` (the counts and the consumption bookkeeping) and an
 *     empty `items`.
 *  2. A mailbox has at most ONE `generated` digest. Claiming a period's
 *     digest first retires every older generated digest of the mailbox to
 *     `failed`, stripped ({@link retireGeneratedDigests}).
 *
 * So a purged message's quote can only sit in one row per mailbox, found by
 * one bounded `by_mailbox_state` read with no cursor.
 *
 * A sent digest's lines are not kept for display: the digest was delivered as
 * a mail (`sentMessageId`), which is what the person reads afterwards, and
 * nothing renders the row once it is sent.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';

/** Generated digests read when retiring; the invariant allows one. */
const GENERATED_SCAN = 8;

/** A digest that will not be sent: `failed`, its lines dropped, its counts kept. */
export async function markDigestFailed(
	ctx: MutationCtx,
	digest: Pick<Doc<'mailDigests'>, '_id'>
): Promise<void> {
	await ctx.db.patch(digest._id, { state: 'failed', items: [] });
}

/**
 * A generated digest was delivered: `sent`, its lines dropped, `visited` and
 * the counts kept for the consumption bookkeeping. Call in the mutation that
 * inserts the mail. False (and no write) when the digest is not `generated`.
 */
export async function markDigestSent(
	ctx: MutationCtx,
	digest: Pick<Doc<'mailDigests'>, '_id' | 'state'>,
	sent: { sentMessageId: Id<'mailMessages'>; sentAt: number }
): Promise<boolean> {
	if (digest.state !== 'generated') return false;
	await ctx.db.patch(digest._id, {
		state: 'sent',
		items: [],
		sentMessageId: sent.sentMessageId,
		sentAt: sent.sentAt,
	});
	return true;
}

/**
 * Before claiming the digest of `periodKey`: every other generated digest of
 * the mailbox goes to `failed`, stripped. Returns how many were retired.
 */
export async function retireGeneratedDigests(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	periodKey: string
): Promise<number> {
	const generated = await ctx.db
		.query('mailDigests')
		.withIndex('by_mailbox_state', (q) => q.eq('mailboxId', mailboxId).eq('state', 'generated'))
		.take(GENERATED_SCAN);
	let retired = 0;
	for (const digest of generated) {
		if (digest.periodKey === periodKey) continue;
		await markDigestFailed(ctx, digest);
		retired += 1;
	}
	return retired;
}
