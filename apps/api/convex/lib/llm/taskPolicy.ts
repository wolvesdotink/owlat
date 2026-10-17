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
import {
	INTERACTIVE_LLM_ATTEMPTS,
	INTERACTIVE_LLM_DEADLINE_MS,
	MAX_LLM_ATTEMPTS,
} from './retryPolicy';
import { PLUGIN_LLM_MAX_OUTPUT_TOKENS } from '../../plugins/llmRequest';

export type {
	LlmTier,
	TaskBudgetClass,
	TaskFallback,
	TaskPolicyEntry,
	TaskPriority,
} from './taskPolicyTypes';
import type { TaskPolicyEntry } from './taskPolicyTypes';

/** The fields an entry may leave out: they default to {@link UNLIMITED}, `none` and 0. */
type DefaultedField =
	| 'maxInputTokens'
	| 'maxOutputTokens'
	| 'maxReasoningTokens'
	| 'maxToolRounds'
	| 'maxRetrievalCalls'
	| 'evalVersion'
	| 'fallback';

type EntryInput = Omit<TaskPolicyEntry, 'task' | DefaultedField> &
	Partial<Pick<TaskPolicyEntry, DefaultedField>>;

const UNLIMITED = {
	maxInputTokens: null,
	maxOutputTokens: null,
	maxReasoningTokens: null,
	maxToolRounds: null,
	maxRetrievalCalls: null,
};

/**
 * The assistant turn's tool rounds: `DEFAULT_MAX_TOOL_STEPS` in
 * `./dispatchStream.ts`, the step limit every turn ran with before this
 * catalog (a test pins the two equal).
 */
const ASSISTANT_TOOL_ROUNDS = 8;

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
	// Read on arrival (INBOX_ZERO_PLAN §2.4): 1–2 verbatim spans and a fact.
	// One attempt: a failed gist counts instead (`mail/interpret/gist.ts`).
	'mail.gist': language({
		maxOutputTokens: 256,
		maxReasoningTokens: 0,
		tiers: ['fast'],
		...background,
		deadlineMs: ONE_SHOT_DEADLINE_MS,
		maxAttempts: 1,
		features: ['interpret_gist'],
	}),
	// Read on arrival (§6.5): one batched call per digest, verbatim spans per line.
	// One attempt: the digest's durable claim counter is the only retry owner.
	'mail.digest': language({
		...MEDIUM_OUTPUT,
		tiers: ['fast'],
		...background,
		deadlineMs: ONE_SHOT_DEADLINE_MS,
		maxAttempts: 1,
		features: ['digest_lines'],
	}),
	// Read on arrival (§6.2): a rule's AI question over the last 50 mails, one call.
	'mail.rule_test': language({
		...MEDIUM_OUTPUT,
		tiers: ['fast'],
		...interactive,
		...oneShot,
		features: ['rule_test'],
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
		features: ['handling_rule_compile', 'filter_rule_compile'],
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
		// One retrieval per round: a turn that searches once a round, as turns
		// do, is never refused; parallel searches past it are (Phase 5).
		maxToolRounds: ASSISTANT_TOOL_ROUNDS,
		maxRetrievalCalls: ASSISTANT_TOOL_ROUNDS,
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
