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
import type { Id } from '../_generated/dataModel';
import { normalizeEmail } from './inputGuards';
import { isMarketingOnlyBlockReason, type BlockReason } from '../delivery/suppressionMirror';
import { scheduleSuppressionMirror } from '../delivery/suppressionMirrorScheduler';

/**
 * WHAT KIND OF MAIL is being gated.
 *
 * `'marketing'` (the default) is the strict reading: every blocklist row blocks.
 * Campaigns, automations and agent mail use it.
 *
 * `'transactional'` is the narrower one: rows whose reason is a MARKETING-ONLY
 * hygiene decision (`unengaged` — see `delivery/suppressionMirror.ts`) do NOT
 * block. Ignoring marketing engagement is not a request to stop receiving the
 * receipt, the password reset or the double-opt-in confirmation you just asked
 * for, and auto-suppressing a paying customer out of their own transactional
 * mail would be a far worse defect than the one auto-suppression fixes. Bounce
 * and complaint rows still block on this scope, because those are evidence
 * about the MAILBOX rather than about the mail.
 *
 * DEFAULTING TO THE STRICT SCOPE IS DELIBERATE: a new call site that forgets to
 * think about this gets the blocking behaviour, never the permissive one.
 */
export type SuppressionScope = 'marketing' | 'transactional';

/**
 * Is `rawEmail` on the suppression list for `scope`? Normalizes the address to
 * the same lowercase+trim key the blocklist stores, then does a single
 * `by_email` point read. The point read is the right shape for the per-send gate
 * (one recipient per call); use {@link loadSuppressionSet} when checking many
 * candidates in a loop.
 */
export async function isSuppressed(
	ctx: QueryCtx | MutationCtx,
	rawEmail: string,
	options?: { scope?: SuppressionScope | undefined }
): Promise<boolean> {
	const blocked = await ctx.db
		.query('blockedEmails')
		.withIndex('by_email', (q) => q.eq('email', normalizeEmail(rawEmail)))
		.first();
	if (blocked === null) return false;
	if ((options?.scope ?? 'marketing') === 'transactional') {
		return !isMarketingOnlyBlockReason(blocked.reason);
	}
	return true;
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
 *
 * SCOPE-BLIND BY DESIGN — unlike {@link isSuppressed}, this loader (and
 * {@link loadSuppressionSetBounded}) carries no {@link SuppressionScope}: its
 * only callers resolve CAMPAIGN audiences, which are marketing scope, where
 * every blocklist reason blocks. A caller that needs the transactional reading
 * is doing a per-send gate and belongs on `isSuppressed`, not here.
 */
export async function loadSuppressionSet(
	ctx: QueryCtx | MutationCtx
): Promise<ReadonlySet<string>> {
	const records = await ctx.db.query('blockedEmails').collect(); // bounded: suppression list, one per blocked address
	return new Set(records.map((b) => normalizeEmail(b.email)));
}

/**
 * Add one address to the SHIPPED suppression list, then mirror it to the MTA's
 * Redis backstop — the two halves every existing suppression site already does
 * together (`delivery/sendLifecycle/effects.ts`'s `blocklist_insert`,
 * `blockedEmails.add`). Callers that suppress programmatically go through here
 * instead of hand-rolling the pair, so a new suppression source cannot forget
 * the mirror and cannot invent a parallel suppression concept.
 *
 * IDEMPOTENT AND NEVER DESTRUCTIVE. An address already on the list is left
 * exactly as it is and `null` is returned: an existing `bounced` /
 * `complained` row carries stronger evidence than any later hygiene decision,
 * and downgrading it would be data loss. Suppression here only ever INSERTS.
 *
 * THE MIRROR IS SKIPPED FOR MARKETING-ONLY REASONS. The MTA's suppression list
 * is the LAST HOP — it sits under Convex and blocks everything, transactional
 * mail included — so a bulk-hygiene decision must not reach it. The Convex row
 * is the authoritative record either way, and every send path already gates on
 * it at the scope that path cares about.
 */
export async function suppressEmail(
	ctx: MutationCtx,
	args: {
		email: string;
		reason: BlockReason;
		bounceType?: 'hard' | 'soft' | undefined;
		notes?: string | undefined;
		/**
		 * The instant to stamp on the row. Callers that already hold a decision
		 * clock pass it, so the blocklist row and whatever else that decision
		 * writes cannot disagree about when it happened — and their fixtures stay
		 * deterministic. Defaults to `Date.now()`.
		 */
		now?: number | undefined;
	}
): Promise<Id<'blockedEmails'> | null> {
	const normalized = normalizeEmail(args.email);
	const existing = await ctx.db
		.query('blockedEmails')
		.withIndex('by_email', (q) => q.eq('email', normalized))
		.first();
	if (existing) return null;

	const blockedEmailId = await ctx.db.insert('blockedEmails', {
		email: normalized,
		reason: args.reason,
		...(args.bounceType ? { bounceType: args.bounceType } : {}),
		...(args.notes ? { notes: args.notes } : {}),
		createdAt: args.now ?? Date.now(),
	});

	if (!isMarketingOnlyBlockReason(args.reason)) {
		await scheduleSuppressionMirror(ctx, {
			email: normalized,
			reason: args.reason,
			...(args.bounceType ? { bounceType: args.bounceType } : {}),
		});
	}

	return blockedEmailId;
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
	/**
	 * ROWS actually read, including the truncation probe. Distinct from
	 * `blockedEmails.size`, which is the DE-DUPLICATED, truncated set: a caller
	 * charging a read budget must charge what the query read, not what survived
	 * it, or the "bound" under-counts exactly the reads it exists to cap.
	 */
	rowsRead: number;
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
	return {
		blockedEmails: new Set(kept.map((b) => normalizeEmail(b.email))),
		truncated,
		rowsRead: records.length,
	};
}
