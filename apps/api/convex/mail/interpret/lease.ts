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
 *   - The run's commit (`reduce.ts applyInterpretation`) checks the token:
 *     unless it is the source's CURRENT lease the write is refused
 *     (`leaseLost`). A recorded outcome clears the lease in the same
 *     transaction; one the run goes on from (a stale revision, a restart on
 *     a changed body or mode) keeps it, so the run stays the only reader.
 *   - Every other way a run ends releases it ({@link releaseSourceLease},
 *     compare-and-set on the token; the run's side is `runApply.ts
 *     withSourceLease`), and the category wait releases it when
 *     it records the wait (`categoryDefer.ts`).
 *
 * The lease outlives the longest action (10 min), so a run never loses it
 * while alive; a run that died leaves it to expire, and its source is still
 * outstanding for the stale sweep. A source without a snapshot row has
 * nothing to lease, and its run ends at the claim (`unsnapshotted`): it
 * reads nothing and commits nothing, unleased, so a snapshot captured right
 * after cannot be read by it (Sol fixes-r3 F1). The capture enqueues the run
 * that reads it, and that run claims like any other.
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
	/** No snapshot row: nothing to lease, and nothing for the run to read. */
	| { kind: 'unsnapshotted' }
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
		const row = await loadInterpretSource(ctx, args.source);
		if (!row) return { kind: 'unsnapshotted' };
		if (isTerminalFor(row.readOutcome, args.depth)) return { kind: 'done' };
		const now = Date.now();
		if (row.leaseToken !== undefined && row.leaseUntil !== undefined && row.leaseUntil > now) {
			return { kind: 'busy', retryAt: row.leaseUntil };
		}
		const token = globalThis.crypto.randomUUID();
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
 * The commit's token check: null when the write may go through, else when to
 * look again (the end of the lease another run holds, or now when the lease
 * was given up). A source with a snapshot row commits only with its CURRENT
 * lease token; no token, a cleared lease or another run's token is refused,
 * since another run may have read and committed the source since. A source
 * without a row has no lease anyone could hold; no run commits it (the run
 * ends at its claim), only a direct reducer call can.
 */
export async function leaseLostAt(
	ctx: MutationCtx,
	source: InterpretationSource,
	token: string | undefined
): Promise<number | null> {
	const row = await loadInterpretSource(ctx, source);
	if (!row || (token !== undefined && row.leaseToken === token)) return null;
	return row.leaseUntil ?? Date.now();
}
