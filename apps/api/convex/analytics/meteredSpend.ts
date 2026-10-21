/**
 * The action side of the ledger: run one metered model call and
 * write one `llmUsageEvents` row per provider request it made.
 *
 * {@link meterLlmCall} is the single owner of a call's rows. It builds the
 * call's `LlmCallMeter` (task, root request, and the action's deadline), hands
 * it to the dispatch, and writes what the meter recorded, on success and on
 * failure alike. A request is acknowledged on the meter only once its batch is
 * stored, so a failed write keeps it for the next flush, and the ledger skips a
 * request it already holds (`recordRequests` is idempotent by request id and
 * attempt), so a retried batch writes nothing twice. A failure the dispatch
 * raises after billed work (an `LlmPartialUsageError`) needs no separate
 * recording: its requests are on the meter already.
 *
 * Runtime-neutral (no 'use node'), so V8 steps and Node actions share it.
 */

import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { AiTaskName } from '@owlat/shared/aiRouting';
import { LlmPartialUsageError } from '../lib/llm/partialUsage';
import { LlmCallMeter, type LlmRequestRecord, type LlmRootContext } from '../lib/llm/requestMeter';
import { taskForFeature, taskPolicy } from '../lib/llm/taskPolicy';
import { callDeadlineAt } from '../lib/llm/actionDeadline';
import type { LlmUsagePlane } from '../lib/llmUsageTags';
import type { AdmissionPriority, BudgetClass, QualityResult } from '../lib/validators/aiRouting';
import { dispatchAdmissionPort } from './admissionPorts';
import {
	MAX_METERED_REQUESTS_PER_WRITE,
	type MeteredRequest,
	type RequestBatchArgs,
} from './llmUsage';

type SpendCtx = Pick<ActionCtx, 'runMutation' | 'scheduler'>;

/** Where a metered call's rows go and what they say about the call. */
export interface LlmSpendTarget {
	/** The ledger feature tag (dashboard grouping). */
	readonly feature: string;
	/** The task-policy entry; defaults to the task the feature maps to. */
	readonly task?: AiTaskName;
	/** The inbound message or user action the call serves. */
	readonly root?: LlmRootContext;
	/** Absent ⇒ the task's plane (`lib/llm/taskPolicy.ts`), else language. */
	readonly plane?: LlmUsagePlane;
	/** Absent ⇒ the task's class; a shadow call passes `shadow`. */
	readonly budgetClass?: BudgetClass;
	/** Absent ⇒ the task's priority (`lib/llm/taskPolicy.ts`). */
	readonly priority?: AdmissionPriority;
	/**
	 * A hold the caller reserved and settles itself (an embedding batch, a
	 * writer escalation): the rows carry it and the dispatch reserves nothing.
	 */
	readonly reservationId?: string;
	/**
	 * The call's request id, when the caller's hold keyed its requests' bounds
	 * by it (`mail/interpret/runHold.ts`). Absent: a fresh one.
	 */
	readonly requestId?: string;
	readonly policyVersion?: number;
	/**
	 * The quality assessment of what the call produced (a cheap-first draft:
	 * `passed`, `escalated`; its escalation: `passed`, `failed`, `abstained`).
	 * Absent: not assessed.
	 */
	readonly qualityResult?: QualityResult;
	/** Rows of a decision attempt carry the plane's flags. */
	readonly isFallback?: boolean;
	readonly isCalibrated?: boolean;
	readonly isLocalEngine?: boolean;
}

export interface MeterLlmCallOptions {
	/**
	 * `await` (default) writes before the result is returned, so the ceiling
	 * sees the spend before the caller acts. `schedule` queues the write, for an
	 * interactive surface whose answer should not wait for a mutation; the rows
	 * land moments later.
	 */
	readonly write?: 'await' | 'schedule';
	/**
	 * `throw` (default) lets a failed success-path write fail the call, as an
	 * unrecorded call would otherwise slip past the ceiling. `ignore` keeps the
	 * result: a fail-soft pipeline step that must not drop mail over a lost row.
	 * A failed write on the failure path is always ignored, so the provider's
	 * error is the one that surfaces.
	 */
	readonly onWriteError?: 'throw' | 'ignore';
	/**
	 * `cause` (default) rethrows the provider's own error when a failure
	 * carried billed usage, which the meter has already recorded, so nothing
	 * above can record it again. `as_is` rethrows the `LlmPartialUsageError`,
	 * for a caller that reads its usage for reporting.
	 */
	readonly rethrow?: 'cause' | 'as_is';
}

/**
 * The meter a call under `target` records into, in the action `ctx` runs:
 * its deadline is the tighter of the root's and the action's model budget.
 */
export function meterFor(ctx: object, target: LlmSpendTarget): LlmCallMeter {
	const task = target.task ?? taskForFeature(target.feature);
	const deadlineAt = callDeadlineAt(ctx, target.root);
	return new LlmCallMeter({
		...(target.requestId ? { requestId: target.requestId } : {}),
		task,
		root: target.root,
		deadlineAt,
		// A caller that holds its own reservation settles it; the dispatch adds none.
		...(target.reservationId
			? { hasOuterHold: true }
			: { admission: dispatchAdmissionPort(ctx, target, task, deadlineAt) }),
	});
}

function toMeteredRequest(record: LlmRequestRecord): MeteredRequest {
	// `outcome` is the dispatch's; the row records usage, which already says it.
	const { outcome: _outcome, ...request } = record;
	return request;
}

/** The row's plane: the caller's, else its task's (`embedding` rows say so). */
function planeOf(target: LlmSpendTarget, meter: LlmCallMeter): { plane?: LlmUsagePlane } {
	const plane = target.plane ?? (meter.task ? taskPolicy(meter.task).plane : undefined);
	return plane ? { plane } : {};
}

/** The call-level tags every row of `meter` carries. */
function callTags(target: LlmSpendTarget, meter: LlmCallMeter) {
	return {
		feature: target.feature,
		requestId: meter.requestId,
		...(meter.task ? { task: meter.task } : {}),
		...(meter.root?.rootRequestId ? { rootRequestId: meter.root.rootRequestId } : {}),
		...(meter.root?.parentCallId ? { parentCallId: meter.root.parentCallId } : {}),
		...planeOf(target, meter),
		...(target.budgetClass ? { budgetClass: target.budgetClass } : {}),
		...(target.reservationId ? { reservationId: target.reservationId } : {}),
		...(target.policyVersion === undefined ? {} : { policyVersion: target.policyVersion }),
		...(target.qualityResult ? { qualityResult: target.qualityResult } : {}),
		...(target.isFallback === undefined ? {} : { isFallback: target.isFallback }),
		...(target.isCalibrated === undefined ? {} : { isCalibrated: target.isCalibrated }),
		...(target.isLocalEngine === undefined ? {} : { isLocalEngine: target.isLocalEngine }),
	};
}

/** Tries of the direct write before a batch falls back to a scheduled write. */
const DIRECT_WRITE_TRIES = 2;

/**
 * Store one batch durably. `await`: the mutation, tried twice, then handed to
 * the scheduler, whose job is stored in the same database the ledger is (a
 * scheduled write survives the action that queued it). `schedule`: queued
 * directly, tried twice. Throws only when every path failed. Re-sending a
 * batch that did land in an ambiguous failure writes nothing twice:
 * `recordRequests` skips a `(requestId, attempt)` it already holds.
 */
export async function storeRequestBatch(
	ctx: SpendCtx,
	args: RequestBatchArgs,
	write: 'await' | 'schedule' = 'await'
): Promise<void> {
	let lastError: unknown;
	if (write === 'await') {
		for (let tryNumber = 0; tryNumber < DIRECT_WRITE_TRIES; tryNumber++) {
			try {
				await ctx.runMutation(internal.analytics.llmUsage.recordRequests, args);
				return;
			} catch (error) {
				lastError = error;
			}
		}
	}
	for (let tryNumber = 0; tryNumber < DIRECT_WRITE_TRIES; tryNumber++) {
		try {
			await ctx.scheduler.runAfter(0, internal.analytics.llmUsage.recordRequests, args);
			return;
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}

/**
 * Store the requests `meter` holds and has not stored yet, one row each, in
 * batches ({@link storeRequestBatch}: retried, then scheduled). A batch is
 * acknowledged only once stored; when a batch cannot be stored at all, this
 * throws and leaves it and the later ones pending on the meter, so the next
 * flush sends them again. Writes nothing when nothing is pending (a call that
 * never reached a provider). Every meter owner flushes through this.
 */
export async function persistMeteredSpend(
	ctx: SpendCtx,
	target: LlmSpendTarget,
	meter: LlmCallMeter,
	write: 'await' | 'schedule' = 'await'
): Promise<void> {
	const pending = meter.pendingWrites();
	// Holds whose dispatch has ended settle in the batch that carries their
	// last pending request; one with nothing pending settles in the last batch.
	const settleable = meter.closedUnsettledHolds();
	const lastBatchStart =
		Math.max(0, Math.ceil(pending.length / MAX_METERED_REQUESTS_PER_WRITE) - 1) *
		MAX_METERED_REQUESTS_PER_WRITE;
	for (
		let start = 0;
		start < Math.max(pending.length, 1);
		start += MAX_METERED_REQUESTS_PER_WRITE
	) {
		const batch = pending.slice(start, start + MAX_METERED_REQUESTS_PER_WRITE);
		const settles = settleable.filter((hold) =>
			holdSettlesIn(hold.reservationId, pending, start, start === lastBatchStart)
		);
		if (batch.length === 0 && settles.length === 0) break;
		await storeRequestBatch(
			ctx,
			{
				...callTags(target, meter),
				requests: batch.map(toMeteredRequest),
				...(settles.length
					? {
							settlements: settles.map((hold) => ({
								reservationId: hold.reservationId,
								expectedRequests: meter.requestsUnder(hold.reservationId),
							})),
						}
					: {}),
			},
			write
		);
		meter.acknowledge(batch);
		for (const hold of settles) meter.markHoldSettled(hold.reservationId);
	}
}

/**
 * Whether a hold settles in the batch starting at `start`: the batch holds the
 * hold's last pending request, or the hold has none pending and this is the
 * last batch. A settlement only closes the hold once every request it covered
 * is in the ledger (`expectedRequests`), so the order batches land in cannot
 * under-charge it.
 */
function holdSettlesIn(
	reservationId: string,
	pending: readonly LlmRequestRecord[],
	start: number,
	isLastBatch: boolean
): boolean {
	let last = -1;
	for (let index = 0; index < pending.length; index++) {
		if (pending[index]?.reservationId === reservationId) last = index;
	}
	if (last < 0) return isLastBatch;
	return last >= start && last < start + MAX_METERED_REQUESTS_PER_WRITE;
}

/**
 * Run one model call under a fresh meter and write its rows. `run` must pass
 * the meter to the dispatch helper it calls (`meter` on every `runLlm*` and on
 * `runEmbedding`).
 */
export async function meterLlmCall<R>(
	ctx: SpendCtx,
	target: LlmSpendTarget,
	run: (meter: LlmCallMeter) => Promise<R>,
	options: MeterLlmCallOptions = {}
): Promise<R> {
	const meter = meterFor(ctx, target);
	let result: R;
	try {
		result = await run(meter);
	} catch (error) {
		try {
			await persistMeteredSpend(ctx, target, meter, options.write);
		} catch {
			// ignore — spend accounting must not replace the provider's error
		}
		if (options.rethrow !== 'as_is' && error instanceof LlmPartialUsageError) throw error.cause;
		throw error;
	}
	try {
		await persistMeteredSpend(ctx, target, meter, options.write);
	} catch (error) {
		if (options.onWriteError !== 'ignore') throw error;
	}
	return result;
}
