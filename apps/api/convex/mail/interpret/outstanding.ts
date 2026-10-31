/**
 * Outstanding sources (p4 review rounds 3 and 4): the one owner of the
 * thread's count of sources enqueued for interpretation and not yet recorded.
 *
 *   - {@link markOutstanding}: a source was enqueued (delivery, a send, the
 *     Team Inbox pipeline, a history page, first open). Idempotent on the
 *     snapshot's flag, so a repeated enqueue counts once.
 *   - {@link deferSource}: deferred, the source waits for the thread to be opened
 *     (not outstanding; `threadBriefs.deferredSources`).
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
import type { InterpretDeferReason } from '@owlat/shared/aiRouting';
import { sourceOrderKey } from './sourceOrder';
import type { Depth, ReasonKey } from '@owlat/shared/arrival';
import { clearGistOf } from './gistState';
import { noteArrivalRun } from '../arrival/records';

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

/** A brief counter moved by `delta`, never below zero; zero is stored as absent. */
function shifted(value: number | undefined, delta: number): number | undefined {
	const next = Math.max(0, (value ?? 0) + delta);
	return next > 0 ? next : undefined;
}

/** Move the brief's counters and store its completeness, in this transaction. */
async function shiftCounts(
	ctx: MutationCtx,
	brief: Doc<'threadBriefs'>,
	delta: { pending: number; unread: number; deferred?: number; skipped?: number; gist?: number }
): Promise<void> {
	const pendingSources = shifted(brief.pendingSources, delta.pending);
	const unreadSources = shifted(brief.unreadSources, delta.unread);
	const deferredSources = shifted(brief.deferredSources, delta.deferred ?? 0);
	const skippedSources = shifted(brief.skippedSources, delta.skipped ?? 0);
	const gistSources = shifted(brief.gistSources, delta.gist ?? 0);
	const counts = { pendingSources, unreadSources, deferredSources, skippedSources, gistSources };
	const next = { ...brief, ...counts };
	await ctx.db.patch(brief._id, {
		...counts,
		// Recomputed from the counts every time, `pending` included: a brief
		// whose last outstanding source settled reads what it holds.
		completeness: briefCompleteness(next),
		updatedAt: Date.now(),
	});
}

/** The fields a deferred source carries, cleared. */
const NOT_DEFERRED = { isDeferred: undefined, deferredAt: undefined, deferReason: undefined };

/**
 * A source was enqueued for interpretation: outstanding until it has an
 * outcome. A deferred source enqueued now is no longer deferred.
 */
export async function markOutstanding(ctx: MutationCtx, sourceKey: string): Promise<void> {
	const snapshot = await snapshotOf(ctx, sourceKey);
	if (!snapshot || snapshot.isOutstanding) return;
	const wasDeferred = snapshot.isDeferred === true;
	await ctx.db.patch(snapshot._id, {
		isOutstanding: true,
		outstandingSince: Date.now(),
		outstandingTries: undefined,
		...(wasDeferred ? NOT_DEFERRED : {}),
	});
	const brief = await ensureBriefRow(ctx, threadRefFromFields(snapshot));
	if (brief)
		await shiftCounts(ctx, brief, { pending: 1, unread: 0, deferred: wasDeferred ? -1 : 0 });
}

async function orderKeyOfSnapshot(
	ctx: Pick<MutationCtx, 'db'>,
	snapshot: Doc<'interpretSources'>
): Promise<string | undefined> {
	const { source } = snapshot;
	if (source.kind !== 'mail' && source.kind !== 'outboundMail') return undefined;
	const row = await ctx.db.get(source.id);
	return row ? sourceOrderKey(row) : undefined;
}

/**
 * The source's only consumer is the reader display, so its
 * interpretation waits until the thread is opened (`lazy.ts`). It stops being
 * outstanding, so the stale sweep (`by_outstanding`) never re-runs it, and it
 * is counted in `threadBriefs.deferredSources` instead of `pendingSources`.
 * The history backfill skips it like any captured source.
 */
export async function deferSource(
	ctx: MutationCtx,
	sourceKey: string,
	reason: InterpretDeferReason
): Promise<boolean> {
	const snapshot = await snapshotOf(ctx, sourceKey);
	if (!snapshot || snapshot.isDeferred === true) return false;
	// Every deferred row carries its thread order (`defer.ts` reads deferred
	// rows by it), written in this same mutation. A source without one (its
	// message is gone, or it is no Postbox message) is not deferred.
	const orderKey = snapshot.sourceOrderKey ?? (await orderKeyOfSnapshot(ctx, snapshot));
	if (!orderKey) return false;
	const wasPending = snapshot.isOutstanding === true;
	await ctx.db.patch(snapshot._id, {
		isOutstanding: undefined,
		outstandingSince: undefined,
		outstandingTries: undefined,
		sourceOrderKey: orderKey,
		isDeferred: true,
		deferredAt: Date.now(),
		deferReason: reason,
	});
	const brief = await ensureBriefRow(ctx, threadRefFromFields(snapshot));
	if (brief)
		await shiftCounts(ctx, brief, { pending: wasPending ? -1 : 0, unread: 0, deferred: 1 });
	return true;
}

/** A source settled short of a full read, as the run decided it. */
export interface ArrivalSettlement {
	readOutcome: 'gist' | 'skipped';
	depth: Depth;
	isUpgradeable: boolean;
	skipReason?: ReasonKey;
}

/** The brief counter a short-of-full outcome counts in. */
function arrivalDelta(readOutcome: ArrivalSettlement['readOutcome'] | undefined, sign: 1 | -1) {
	if (readOutcome === 'gist') return { gist: sign };
	if (readOutcome === 'skipped') return { skipped: sign };
	return {};
}

/**
 * Read on arrival: the source is settled as gist-only or skipped.
 * Terminal: it stops being outstanding or deferred, the stale sweep and the
 * backfill never run it again, and only the upgrade rule (`defer.ts`) reads it
 * in full later. Counted in `threadBriefs.gistSources` / `skippedSources`,
 * which the brief reads as settled (`purgeRepairs.ts briefCompleteness`).
 * Clears the run's lease and the category wait marker in the same write.
 */
export async function settleArrivalSource(
	ctx: MutationCtx,
	sourceKey: string,
	settlement: ArrivalSettlement
): Promise<void> {
	const snapshot = await snapshotOf(ctx, sourceKey);
	if (!snapshot) return;
	const wasPending = snapshot.isOutstanding === true;
	const wasDeferred = snapshot.isDeferred === true;
	const wasUnread = snapshot.isUnread === true;
	await ctx.db.patch(snapshot._id, {
		isOutstanding: undefined,
		outstandingSince: undefined,
		outstandingTries: undefined,
		isUnread: undefined,
		...NOT_DEFERRED,
		depth: settlement.depth,
		readOutcome: settlement.readOutcome,
		isUpgradeable: settlement.isUpgradeable,
		skipReason: settlement.skipReason,
		categoryPendingAt: undefined,
		arrivalRetryAt: undefined,
		// The read job is over: its admission covers nothing more (Sol r3 F1).
		arrivalAdmittedUntil: undefined,
		leaseToken: undefined,
		leaseUntil: undefined,
		updatedAt: Date.now(),
	});
	const brief = await ensureBriefRow(ctx, threadRefFromFields(snapshot));
	if (!brief) return;
	await shiftCounts(ctx, brief, {
		pending: wasPending ? -1 : 0,
		unread: wasUnread ? -1 : 0,
		deferred: wasDeferred ? -1 : 0,
		...arrivalDelta(snapshot.readOutcome, -1),
		...arrivalDelta(settlement.readOutcome, 1),
	});
}

/**
 * The upgrade discharge: a source settled short of a full read
 * got a recorded outcome after all (a full read, or the skip, failure or
 * fence its upgrade run recorded). It leaves the gist / skipped count, and it
 * is no longer upgradeable either way, so it can never hold a successor up.
 * A gist read from it is superseded with it. True when it was discharged.
 */
async function dischargeArrival(
	ctx: MutationCtx,
	snapshot: Doc<'interpretSources'>
): Promise<boolean> {
	if (snapshot.readOutcome === undefined && snapshot.isUpgradeable !== true) return false;
	await ctx.db.patch(snapshot._id, {
		readOutcome: undefined,
		isUpgradeable: false,
		depth: 'full',
		skipReason: undefined,
		categoryPendingAt: undefined,
		arrivalRetryAt: undefined,
		updatedAt: Date.now(),
	});
	await clearGistOf(ctx, threadRefFromFields(snapshot), snapshot.sourceKey);
	// The record and the projection say what was read now (Sol r1 F8).
	if (snapshot.source.kind === 'mail') {
		await noteArrivalRun(ctx, snapshot.source.id, { depth: 'full' });
	}
	return true;
}

/** The source has an outcome (see the module doc for the kinds). */
export async function settleSource(
	ctx: MutationCtx,
	sourceKey: string,
	outcome: Outcome
): Promise<void> {
	const snapshot = await snapshotOf(ctx, sourceKey);
	if (!snapshot) return;
	// A recorded outcome of a gist-only or skipped source discharges it; a
	// purge leaves its count to the purge (`arrival/purgeRanges.ts`).
	const isDischarged = outcome !== 'purged' && (await dischargeArrival(ctx, snapshot));
	if (isDischarged) {
		const brief = await loadBriefRow(ctx, threadRefFromFields(snapshot));
		if (brief) {
			await shiftCounts(ctx, brief, {
				pending: 0,
				unread: 0,
				...arrivalDelta(snapshot.readOutcome, -1),
			});
		}
	}
	const wasPending = snapshot.isOutstanding === true;
	const wasUnread = snapshot.isUnread === true;
	// A deferred source that got an outcome after all (a purge, a run someone
	// else started) is no longer waiting for the thread to be opened.
	const wasDeferred = snapshot.isDeferred === true;
	const isUnread = outcome === 'unread';
	// A recorded outcome ends the source's read job: its admission stamp goes (Sol r3 F1).
	if (outcome !== 'purged' && snapshot.arrivalAdmittedUntil !== undefined) {
		await ctx.db.patch(snapshot._id, { arrivalAdmittedUntil: undefined });
	}
	if (!wasPending && !wasDeferred && wasUnread === isUnread) return;
	if (outcome !== 'purged') {
		await ctx.db.patch(snapshot._id, {
			isOutstanding: undefined,
			outstandingSince: undefined,
			outstandingTries: undefined,
			isUnread: isUnread ? true : undefined,
			...(wasDeferred ? NOT_DEFERRED : {}),
		});
	}
	const brief = await loadBriefRow(ctx, threadRefFromFields(snapshot));
	if (!brief) return;
	await shiftCounts(ctx, brief, {
		pending: wasPending ? -1 : 0,
		unread: (isUnread ? 1 : 0) - (wasUnread ? 1 : 0),
		deferred: wasDeferred ? -1 : 0,
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
