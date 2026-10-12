/**
 * The task-policy catalog (ADR-0073): one entry per AI task, saying which plane
 * runs it, on which tiers, within which limits, with which retry allowance and
 * fallback, and which ledger `feature` tags its calls record under today.
 *
 * Code only, no schema. The task NAMES are shared with the web app
 * (`@owlat/shared/aiRouting`); this file gives each one its policy, and the
 * `satisfies` below makes a name without an entry a compile error.
 *
 * THE VALUES ARE TODAY'S ROUTES. Every entry reproduces what the call sites do
 * on the day this catalog landed (the inventory is in the AI routing run's
 * contract notes), so reading the catalog changes nothing:
 *
 *   - `tiers` lists the tiers a task runs on today, the usual one first. A
 *     task with two tiers either routes per surface today (clarification:
 *     the Team Inbox samples on fast, Postbox on capable, Answer mode by the
 *     eagerness dial) or can be downgraded by `LLM_COMPLEXITY_ROUTING`
 *     (`lib/llmProvider.ts`).
 *   - OUTPUT AND REASONING CEILINGS bound every generative task, sized from
 *     its prompt and schema with room above anything it produces today:
 *     verdicts and scores ({@link SMALL_OUTPUT}), lists and short replies
 *     ({@link MEDIUM_OUTPUT}), drafts and long extractions
 *     ({@link LARGE_OUTPUT}), whole documents ({@link DOCUMENT_OUTPUT}). The
 *     reasoning share is generous because a reasoning model spends it before
 *     it writes. The dispatch sends output + reasoning, clamped to what the
 *     model accepts (`./modelOutputLimits.ts`), so no ceiling here can exceed
 *     a model's own maximum. Embeddings produce no text: null. `null` input
 *     limits mean "no limit today".
 *   - Deadlines are today's effective bounds: a one-shot call already fails
 *     at the runtime's 300 s response-header timeout, and a tool loop or
 *     stream at the 10-minute action limit, so the catalog says so and the
 *     call fails as itself, recorded, rather than as a killed action. Every
 *     call also spends from its action's budget (`./actionDeadline.ts`).
 *   - `maxAttempts` is the attempt budget the dispatch gives the call today:
 *     `MAX_LLM_ATTEMPTS` for one-shot and streamed calls (a stream's SDK
 *     retries re-send its opening request), `INTERACTIVE_LLM_ATTEMPTS` where
 *     `interactiveLlmPolicy` applies, 1 for the connection probe.
 *
 * READERS. The resolver (`lib/llmProvider.ts`, through `./taskRouting.ts`)
 * takes every call's tier from `tiers`: call sites name a task, never a tier
 * of their own, and a tier the task does not list is refused. The dispatch
 * reads the output and reasoning ceilings, the deadline and the attempt
 * allowance (`./taskLimits.ts`, `./callShape.ts`), and refuses a resolved
 * model whose tier the call's task does not allow (`./callShape.ts`).
 * `lib/__tests__/resolverCallSites.test.ts` proves every call site resolves
 * the tier it resolved before the catalog existed.
 */

import type { AiTaskName } from '@owlat/shared/aiRouting';
import { isAiTaskName } from '@owlat/shared/aiRouting';
import type { LlmUsagePlane } from '../llmUsageTags';
import {
	INTERACTIVE_LLM_ATTEMPTS,
	INTERACTIVE_LLM_DEADLINE_MS,
	MAX_LLM_ATTEMPTS,
} from './retryPolicy';
import { PLUGIN_LLM_MAX_OUTPUT_TOKENS } from '../../plugins/llmRequest';

export type LlmTier = 'fast' | 'capable';

/**
 * Which ceiling slice a task's spend draws on (D1, D4). `triage`: paid guard and
 * classify calls, which may use the triage allowance held back inside each
 * ceiling. `standard`: everything else. Shadow spend is a mode, not a task
 * property: the caller marks a shadow call `shadow` whatever its task.
 */
export type TaskBudgetClass = 'triage' | 'standard';

/** Who waits on the call. Background work defers when the ceiling is reached (D1). */
export type TaskPriority = 'interactive' | 'pipeline' | 'background';

/**
 * The fallback a task may take. `none`: a failure ends the call and the caller
 * keeps its deterministic baseline or goes to human review. `language_hop`:
 * the decision plane's one opt-in, breaker-protected hop onto the fast language
 * tier, for operational failures only (D3). No inbound background task may take
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

type EntryInput = Omit<
	TaskPolicyEntry,
	'task' | 'maxInputTokens' | 'maxOutputTokens' | 'maxReasoningTokens' | 'evalVersion' | 'fallback'
> &
	Partial<
		Pick<
			TaskPolicyEntry,
			'maxInputTokens' | 'maxOutputTokens' | 'maxReasoningTokens' | 'evalVersion' | 'fallback'
		>
	>;

const UNLIMITED = { maxInputTokens: null, maxOutputTokens: null, maxReasoningTokens: null };

/** A verdict, a score or a one-line answer: a few hundred tokens today. */
const SMALL_OUTPUT = { maxOutputTokens: 1_024, maxReasoningTokens: 4_096 } as const;
/** A list (slots, relations, coverage), a short reply or a few options. */
const MEDIUM_OUTPUT = { maxOutputTokens: 4_096, maxReasoningTokens: 4_096 } as const;
/** A draft, an assistant answer, or a long structured extraction. */
const LARGE_OUTPUT = { maxOutputTokens: 8_192, maxReasoningTokens: 8_192 } as const;
/** A whole document: a translated batch, a generated HTML page. */
const DOCUMENT_OUTPUT = { maxOutputTokens: 16_384, maxReasoningTokens: 8_192 } as const;
const REPLY_MS = INTERACTIVE_LLM_DEADLINE_MS.reply;
/** A one-shot request: the runtime's fetch gives up on response headers after 300 s. */
const ONE_SHOT_DEADLINE_MS = 300_000;
/** A tool loop or a stream: inside the 10-minute action limit, with a margin to record. */
const LOOP_DEADLINE_MS = 540_000;

/** A language call with today's defaults: no output ceiling, no evaluation. */
function language(input: Omit<EntryInput, 'plane'>): Omit<TaskPolicyEntry, 'task'> {
	return { ...UNLIMITED, fallback: 'none', evalVersion: 0, plane: 'language', ...input };
}

/** A decision-plane task. Inbound ones never take the paid hop (D3). */
function decision(
	input: Omit<EntryInput, 'plane' | 'tiers' | 'deadlineMs'> &
		Partial<Pick<TaskPolicyEntry, 'deadlineMs'>>
): Omit<TaskPolicyEntry, 'task'> {
	return {
		...UNLIMITED,
		fallback: 'none',
		evalVersion: 0,
		deadlineMs: null,
		...input,
		plane: 'decision',
		tiers: ['fast'],
	};
}

function embedding(
	input: Pick<EntryInput, 'priority' | 'features'>
): Omit<TaskPolicyEntry, 'task'> {
	return {
		...UNLIMITED,
		fallback: 'none',
		evalVersion: 0,
		plane: 'embedding',
		tiers: ['fast'],
		deadlineMs: ONE_SHOT_DEADLINE_MS,
		maxAttempts: MAX_LLM_ATTEMPTS,
		budgetClass: 'standard',
		...input,
	};
}

const background = { priority: 'background', budgetClass: 'standard' } as const;
const pipeline = { priority: 'pipeline', budgetClass: 'standard' } as const;
const interactive = { priority: 'interactive', budgetClass: 'standard' } as const;
const triage = { priority: 'pipeline', budgetClass: 'triage' } as const;
const oneShot = { deadlineMs: ONE_SHOT_DEADLINE_MS, maxAttempts: MAX_LLM_ATTEMPTS } as const;
const loop = { deadlineMs: LOOP_DEADLINE_MS, maxAttempts: MAX_LLM_ATTEMPTS } as const;
const replySurface = { deadlineMs: REPLY_MS, maxAttempts: INTERACTIVE_LLM_ATTEMPTS } as const;

const ENTRIES = {
	'mail.guard': language({
		...SMALL_OUTPUT,
		tiers: ['fast'],
		...triage,
		...oneShot,
		features: ['agent_security_scan'],
	}),
	'mail.classify': language({
		...SMALL_OUTPUT,
		tiers: ['fast'],
		...triage,
		...oneShot,
		features: ['agent_classify', 'postbox_category'],
	}),
	'mail.extract': language({
		...LARGE_OUTPUT,
		tiers: ['fast'],
		...pipeline,
		...oneShot,
		features: ['interpret', 'postbox_commitment'],
	}),
	'mail.verify': language({
		...SMALL_OUTPUT,
		tiers: ['fast'],
		...pipeline,
		...oneShot,
		features: ['interpret_verify'],
	}),
	'mail.clarify': language({
		...MEDIUM_OUTPUT,
		tiers: ['fast', 'capable'],
		...pipeline,
		...oneShot,
		features: [
			'agent_clarify',
			'postbox_clarify_slots',
			'postbox_clarify_diverge',
			'postbox_clarify_localize',
			'postbox_answer_slots',
			'postbox_answer_diverge',
			'postbox_answer_localize',
		],
	}),
	// The sampled candidate replies of the divergence check, on the same route
	// as `mail.clarify`. They keep their surface's feature and carry this task
	// explicitly, so the ledger counts samples and their cost apart (ADR-0073,
	// Phase 3). No feature maps here.
	'mail.clarify_sample': language({
		...MEDIUM_OUTPUT,
		tiers: ['fast', 'capable'],
		...pipeline,
		...oneShot,
		features: [],
	}),
	'mail.draft': language({
		...LARGE_OUTPUT,
		tiers: ['capable', 'fast'],
		...pipeline,
		...loop,
		features: ['agent_draft', 'postbox_draft', 'postbox_clarify_draft', 'postbox_clarify_delta'],
	}),
	'mail.draft_check': language({
		...SMALL_OUTPUT,
		tiers: ['fast'],
		...pipeline,
		...oneShot,
		features: ['agent_draft_selfcheck', 'postbox_draft_selfcheck', 'postbox_clarify_selfcheck'],
	}),
	'mail.outcome_sentiment': language({
		...SMALL_OUTPUT,
		tiers: ['fast'],
		...background,
		...oneShot,
		features: ['agent_outcome_sentiment'],
	}),
	'mail.voice_profile': language({
		...SMALL_OUTPUT,
		tiers: ['fast'],
		...background,
		...oneShot,
		features: ['postbox_voice_profile'],
	}),
	'mail.compose': language({
		...LARGE_OUTPUT,
		tiers: ['capable', 'fast'],
		...interactive,
		...loop,
		features: ['postbox_answer_draft', 'postbox_revise_draft'],
	}),
	'mail.plan_coverage': language({
		...MEDIUM_OUTPUT,
		tiers: ['fast'],
		...interactive,
		...replySurface,
		features: ['answer_plan_coverage'],
	}),
	'mail.suggest': language({
		...MEDIUM_OUTPUT,
		tiers: ['fast'],
		...interactive,
		deadlineMs: REPLY_MS,
		maxAttempts: MAX_LLM_ATTEMPTS,
		features: ['postbox_suggest_replies'],
	}),
	'mail.complete': language({
		...SMALL_OUTPUT,
		tiers: ['fast'],
		...interactive,
		deadlineMs: INTERACTIVE_LLM_DEADLINE_MS.completion,
		maxAttempts: INTERACTIVE_LLM_ATTEMPTS,
		features: ['postbox_complete_draft'],
	}),
	'mail.ask': language({
		...MEDIUM_OUTPUT,
		tiers: ['capable'],
		...interactive,
		...replySurface,
		features: ['postbox_ask_thread'],
	}),
	'mail.rewrite': language({
		...MEDIUM_OUTPUT,
		tiers: ['capable', 'fast'],
		...interactive,
		...replySurface,
		features: ['postbox_rewrite_selection'],
	}),
	'mail.coach': language({
		...SMALL_OUTPUT,
		tiers: ['fast'],
		...interactive,
		...replySurface,
		features: ['postbox_coach_draft'],
	}),
	'mail.translate': language({
		...DOCUMENT_OUTPUT,
		tiers: ['fast'],
		...interactive,
		...oneShot,
		features: ['translate'],
	}),
	'mail.rule_compile': language({
		...SMALL_OUTPUT,
		tiers: ['fast'],
		...interactive,
		...oneShot,
		features: ['handling_rule_compile'],
	}),
	'knowledge.extract': language({
		...LARGE_OUTPUT,
		tiers: ['fast'],
		...background,
		deadlineMs: 180_000,
		maxAttempts: MAX_LLM_ATTEMPTS,
		features: ['knowledge_extract_message', 'knowledge_extract_file', 'knowledge_extract_mail'],
	}),
	'knowledge.relate': language({
		...MEDIUM_OUTPUT,
		tiers: ['fast'],
		...background,
		...oneShot,
		features: ['knowledge_autolink'],
	}),
	'file.summarize': language({
		...SMALL_OUTPUT,
		tiers: ['fast'],
		...background,
		...oneShot,
		features: ['semantic_file'],
	}),
	'assistant.answer': language({
		...LARGE_OUTPUT,
		tiers: ['capable', 'fast'],
		...interactive,
		...loop,
		features: ['assistant_chat', 'chat_assistant'],
	}),
	'assistant.tool_draft': language({
		...LARGE_OUTPUT,
		tiers: ['capable', 'fast'],
		...interactive,
		...oneShot,
		features: ['assistant_tool_draft'],
	}),
	'assistant.quick_query': language({
		...MEDIUM_OUTPUT,
		tiers: ['capable'],
		...interactive,
		...oneShot,
		features: ['assistant_quick_query'],
	}),
	'analytics.visualize': language({
		...DOCUMENT_OUTPUT,
		tiers: ['capable'],
		...interactive,
		...oneShot,
		features: ['visualization'],
	}),
	'analytics.visualize_title': language({
		...SMALL_OUTPUT,
		tiers: ['fast'],
		...interactive,
		...oneShot,
		features: ['visualization_title'],
	}),
	// Plugin rows record under `plugin:<id>` (see taskForFeature); the plugin
	// host owns its own deadline (`withTimeout`) and reservation.
	'plugin.invoke': language({
		tiers: ['fast', 'capable'],
		...pipeline,
		...oneShot,
		maxOutputTokens: PLUGIN_LLM_MAX_OUTPUT_TOKENS,
		features: [],
	}),
	'decision.connection_probe': decision({
		...SMALL_OUTPUT,
		...interactive,
		maxAttempts: 1,
		features: ['settings.decision_connection_test'],
	}),
	'mail.triage': decision({
		...SMALL_OUTPUT,
		...triage,
		maxAttempts: MAX_LLM_ATTEMPTS,
		features: ['decision_triage'],
	}),
	'mail.category': decision({
		...SMALL_OUTPUT,
		...triage,
		maxAttempts: MAX_LLM_ATTEMPTS,
		features: ['decision_category'],
	}),
	'mail.disposition': decision({
		...SMALL_OUTPUT,
		...triage,
		maxAttempts: MAX_LLM_ATTEMPTS,
		features: ['decision_disposition'],
	}),
	'mail.claim_check': decision({
		...SMALL_OUTPUT,
		...pipeline,
		maxAttempts: MAX_LLM_ATTEMPTS,
		features: ['decision_claim_check'],
	}),
	'mail.necessity': decision({
		...SMALL_OUTPUT,
		...pipeline,
		maxAttempts: MAX_LLM_ATTEMPTS,
		features: ['decision_necessity'],
	}),
	'mail.draft_quality': decision({
		...SMALL_OUTPUT,
		...pipeline,
		maxAttempts: MAX_LLM_ATTEMPTS,
		features: [],
	}),
	'embedding.index': embedding({
		priority: 'background',
		features: ['embedding_knowledge', 'embedding_file'],
	}),
	'embedding.query': embedding({
		priority: 'pipeline',
		features: ['embedding_knowledge_search', 'embedding_file_search', 'embedding_quick_query'],
	}),
} satisfies Record<AiTaskName, Omit<TaskPolicyEntry, 'task'>>;

/** The catalog, frozen. Keyed by task name; every name has exactly one entry. */
export const TASK_POLICIES: Readonly<Record<AiTaskName, TaskPolicyEntry>> = Object.freeze(
	Object.fromEntries(
		Object.entries(ENTRIES).map(([task, entry]) => [task, Object.freeze({ ...entry, task })])
	) as Record<AiTaskName, TaskPolicyEntry>
);

/** The policy of one task. */
export function taskPolicy(task: AiTaskName): TaskPolicyEntry {
	return TASK_POLICIES[task];
}

const PLUGIN_FEATURE_PREFIX = 'plugin:';

const TASK_BY_FEATURE: ReadonlyMap<string, AiTaskName> = new Map(
	Object.values(TASK_POLICIES).flatMap((entry) =>
		entry.features.map((feature) => [feature, entry.task] as const)
	)
);

/**
 * The task a ledger `feature` tag belongs to, or `undefined` for a tag the
 * catalog does not know. Lets the ledger stamp `task` on rows whose call site
 * only knows its feature, and lets reports group legacy rows by task.
 */
export function taskForFeature(feature: string): AiTaskName | undefined {
	if (feature.startsWith(PLUGIN_FEATURE_PREFIX)) return 'plugin.invoke';
	if (isAiTaskName(feature)) return feature;
	return TASK_BY_FEATURE.get(feature);
}
