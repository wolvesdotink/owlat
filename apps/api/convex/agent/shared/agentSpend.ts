/**
 * Team Inbox agent spend in the usage ledger (#1259).
 *
 * The `llmUsageEvents` ledger is the one store the spend ceiling reads
 * (`analytics/spendBudget.ts`), so every billed call the agent pipeline makes
 * writes its row there, at the call site, under an `agent_<step>` feature. The
 * walker still stores a step's usage on its `agentActions` row, but that is the
 * per-step reporting view (`agentHealth.getCostByStep`), not a second money
 * store: nothing sums it against the ceiling.
 *
 * Recording where the call is made, rather than from the walker, keeps each
 * call in exactly one row on every path: a step that throws, a fail-soft step
 * that swallows its error, a transition the lifecycle rejects, and a write that
 * fails after a paid generation all leave the row already written. Pure of
 * 'use node', so the V8 and Node steps share it.
 */

import { recordLlmSpend } from '../../analytics/llmUsage';
import { recordSpendOnFailure } from '../../analytics/failedLlmSpend';
import type { TokenUsage } from '../steps/types';

type SpendCtx = Parameters<typeof recordLlmSpend>[0];

/**
 * Ledger features of the agent steps that meter their own calls. The draft
 * step's generation and self-check record through the shared draft service as
 * `agent_draft` and `agent_draft_selfcheck`.
 */
export type AgentSpendFeature =
	| 'agent_security_scan'
	| 'agent_context_retrieval'
	| 'agent_classify'
	| 'agent_clarify';

/**
 * Run one model call and record what it billed: its usage when it returns, and
 * the usage a failed run carries when it throws (`recordSpendOnFailure`, which
 * rethrows the provider's original error, so nothing above can record the same
 * usage again). A failed ledger write never fails the call.
 */
export async function meterAgentCall<
	R extends { readonly tokenUsage?: TokenUsage; readonly modelUsed?: string },
>(ctx: SpendCtx, feature: AgentSpendFeature, call: () => Promise<R>): Promise<R> {
	const result = await recordSpendOnFailure(ctx, feature, call());
	try {
		await recordLlmSpend(ctx, feature, result.tokenUsage, result.modelUsed);
	} catch {
		// ignore — a lost row under-counts; failing the step over it would drop mail
	}
	return result;
}
