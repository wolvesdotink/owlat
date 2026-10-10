/**
 * Outstanding sources (p4 review rounds 3 and 4): the one owner of the
 * thread's count of sources enqueued for interpretation and not yet recorded.
 *
 *   - {@link markOutstanding}: a source was enqueued (delivery, a send, the
 *     Team Inbox pipeline, a history page, first open). Idempotent on the
 *     snapshot's flag, so a repeated enqueue counts once.
 *   - {@link settleSource}: the source has an outcome. `recorded` for any
 *     recorded result (complete, partial, failed, skipped, or a reused one),
 *     `purged` when its snapshot is deleted, `unread` when the stale sweep
 *     gave up on it. Idempotent the same way.
 *
 * Both update the counters AND store the brief's completeness in the same
 * transaction (`briefCompleteness`, the one rule the auto-send gates read),
 * so no gate ever sees a complete brief while a source is unread. A brief
 * whose runs are in flight keeps `pending`; the reducer recomputes it when
 * they land.
 *
 * {@link sweep} recovers sources whose run was lost (a killed action): after
 * {@link STALE_MS} the source is run again, at most {@link MAX_SWEEP_TRIES}
 * times; then it is settled `unread`, which keeps the brief partial and the
 * automation hold in place (`unreadSources`). Called by the needs-reply
 * reconcile cron (`mail/needsReplyPending.ts`), so crons.ts does not grow.
 */

import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { internalMutation } from '../../lib/writeFence';
import {
	interpretationSourceKey,
	interpretationSourceValidator,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import { threadRefFromFields } from '../../lib/validators/threadRef';
import { ensureBriefRow, loadBriefRow } from './briefRow';
import { briefCompleteness } from './purgeRepairs';

/** A source outstanding this long without an outcome has lost its run. */
export const STALE_MS = 30 * 60_000;
/** Re-runs of a stale source before it is settled unread. */
export const MAX_SWEEP_TRIES = 3;
/** Stale sources handled per sweep. */
const SWEEP_BATCH = 50;

type Outcome = 'recorded' | 'purged' | 'unread';

function snapshotOf(ctx: Pick<MutationCtx, 'db'>, sourceKey: string) {
	return ctx.db
		.query('interpretSources')
		.withIndex('by_source_key', (q) => q.eq('sourceKey', sourceKey))
		.first();
}

/** The run that reads a source: sends go through the outbound run (failure reconciliation). */
export function runOf(source: InterpretationSource) {
	return source.kind === 'outboundMail' || source.kind === 'teamReply'
		? internal.mail.interpret.outboundRun.interpretSent
		: internal.mail.interpret.run.interpretMessage;
}

/** Move the brief's counters and store its completeness, in this transaction. */
async function shiftCounts(
	ctx: MutationCtx,
	brief: Doc<'threadBriefs'>,
	delta: { pending: number; unread: number }
): Promise<void> {
	const pendingSources = Math.max(0, (brief.pendingSources ?? 0) + delta.pending);
	const unreadSources = Math.max(0, (brief.unreadSources ?? 0) + delta.unread);
	const next = { ...brief, pendingSources, unreadSources };
	await ctx.db.patch(brief._id, {
		pendingSources: pendingSources > 0 ? pendingSources : undefined,
		unreadSources: unreadSources > 0 ? unreadSources : undefined,
		// Recomputed from the counts every time, `pending` included: a brief
		// whose last outstanding source settled reads what it holds.
		completeness: briefCompleteness(next),
		updatedAt: Date.now(),
	});
}

/** A source was enqueued for interpretation: outstanding until it has an outcome. */
export async function markOutstanding(ctx: MutationCtx, sourceKey: string): Promise<void> {
	const snapshot = await snapshotOf(ctx, sourceKey);
	if (!snapshot || snapshot.isOutstanding) return;
	await ctx.db.patch(snapshot._id, {
		isOutstanding: true,
		outstandingSince: Date.now(),
		outstandingTries: undefined,
	});
	const brief = await ensureBriefRow(ctx, threadRefFromFields(snapshot));
	if (brief) await shiftCounts(ctx, brief, { pending: 1, unread: 0 });
}

/** The source has an outcome (see the module doc for the kinds). */
export async function settleSource(
	ctx: MutationCtx,
	sourceKey: string,
	outcome: Outcome
): Promise<void> {
	const snapshot = await snapshotOf(ctx, sourceKey);
	if (!snapshot) return;
	const wasPending = snapshot.isOutstanding === true;
	const wasUnread = snapshot.isUnread === true;
	const isUnread = outcome === 'unread';
	if (!wasPending && wasUnread === isUnread) return;
	if (outcome !== 'purged') {
		await ctx.db.patch(snapshot._id, {
			isOutstanding: undefined,
			outstandingSince: undefined,
			outstandingTries: undefined,
			isUnread: isUnread ? true : undefined,
		});
	}
	const brief = await loadBriefRow(ctx, threadRefFromFields(snapshot));
	if (!brief) return;
	await shiftCounts(ctx, brief, {
		pending: wasPending ? -1 : 0,
		unread: (isUnread ? 1 : 0) - (wasUnread ? 1 : 0),
	});
}

/** A reused or replayed result counts as recorded (run.ts's cached return). */
export const settleRecorded = internalMutation({
	args: { source: interpretationSourceValidator },
	handler: async (ctx, args): Promise<void> => {
		await settleSource(ctx, interpretationSourceKey(args.source), 'recorded');
	},
});

/** Re-run stale outstanding sources; give up on them after the bounded retries. */
export async function sweepStaleSources(
	ctx: MutationCtx
): Promise<{ rerun: number; unread: number }> {
	const now = Date.now();
	const stale = await ctx.db
		.query('interpretSources')
		.withIndex('by_outstanding', (q) =>
			q.eq('isOutstanding', true).lt('outstandingSince', now - STALE_MS)
		)
		.take(SWEEP_BATCH);
	let rerun = 0;
	let unread = 0;
	for (const snapshot of stale) {
		const tries = (snapshot.outstandingTries ?? 0) + 1;
		if (tries > MAX_SWEEP_TRIES) {
			await settleSource(ctx, snapshot.sourceKey, 'unread');
			unread++;
			continue;
		}
		await ctx.db.patch(snapshot._id, { outstandingSince: now, outstandingTries: tries });
		await ctx.scheduler.runAfter(0, runOf(snapshot.source), { source: snapshot.source });
		rerun++;
	}
	return { rerun, unread };
}

/** The sweep on its own (tests, an operator); the reconcile cron runs it inline. */
export const sweep = internalMutation({
	args: {},
	handler: (ctx): Promise<{ rerun: number; unread: number }> => sweepStaleSources(ctx),
});
