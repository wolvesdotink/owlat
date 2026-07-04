/**
 * Agent step (module) — see CONTEXT.md "Agent step (module)" and
 * docs/adr/0014-agent-step-module.md.
 *
 * The per-kind compute + routing surface for one stage of the agent
 * pipeline. Two pure functions:
 *   - execute(ctx, input) — runs the work (pattern match, DB joins, or
 *     LLM call).
 *   - route(output, runCtx) — decides what happens next (in-state next
 *     step, state transition optionally followed by a next step, or
 *     `done`).
 *
 * The Agent walker (convex/agent/walker.ts) is the only consumer.
 */

import type { Infer } from 'convex/values';
import type { ActionCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import type {
	securityFlagsValidator,
	classificationValidator,
	tokenUsageValidator,
} from '../../lib/convexValidators';
import type { clarificationQuestionValidator } from '../../inbox/clarificationValidators';

export type AgentStepKind =
	| 'security_scan'
	| 'context_retrieval'
	| 'classify'
	| 'clarify'
	| 'draft'
	| 'route';

// Derived from the canonical Convex validators in lib/validators.ts (the same
// shapes spread into the inboundMessages / agentActions schema columns) so the
// agent-step types can't drift from what's actually stored. `securityFlagsValidator`
// is the accurate superset — it carries the optional `guardUnavailable` flag the
// route step reads off the message.
type SecurityFlags = Infer<typeof securityFlagsValidator>;
type Classification = Infer<typeof classificationValidator>;
type ClarificationQuestion = Infer<typeof clarificationQuestionValidator>;

type ContextTier = 'normal' | 'compacted' | 'emergency';

/**
 * Domain-only fields a route function returns. The Agent walker assembles
 * the full lifecycle TransitionInput by adding bookkeeping (`at`,
 * `completedActionId`, `output`, `durationMs`, `tokenUsage`,
 * `modelUsed`).
 *
 * Mirrors the lifecycle's TransitionInput variants minus the bookkeeping
 * fields — see `inbox/processingLifecycle.ts` for the full union.
 */
export type RouteTransition =
	| { to: 'security_check' }
	| {
			to: 'classifying';
			securityFlags?: SecurityFlags;
			contextTier?: ContextTier;
	  }
	| { to: 'drafting'; classification?: Classification }
	| {
			to: 'awaiting_clarification';
			questions: ClarificationQuestion[];
			classification?: Classification;
	  }
	| {
			to: 'draft_ready';
			draftResponse?: string;
			draftSubject?: string;
			confidenceScore?: number;
			classification?: Classification;
	  }
	| { to: 'quarantined'; securityFlags: SecurityFlags }
	| {
			to: 'archived';
			reason: 'spam' | 'sender_blocked' | 'classifier_spam' | 'handling_rule_archive';
			securityFlags?: SecurityFlags;
	  }
	| { to: 'approved'; source: 'human' | 'auto'; userId?: string };

export type TokenUsage = Infer<typeof tokenUsageValidator>;

export type AgentStepResult<Out> = {
	output: Out;
	modelUsed?: string;
	tokenUsage?: TokenUsage;
};

/**
 * The walker dispatches the next step by `kind`; the routing function on
 * the current module constructs the input shape the next module expects.
 * Per ADR-0014's Choice D1: pass-through, no accumulator.
 */
export type NextStep = { kind: AgentStepKind; input: unknown };

export type AgentRoute =
	| { kind: 'in_state'; nextStep: NextStep }
	| { kind: 'transition'; transition: RouteTransition; nextStep?: NextStep }
	| { kind: 'done' };

/**
 * Small read-only bag passed to `route`. Currently carries the
 * inboundMessageId (so the route can compose the next step's input) and
 * the agentConfig (so the `route` step can read auto-reply thresholds
 * without re-fetching).
 */
export interface AgentRunContext {
	inboundMessageId: Id<'inboundMessages'>;
	agentConfig: Doc<'agentConfig'> | null;
}

export interface AgentStepModule<K extends AgentStepKind, In, Out> {
	readonly kind: K;
	/** Present iff the step calls an LLM. The walker uses this for
	 * observability tagging — token-usage extraction itself lives in
	 * `lib/llm/dispatch.ts` (ADR-0029) and is called by the module's
	 * `execute`. */
	readonly llm?: { tier: 'fast' | 'capable' };
	execute(ctx: ActionCtx, input: In): Promise<AgentStepResult<Out>>;
	/** Pure routing decision. Sees the executed output, the original
	 * input (for input → nextStep input composition), and the run
	 * context. Returns one of three paths: in-state next-step, state
	 * transition (optionally with a follow-up step), or pipeline done. */
	route(output: Out, input: In, runCtx: AgentRunContext): AgentRoute;
}

/**
 * Erased shape used by the walker's dispatch table. Per-kind callers
 * narrow to the concrete `AgentStepModule<K, In, Out>` via the
 * `STEP_MODULES` registry.
 */
export type AnyAgentStepModule = AgentStepModule<AgentStepKind, unknown, unknown>;
