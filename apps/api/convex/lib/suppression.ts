/**
 * Suppression lookup (helper) — the single read over `blockedEmails`.
 *
 * `blockedEmails` is the CAN-SPAM / Gmail-Yahoo honor-suppression boundary: a
 * recipient on it (hard bounce / spam complaint / manual block) must never
 * receive mail. Three send paths gate on it — the transactional intake
 * (`transactional/dispatch.ts`), the non-campaign writer
 * (`delivery/enqueue.ts`), and audience resolution
 * (`campaigns/audienceResolution.ts`). Each KEEPS its own policy (return a
 * rejection / throw / filter-out), but they MUST agree on the lookup and on the
 * normalization of the address key, or a suppressed recipient leaks through one
 * path while another blocks it.
 *
 * This module owns that shared lookup + normalization:
 *   - `isSuppressed` — the point read for a single address (the per-send gate).
 *   - `loadSuppressionSet` — the bulk read for audience resolution, where a
 *     per-address point read per candidate would be O(n) round-trips.
 *
 * Both fold the address through `normalizeEmail` (trim + lowercase) so the
 * `by_email` index lookup is exact regardless of how the caller received the
 * address — the blocklist stores normalized addresses, so the key must match.
 */

import type { QueryCtx, MutationCtx } from '../_generated/server';
import { normalizeEmail } from './inputGuards';

/**
 * Is `rawEmail` on the suppression list? Normalizes the address to the same
 * lowercase+trim key the blocklist stores, then does a single `by_email`
 * point read. The point read is the right shape for the per-send gate (one
 * recipient per call); use {@link loadSuppressionSet} when checking many
 * candidates in a loop.
 */
export async function isSuppressed(
	ctx: QueryCtx | MutationCtx,
	rawEmail: string
): Promise<boolean> {
	const blocked = await ctx.db
		.query('blockedEmails')
		.withIndex('by_email', (q) => q.eq('email', normalizeEmail(rawEmail)))
		.first();
	return blocked !== null;
}

/**
 * Load the whole suppression list into an in-memory set of normalized address
 * keys. For the audience-resolution walk, which checks every candidate contact
 * against the blocklist — a point read per candidate would be one round-trip
 * per recipient, so the bulk scan (the list is intrinsically small: one row per
 * suppressed address) is the right shape there.
 *
 * Membership tests against the returned set MUST normalize the candidate the
 * same way (`normalizeEmail`) so the comparison agrees with the stored keys.
 */
export async function loadSuppressionSet(
	ctx: QueryCtx | MutationCtx
): Promise<ReadonlySet<string>> {
	const records = await ctx.db.query('blockedEmails').collect(); // bounded: suppression list, one per blocked address
	return new Set(records.map((b) => normalizeEmail(b.email)));
}

/** A suppression set that may be INCOMPLETE, plus the fact of it. */
export interface BoundedSuppressionSet {
	blockedEmails: ReadonlySet<string>;
	/**
	 * More than `limit` suppressed addresses exist, so the set is a SUBSET of the
	 * real blocklist. A caller filtering candidates through a subset lets some
	 * suppressed addresses through, which makes any "eligible" tally an
	 * OVER-count — it must never license a decision that a bigger audience would
	 * justify.
	 */
	truncated: boolean;
}

/**
 * Bounded variant of {@link loadSuppressionSet} for callers that run inside a
 * MUTATION. `.collect()`ing the whole `blockedEmails` table there drops every
 * suppressed address into the mutation's OCC read set, so a concurrent
 * bounce/complaint write conflicts the mutation at COMMIT time — after any
 * fail-open `try/catch` has already returned (deliverability plan D16).
 *
 * `limit` bounds the read; exceeding it is reported, never thrown.
 */
export async function loadSuppressionSetBounded(
	ctx: QueryCtx | MutationCtx,
	limit: number
): Promise<BoundedSuppressionSet> {
	const bound = Math.max(0, Math.floor(limit));
	// One extra row is the truncation probe: `bound + 1` rows means "more than
	// `bound` exist" without a second query.
	const records = await ctx.db.query('blockedEmails').take(bound + 1);
	const truncated = records.length > bound;
	const kept = truncated ? records.slice(0, bound) : records;
	return { blockedEmails: new Set(kept.map((b) => normalizeEmail(b.email))), truncated };
}
