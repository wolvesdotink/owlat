/**
 * Test helpers for code that dispatches model calls under a meter.
 *
 * A test that mocks `lib/llm/dispatch` replaces the code that records provider
 * requests, so {@link metered} wraps a mocked dispatch function to record ONE
 * request per call on `opts.meter`, the way the real dispatch records a
 * single-attempt call: the returned usage on success, the usage an
 * `LlmPartialUsageError` carries on a billed failure, none otherwise.
 * {@link ledgerRows} reads back what reached the ledger through a mocked ctx.
 */

import { getFunctionName } from 'convex/server';
import type { TokenUsage } from '../../agent/steps/types';
import { LlmPartialUsageError } from '../../lib/llm/partialUsage';
import type { LlmCallMeter } from '../../lib/llm/requestMeter';

type Dispatched = { readonly tokenUsage?: TokenUsage; readonly modelUsed?: string };

/** Wrap a mocked dispatch function so it records its call on `opts.meter`. */
export function metered<A, R extends Dispatched>(
	impl: (opts: A) => Promise<R>
): (opts: A) => Promise<R> {
	return async (opts) => {
		const meter = (opts as { meter?: LlmCallMeter } | undefined)?.meter;
		try {
			const result = await impl(opts);
			meter?.record({
				outcome: 'ok',
				latencyMs: 0,
				...(result.tokenUsage ? { usage: result.tokenUsage } : {}),
				...(result.modelUsed ? { modelUsed: result.modelUsed } : {}),
			});
			return result;
		} catch (error) {
			meter?.record({
				outcome: 'failed',
				latencyMs: 0,
				...(error instanceof LlmPartialUsageError
					? { usage: error.tokenUsage, modelUsed: error.modelUsed }
					: {}),
			});
			throw error;
		}
	};
}

/** One ledger row as a mocked ctx saw it written. */
export interface LedgerRow {
	readonly feature: string;
	readonly usage?: TokenUsage;
	readonly modelUsed?: string;
	readonly attempt: number;
	readonly requestId?: string;
	readonly rootRequestId?: string;
	readonly parentCallId?: string;
	readonly task?: string;
	readonly plane?: string;
}

interface RecordedCall {
	readonly feature: string;
	readonly requestId?: string;
	readonly rootRequestId?: string;
	readonly parentCallId?: string;
	readonly task?: string;
	readonly plane?: string;
	readonly requests: ReadonlyArray<{
		readonly attempt: number;
		readonly usage?: TokenUsage;
		readonly modelUsed?: string;
	}>;
}

const RECORD_REQUESTS = 'analytics/llmUsage:recordRequests';

function isRecordRequests(ref: unknown): boolean {
	try {
		return getFunctionName(ref as never) === RECORD_REQUESTS;
	} catch {
		return false;
	}
}

/**
 * The rows written through `recordRequests` by `runMutation` or
 * `scheduler.runAfter` mocks, in call order, one per provider request.
 */
export function ledgerRows(
	...mocks: ReadonlyArray<{ readonly mock: { readonly calls: readonly unknown[][] } }>
): LedgerRow[] {
	const rows: LedgerRow[] = [];
	for (const fn of mocks) {
		for (const call of fn.mock.calls) {
			// runMutation(ref, args) or scheduler.runAfter(delay, ref, args)
			const index = call.findIndex((arg) => isRecordRequests(arg));
			if (index < 0) continue;
			const args = call[index + 1] as RecordedCall;
			for (const request of args.requests) {
				rows.push({
					feature: args.feature,
					attempt: request.attempt,
					...(request.usage ? { usage: request.usage } : {}),
					...(request.modelUsed ? { modelUsed: request.modelUsed } : {}),
					...(args.requestId ? { requestId: args.requestId } : {}),
					...(args.rootRequestId ? { rootRequestId: args.rootRequestId } : {}),
					...(args.parentCallId ? { parentCallId: args.parentCallId } : {}),
					...(args.task ? { task: args.task } : {}),
					...(args.plane ? { plane: args.plane } : {}),
				});
			}
		}
	}
	return rows;
}
