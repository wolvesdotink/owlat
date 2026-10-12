/**
 * Team Inbox agent spend in the usage ledger (#1259).
 *
 * The `llmUsageEvents` ledger is the one store the spend ceiling reads
 * (`analytics/spendBudget.ts`), so every billed call the agent pipeline makes
 * writes its rows there, at the call site, under an `agent_<step>` feature. The
 * walker still stores a step's usage on its `agentActions` row, but that is the
 * per-step reporting view (`agentHealth.getCostByStep`), not a second money
 * store: nothing sums it against the ceiling.
 *
 * Recording where the call is made, rather than from the walker, keeps each
 * request in exactly one row on every path: a step that throws, a fail-soft step
 * that swallows its error, a transition the lifecycle rejects, and a write that
 * fails after a paid generation all leave the rows already written. Every row
 * of one inbound message's run shares the root request `team:<message id>`
 * (ADR-0073). Pure of 'use node', so the V8 and Node steps share it.
 */

import { meterLlmCall } from '../../analytics/meteredSpend';
import type { Id } from '../../_generated/dataModel';
import { rootRequest, type LlmCallMeter, type LlmRootContext } from '../../lib/llm/requestMeter';

type SpendCtx = Parameters<typeof meterLlmCall>[0];

/**
 * Ledger features of the agent steps that meter their own calls. The draft
 * step's generation and self-check record through the shared draft service as
 * `agent_draft` and `agent_draft_selfcheck`.
 */
export type AgentSpendFeature = 'agent_security_scan' | 'agent_classify' | 'agent_clarify';

/** The root request every call of one inbound message's agent run belongs to. */
export function teamRoot(inboundMessageId: Id<'inboundMessages'>): LlmRootContext {
	return rootRequest('team', inboundMessageId);
}

/**
 * Run one model call and record every provider request it made, one row each,
 * whether it returns or throws (a failure rethrows the provider's original
 * error). A failed ledger write never fails the call: a lost row under-counts,
 * and failing the step over it would drop mail.
 */
export async function meterAgentCall<R>(
	ctx: SpendCtx,
	feature: AgentSpendFeature,
	inboundMessageId: Id<'inboundMessages'>,
	call: (meter: LlmCallMeter) => Promise<R>,
	/** An awaiting caller's deadline (ADR-0073); the action's own budget bounds it too. */
	deadlineAt?: number
): Promise<R> {
	const root = teamRoot(inboundMessageId);
	return meterLlmCall(
		ctx,
		{ feature, root: deadlineAt === undefined ? root : { ...root, deadlineAt } },
		call,
		{ onWriteError: 'ignore' }
	);
}
