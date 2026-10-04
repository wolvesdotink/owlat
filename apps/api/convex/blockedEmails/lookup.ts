import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { normalizeEmail } from '../lib/inputGuards';
import { BLOCK_REASONS, type BlockReason } from '../lib/literalValidators';

// Hard cap on the blocklist view. blockedEmails grows unboundedly with bounces
// and complaints, and an unbounded `.collect()` would eventually trip Convex's
// per-query document read limit. Return the most recent N (ordered by creation
// time via the implicit by_creation_time index / the by_reason index) instead
// of every row; the UI filters by reason for anything older.
//
// It is also the cap every count of this table saturates at, which is why it
// lives beside `countBlockedByReason` below.
export const BLOCKLIST_VIEW_LIMIT = 1000;

// Look up a blocklist row by email. Normalizes (lowercase + trim) so every
// caller hits the `by_email` index with the same key, then returns the first
// match or null. Single source of truth for the blocklist-by-email read.
//
// Exported for the suppression carry-over import, which needs to tell an address
// it just blocked from one that was already blocked in order to report an
// honest run summary. It reads through this rather than re-deriving the key,
// because a second normalization would eventually disagree with this one.
export async function findBlockedByEmail(
	ctx: QueryCtx | MutationCtx,
	email: string
): Promise<Doc<'blockedEmails'> | null> {
	const normalizedEmail = normalizeEmail(email);
	return await ctx.db
		.query('blockedEmails')
		.withIndex('by_email', (q) => q.eq('email', normalizedEmail))
		.first();
}

/** Blocked-address counts per reason, plus their sum. */
export type BlockedCountsByReason = { total: number } & Record<BlockReason, number>;

// Blocked-email counts via the `by_reason` index, one read per `BLOCK_REASONS`
// entry, each CAPPED at BLOCKLIST_VIEW_LIMIT. The index narrows the scan to one
// reason class but does not bound it: blockedEmails is append-only with no
// expiry, and `unengaged` is written by the sunset cron rather than by an
// operator or a recipient, so any class can outgrow Convex's per-query read
// limit. Counts saturate at the cap.
//
// The one counter: the operator suppression screen
// (`blockedEmails.getCountsByReason`) and the platform-admin org detail
// (`platformAdmin/queries.ts`) both read it, so they agree at scale and a new
// reason reaches both totals.
export async function countBlockedByReason(
	ctx: QueryCtx | MutationCtx
): Promise<BlockedCountsByReason> {
	const counts = await Promise.all(
		BLOCK_REASONS.map(async (reason) => {
			const rows = await ctx.db
				.query('blockedEmails')
				.withIndex('by_reason', (q) => q.eq('reason', reason))
				.take(BLOCKLIST_VIEW_LIMIT);
			return [reason, rows.length] as const;
		})
	);
	const byReason = Object.fromEntries(counts) as Record<BlockReason, number>;
	const total = counts.reduce((sum, [, count]) => sum + count, 0);
	return { total, ...byReason };
}

// Removals scanned per check. Each one is an operator clicking "Remove", so the
// cap is far above what a window of hours holds.
const REMOVAL_SCAN_LIMIT = 500;

// Whether an operator removed `email` from the blocklist after `since` (#1228).
//
// Read from the `blocklist.removed` audit entries, which `blockedEmails.remove`
// writes in the same transaction as the delete and which already carry the
// normalized address, so the guard needs no new table and stores nothing new.
// The scan is an index range over removals newer than `since`: a provider event
// is at most hours old, so the range is a handful of rows. When it is not
// (more than REMOVAL_SCAN_LIMIT removals since the event), this answers true:
// refusing a stale re-add costs nothing the provider does not still enforce,
// while undoing an operator's decision is the failure being guarded against.
export async function wasRemovedByOperatorSince(
	ctx: QueryCtx | MutationCtx,
	email: string,
	since: number
): Promise<boolean> {
	const normalizedEmail = normalizeEmail(email);
	const removals = await ctx.db
		.query('auditLogs')
		.withIndex('by_action_and_created_at', (q) =>
			q.eq('action', 'blocklist.removed').gt('createdAt', since)
		)
		.take(REMOVAL_SCAN_LIMIT + 1);
	if (removals.length > REMOVAL_SCAN_LIMIT) return true;
	return removals.some((entry) => entry.details?.['email'] === normalizedEmail);
}
