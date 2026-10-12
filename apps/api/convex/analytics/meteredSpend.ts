/**
 * The action side of the ledger (ADR-0073): run one metered model call and
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
import type { BudgetClass } from '../lib/validators/aiRouting';
import { MAX_METERED_REQUESTS_PER_WRITE, type MeteredRequest } from './llmUsage';

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
	readonly reservationId?: string;
	readonly policyVersion?: number;
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
	return new LlmCallMeter({
		task: target.task ?? taskForFeature(target.feature),
		root: target.root,
		deadlineAt: callDeadlineAt(ctx, target.root),
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
		...(target.isFallback === undefined ? {} : { isFallback: target.isFallback }),
		...(target.isCalibrated === undefined ? {} : { isCalibrated: target.isCalibrated }),
		...(target.isLocalEngine === undefined ? {} : { isLocalEngine: target.isLocalEngine }),
	};
}

/**
 * Write the requests `meter` has not stored yet, one row each, in batches.
 * Each batch is acknowledged only after it is stored (or scheduled); a failure
 * throws and leaves that batch and the later ones pending for the next flush.
 * Writes nothing when there are none (a call that never reached a provider).
 */
export async function writeMeteredSpend(
	ctx: SpendCtx,
	target: LlmSpendTarget,
	meter: LlmCallMeter,
	write: 'await' | 'schedule' = 'await'
): Promise<void> {
	const pending = meter.pendingWrites();
	for (let start = 0; start < pending.length; start += MAX_METERED_REQUESTS_PER_WRITE) {
		const batch = pending.slice(start, start + MAX_METERED_REQUESTS_PER_WRITE);
		const args = { ...callTags(target, meter), requests: batch.map(toMeteredRequest) };
		if (write === 'schedule') {
			await ctx.scheduler.runAfter(0, internal.analytics.llmUsage.recordRequests, args);
		} else {
			await ctx.runMutation(internal.analytics.llmUsage.recordRequests, args);
		}
		meter.acknowledge(batch);
	}
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

/** Writes per flush before a call gives up: a transient failure gets one more try. */
const FLUSH_TRIES = 2;

/**
 * {@link writeMeteredSpend}, retried once: the requests a failed write left
 * pending go again, and the ledger's idempotency means one that did land in
 * an ambiguous failure is not written twice.
 */
export async function persistMeteredSpend(
	ctx: SpendCtx,
	target: LlmSpendTarget,
	meter: LlmCallMeter,
	write: 'await' | 'schedule' = 'await'
): Promise<void> {
	for (let tryNumber = 1; ; tryNumber++) {
		try {
			await writeMeteredSpend(ctx, target, meter, write);
			return;
		} catch (error) {
			if (tryNumber >= FLUSH_TRIES) throw error;
		}
	}
}
