/**
 * Integration import recovery — re-issues the current page of a `'running'`
 * import whose hop was lost, or ends the run visibly.
 *
 * Every commit that moves a run onto a page also schedules that page's hop and
 * records it as the run's lease (`pageCommit.ts`), so in steady state this
 * finds nothing to do. It exists for the hop that died anyway: an action
 * killed after its fetch, a commit that threw (a transaction limit, an
 * injected fault), a hop the scheduler lost, or a run the previous release
 * left between two of its calls. Without it, such a run stays `'running'` with
 * nothing behind it, and the one-import-at-a-time gate refuses every new
 * import until someone cancels it by hand.
 *
 * Re-issuing is safe because a page is identified by its cursor and the run's
 * page count: if the lost hop did commit after all, the re-issued one finds
 * its page already counted and changes nothing.
 *
 * Per ADR-0027 (#996/#999 amendment).
 */

import type { MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { internalMutation, readActiveWorkspaceDeletion } from '../lib/writeFence';
import { logWarn } from '../lib/runtimeLog';
import { finishImport, schedulePage } from './pageCommit';

/** Re-issues of one page before the run is ended as failed. */
export const MAX_PAGE_RECOVERIES = 3;

/**
 * How long a run with no recorded lease may be quiet before it counts as lost.
 * Only rows the previous release wrote lack a lease, and one of its hops may
 * still be queued or running for them, so this sits well above an action's
 * ten-minute limit plus its retry backoff.
 */
export const UNLEASED_RUN_GRACE_MS = 30 * 60 * 1000;

/**
 * Running imports examined per sweep. The start gate allows one at a time, so
 * this only bounds the transaction against rows that predate the gate.
 */
const SWEEP_LIMIT = 20;

type Recovery = 'live' | 'resumed' | 'failed';

/**
 * Whether the run's current page still has a hop that can run or finish on its
 * own. A recorded lease decides it outright; a row without one (the previous
 * release's) falls back to how long it has been quiet.
 */
async function hasLiveHop(
	ctx: MutationCtx,
	record: Doc<'integrationImports'>,
	now: number
): Promise<boolean> {
	if (record.pageJobId === undefined) {
		return now - (record.lastPageAt ?? record.startedAt) < UNLEASED_RUN_GRACE_MS;
	}
	const job = await ctx.db.system.get(record.pageJobId);
	return job?.state.kind === 'pending' || job?.state.kind === 'inProgress';
}

async function recoverRun(
	ctx: MutationCtx,
	record: Doc<'integrationImports'>,
	now: number
): Promise<Recovery> {
	if (await hasLiveHop(ctx, record, now)) return 'live';

	const config = record.resumeConfig;
	const attempt = (record.pageRecoveries ?? 0) + 1;
	if (config === undefined || attempt > MAX_PAGE_RECOVERIES) {
		const reason =
			config === undefined
				? // Nothing sealed to resume with: a run the previous release started
					// that never committed a page under this one, or an instance
					// without INSTANCE_SECRET, where the key is never stored.
					'Import stopped: its next page was lost and the run cannot be resumed. Start the import again.'
				: `Import stopped: the page at cursor "${record.cursor}" did not complete after ${MAX_PAGE_RECOVERIES} retries.`;
		// Appended past the error cap, like a cancel: the reason the run ended
		// must be on it.
		await finishImport(ctx, record, 'failed', [...record.errors, reason]);
		logWarn('[integrationImports] ended a stalled import', {
			importId: record._id,
			provider: record.provider,
		});
		return 'failed';
	}

	await ctx.db.patch(record._id, { pageRecoveries: attempt });
	await schedulePage(ctx, record._id, {
		config,
		cursor: record.cursor,
		page: record.pagesCommitted ?? 0,
	});
	return 'resumed';
}

/**
 * The recovery sweep, run by the `recover stalled integration imports` cron
 * (`contacts/crons.ts`).
 *
 * It stands down while a workspace deletion runs. The deletion cancels every
 * queued hop and sweeps `integrationImports` late in its walk, so each running
 * row looks lost until then, and the fence refuses the write that would
 * re-issue or end it: the cron would fail every ten minutes for the length of
 * the walk. The deletion removes the row anyway; an aborted one leaves it to
 * the next sweep after the fence lifts.
 */
export const recoverStalledImports = internalMutation({
	args: {},
	handler: async (ctx): Promise<Record<Recovery, number>> => {
		const counts: Record<Recovery, number> = { live: 0, resumed: 0, failed: 0 };
		if (await readActiveWorkspaceDeletion(ctx.db)) return counts;

		const now = Date.now();
		const running = await ctx.db
			.query('integrationImports')
			.withIndex('by_status', (q) => q.eq('status', 'running'))
			.take(SWEEP_LIMIT);

		for (const record of running) counts[await recoverRun(ctx, record, now)]++;
		return counts;
	},
});
