/**
 * The per-source run lease (SPEC §2.5). One interpretation run of a source at
 * a time, whoever dispatched it: delivery, the category wake or its ceiling,
 * the stale sweep, the Reply Queue classifier, an open of the thread. Without
 * it two overlapping runs could both pass the replay dedupe (`run.ts`) before
 * either committed, and both buy the extraction.
 *
 *   - The run's FIRST mutation, {@link claimSourceLease}, takes the lease by
 *     compare-and-set: `leaseUntil = now + LEASE_MS` and a fresh token. A
 *     live lease someone else holds answers `busy` (retry at its expiry); a
 *     source already terminal for the requested depth answers `done`.
 *   - The run's commit (`reduce.ts applyInterpretation`) checks the token: a
 *     lease another run holds now refuses the write (`leaseLost`), and a
 *     recorded outcome clears the lease in the same transaction.
 *   - Every other way a run ends releases it ({@link releaseSourceLease},
 *     compare-and-set on the token; the run's side is `runApply.ts
 *     withSourceLease`), and the category wait releases it when
 *     it records the wait (`categoryDefer.ts`).
 *
 * The lease outlives the longest action (10 min), so a run never loses it
 * while alive; a run that died leaves it to expire, and its source is still
 * outstanding for the stale sweep. A source without a snapshot row has
 * nothing to lease: its run records a skip without a model call.
 */

import { v } from 'convex/values';
import type { Depth } from '@owlat/shared/arrival';
import type { MutationCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import {
	interpretationSourceValidator,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import { depthValidator } from '../../lib/validators/arrival';
import { loadInterpretSource } from './sources';

/** How long a claimed lease lasts: the longest an action may run. */
export const LEASE_MS = 10 * 60 * 1000;

/** What a claim answers. */
export type LeaseClaim =
	| { kind: 'claimed'; token: string }
	| { kind: 'busy'; retryAt: number }
	| { kind: 'done' };

const DEPTH_RANK: Record<Depth, number> = { none: 0, count: 1, gist: 2, full: 3 };

/**
 * Whether the source's terminal outcome already covers `depth`. A `gist`
 * covers gist and below, a `skipped` covers count and none. A full read is
 * never `done` here: the replay dedupe in `run.ts` decides it.
 */
function isTerminalFor(
	readOutcome: 'gist' | 'skipped' | undefined,
	depth: Depth | undefined
): boolean {
	if (!readOutcome || depth === undefined || depth === 'full') return false;
	const reached = readOutcome === 'gist' ? DEPTH_RANK.gist : DEPTH_RANK.count;
	return reached >= DEPTH_RANK[depth];
}

export const claimSourceLease = internalMutation({
	args: { source: interpretationSourceValidator, depth: v.optional(depthValidator) },
	handler: async (ctx, args): Promise<LeaseClaim> => {
		const token = globalThis.crypto.randomUUID();
		const row = await loadInterpretSource(ctx, args.source);
		if (!row) return { kind: 'claimed', token };
		if (isTerminalFor(row.readOutcome, args.depth)) return { kind: 'done' };
		const now = Date.now();
		if (row.leaseToken !== undefined && row.leaseUntil !== undefined && row.leaseUntil > now) {
			return { kind: 'busy', retryAt: row.leaseUntil };
		}
		await ctx.db.patch(row._id, { leaseToken: token, leaseUntil: now + LEASE_MS });
		return { kind: 'claimed', token };
	},
});

/** Give the lease back, only when `token` still holds it. */
export const releaseSourceLease = internalMutation({
	args: { source: interpretationSourceValidator, token: v.string() },
	handler: async (ctx, args): Promise<void> => {
		await releaseLeaseIfHeld(ctx, args.source, args.token);
	},
});

/** {@link releaseSourceLease}'s body, for a mutation that records the run's outcome. */
export async function releaseLeaseIfHeld(
	ctx: MutationCtx,
	source: InterpretationSource,
	token: string
): Promise<void> {
	const row = await loadInterpretSource(ctx, source);
	if (!row || row.leaseToken !== token) return;
	await ctx.db.patch(row._id, { leaseToken: undefined, leaseUntil: undefined });
}

/**
 * The commit's token check: null when a write with `token` may go through
 * (no token given, the source is gone, or nobody else holds the lease), else
 * when the lease another run holds ends.
 */
export async function leaseLostAt(
	ctx: MutationCtx,
	source: InterpretationSource,
	token: string | undefined
): Promise<number | null> {
	if (token === undefined) return null;
	const row = await loadInterpretSource(ctx, source);
	if (!row || row.leaseToken === undefined || row.leaseToken === token) return null;
	return row.leaseUntil ?? Date.now();
}
