/**
 * Read on arrival: the digest's state transitions that keep item text bounded.
 * Lane rules builds the digest and MUST move a digest through
 * these helpers, because message purge relies on what they guarantee
 * (`purgeRanges.ts`).
 *
 * INVARIANTS (`mailDigests`):
 *  1. Only a `generated` digest holds `items` (the sealed span lines).
 *     `claimed` has none yet. `failed` and `sent` keep `visited`,
 *     `overflowByKind` and `overflowLabel` (the counts and the consumption
 *     bookkeeping) and an empty `items`.
 *  2. A mailbox has at most ONE `generated` digest.
 *
 * {@link commitGeneratedDigest} is the ONLY legal writer of `state:
 * 'generated'` and of `items`. In one mutation it checks the claim token and
 * lease, retires every OTHER generated digest of the mailbox to `failed`
 * (stripped), and writes this one. Overlapping claims of different periods
 * may each commit; whichever commits last is the one generated digest (two
 * commits in flight conflict: each reads the range the other writes, so
 * Convex re-runs the later one against the earlier's result). Retiring at
 * claim time as well ({@link retireGeneratedDigests}) only shortens how long
 * a stale digest sits there.
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

/**
 * Generated digests read when retiring. The invariant holds before every
 * commit, so the range holds at most one row; the slack only covers rows a
 * pre-invariant writer may have left.
 */
const GENERATED_SCAN = 8;

/** Why {@link commitGeneratedDigest} refused to write. */
export type DigestCommitRefusal = 'missing' | 'not_claimed' | 'claim_mismatch' | 'lease_expired';

/**
 * Write a claimed digest's generated lines: the ONLY way a digest becomes
 * `generated` or gains `items`. Refuses (writes nothing) unless the digest is
 * `claimed` under `claimToken` with a live lease; then retires every other
 * generated digest of the mailbox and writes `items` (spans sealed by the
 * caller), `generatedAt` and any selection fields given.
 */
export async function commitGeneratedDigest(
	ctx: MutationCtx,
	args: {
		digestId: Id<'mailDigests'>;
		claimToken: string;
		items: Doc<'mailDigests'>['items'];
		visited?: Doc<'mailDigests'>['visited'];
		overflowByKind?: Doc<'mailDigests'>['overflowByKind'];
		overflowLabel?: Doc<'mailDigests'>['overflowLabel'];
		now: number;
	}
): Promise<{ ok: true } | { ok: false; reason: DigestCommitRefusal }> {
	const digest = await ctx.db.get(args.digestId);
	if (!digest) return { ok: false, reason: 'missing' };
	if (digest.state !== 'claimed') return { ok: false, reason: 'not_claimed' };
	if (digest.claimToken !== args.claimToken) return { ok: false, reason: 'claim_mismatch' };
	if (digest.claimUntil < args.now) return { ok: false, reason: 'lease_expired' };
	await retireOtherGenerated(ctx, digest.mailboxId, (other) => other._id !== digest._id);
	await ctx.db.patch(digest._id, {
		state: 'generated',
		items: args.items,
		generatedAt: args.now,
		...(args.visited ? { visited: args.visited } : {}),
		...(args.overflowByKind ? { overflowByKind: args.overflowByKind } : {}),
		...(args.overflowLabel ? { overflowLabel: args.overflowLabel } : {}),
	});
	return { ok: true };
}

/** Move the mailbox's generated digests that `isRetired` picks to `failed`, stripped. */
async function retireOtherGenerated(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	isRetired: (digest: Doc<'mailDigests'>) => boolean
): Promise<number> {
	const generated = await ctx.db
		.query('mailDigests')
		.withIndex('by_mailbox_state', (q) => q.eq('mailboxId', mailboxId).eq('state', 'generated'))
		.take(GENERATED_SCAN);
	let retired = 0;
	for (const digest of generated) {
		if (!isRetired(digest)) continue;
		await markDigestFailed(ctx, digest);
		retired += 1;
	}
	return retired;
}

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
 * At claim time, optionally: every generated digest of the mailbox for another
 * period goes to `failed`, stripped. Not what holds the invariant
 * ({@link commitGeneratedDigest} does); it only retires a stale digest sooner.
 */
export async function retireGeneratedDigests(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	periodKey: string
): Promise<number> {
	return retireOtherGenerated(ctx, mailboxId, (digest) => digest.periodKey !== periodKey);
}
