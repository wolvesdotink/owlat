/**
 * The task-policy catalog's types, split out of `./taskPolicy.ts`,
 * which holds the entries and re-exports these. Pure.
 */

import type { AiTaskName } from '@owlat/shared/aiRouting';
import type { LlmUsagePlane } from '../llmUsageTags';

export type LlmTier = 'fast' | 'capable';

/**
 * Which ceiling slice a task's spend draws on. `triage`: paid guard and
 * classify calls, which may use the triage allowance held back inside each
 * ceiling. `standard`: everything else. Shadow spend is a mode, not a task
 * property: the caller marks a shadow call `shadow` whatever its task.
 */
export type TaskBudgetClass = 'triage' | 'standard';

/** Who waits on the call. Background work defers when the ceiling is reached. */
export type TaskPriority = 'interactive' | 'pipeline' | 'background';

/**
 * The fallback a task may take. `none`: a failure ends the call and the caller
 * keeps its deterministic baseline or goes to human review. `language_hop`:
 * the decision plane's one opt-in, breaker-protected hop onto the fast language
 * tier, for operational failures only. No inbound background task may take
 * a paid fallback, so every inbound decision task below says `none`.
 */
export type TaskFallback = 'none' | 'language_hop';

export interface TaskPolicyEntry {
	readonly task: AiTaskName;
	readonly plane: LlmUsagePlane;
	/** Tiers the task runs on today, the usual one first. The decision plane's `llm` adapter uses fast. */
	readonly tiers: readonly [LlmTier, ...LlmTier[]];
	/** Max input tokens per request. `null`: no limit today. */
	readonly maxInputTokens: number | null;
	/**
	 * Max output tokens per request, reasoning excluded. `null`: no limit.
	 * Enforced on its own for the `anthropic` and `openai` (non-reasoning)
	 * families; elsewhere output and reasoning share one wire field, and this
	 * split is ADVISORY (`./taskLimits.ts` `OUTPUT_SPLIT_BY_FAMILY`).
	 */
	readonly maxOutputTokens: number | null;
	/**
	 * Max billed reasoning tokens per request. `null`: no limit. The
	 * `anthropic` and `openai` families spend none (thinking is not enabled; the
	 * model does not reason). `openai-reasoning` bounds it with the reasoning
	 * effort and the combined field; `combined` providers with the combined field
	 * only: for them the split is advisory.
	 */
	readonly maxReasoningTokens: number | null;
	/** Deadline for the whole call, every attempt included. `null`: none today (adapter default). */
	readonly deadlineMs: number | null;
	/** Provider requests per call, the first included. */
	readonly maxAttempts: number;
	/**
	 * Model rounds a tool loop or a tool-calling stream may take:
	 * the dispatch stops the loop there, whatever the caller asked
	 * for. `null`: the caller's own step limit, as today.
	 */
	readonly maxToolRounds: number | null;
	/**
	 * Retrieval tool calls (knowledge and file searches, each one a paid query
	 * embedding) one call of the task may make across all its rounds; the
	 * tool host refuses the rest. `null`: no retrieval tools, or no cap.
	 */
	readonly maxRetrievalCalls: number | null;
	readonly fallback: TaskFallback;
	readonly budgetClass: TaskBudgetClass;
	readonly priority: TaskPriority;
	/**
	 * The evaluation the current values passed. 0: none on record; the values are
	 * today's routes, unevaluated. Bump when a checked-in report backs a change.
	 */
	readonly evalVersion: number;
	/** The ledger `feature` tags this task's calls record under today. */
	readonly features: readonly string[];
}
