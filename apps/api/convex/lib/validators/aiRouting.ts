/**
 * Validators for the AI routing records: the routing policy row, the
 * admission records, the guard and budget markers on Team messages, decision
 * artifacts and sender memory. The vocabularies come from
 * `@owlat/shared/aiRouting`, so the settings form and the stored shape cannot
 * drift apart. A leaf module: the schema loads it.
 */

import { v, type Infer } from 'convex/values';
import {
	AI_BUDGET_ERROR_CODE,
	AI_TASK_NAMES,
	BUDGET_HOLD_REASONS,
	GUARD_NOT_RUN_REASONS,
	INTERPRET_DEFER_REASONS,
	MISSING_JUDGMENTS,
	ROUTING_SWITCHES,
} from '@owlat/shared/aiRouting';
import { literalUnion } from '../literalUnion';
import { DECISION_PROVIDER_KINDS, DECISION_ENDPOINT_PROVENANCES } from '../decisionProviders/types';

/** A task-policy catalog name (`lib/llm/taskPolicy.ts`). */
export const aiTaskNameValidator = literalUnion(AI_TASK_NAMES);

// ── Routing policy ────────────────────────────────────────────────────────

/**
 * The routing-policy switches, one optional column each: absent means the
 * default, which is today's behaviour. Keys mirror `ROUTING_SWITCHES`; the
 * `satisfies` makes a switch without a column a compile error.
 */
export const routingSwitchFields = {
	earlyRuleArchive: v.optional(literalUnion(ROUTING_SWITCHES.earlyRuleArchive.values)),
	mtaVerdictTerminal: v.optional(literalUnion(ROUTING_SWITCHES.mtaVerdictTerminal.values)),
	attachmentGates: v.optional(literalUnion(ROUTING_SWITCHES.attachmentGates.values)),
	categoryDisplayBundle: v.optional(literalUnion(ROUTING_SWITCHES.categoryDisplayBundle.values)),
	dispositionAdvisoryBundle: v.optional(
		literalUnion(ROUTING_SWITCHES.dispositionAdvisoryBundle.values)
	),
	triageBundle: v.optional(literalUnion(ROUTING_SWITCHES.triageBundle.values)),
	claimVerification: v.optional(literalUnion(ROUTING_SWITCHES.claimVerification.values)),
	clarifyNecessity: v.optional(literalUnion(ROUTING_SWITCHES.clarifyNecessity.values)),
	cheapFirstWriter: v.optional(literalUnion(ROUTING_SWITCHES.cheapFirstWriter.values)),
	batchApi: v.optional(literalUnion(ROUTING_SWITCHES.batchApi.values)),
} satisfies { [K in keyof typeof ROUTING_SWITCHES]: unknown };

// ── Admission ─────────────────────────────────────────────────────────────

/**
 * Which ceiling slice a reservation or a ledger row draws on. `triage`: paid
 * guard and classify calls, which may use the triage allowance. `shadow`:
 * shadow traffic, bounded by the shadow allowance. `standard`: the rest.
 * Absent on a ledger row ⇒ `standard`.
 */
export const BUDGET_CLASSES = ['standard', 'triage', 'shadow'] as const;
export type BudgetClass = (typeof BUDGET_CLASSES)[number];
export const budgetClassValidator = literalUnion(BUDGET_CLASSES);

/** Who waits on an admitted call. Background work defers at the ceiling. */
export const ADMISSION_PRIORITIES = ['interactive', 'pipeline', 'background'] as const;
export type AdmissionPriority = (typeof ADMISSION_PRIORITIES)[number];
export const admissionPriorityValidator = literalUnion(ADMISSION_PRIORITIES);

/**
 * A reservation's state. Only `held` rows count against headroom; the three
 * terminal states stay briefly so a repeated settle or release is idempotent,
 * then age out. A reservation is never summed as spend: settled spend is the
 * ledger's.
 */
export const RESERVATION_STATUSES = ['held', 'settled', 'released', 'expired'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
export const reservationStatusValidator = literalUnion(RESERVATION_STATUSES);

/** A spend period: a UTC day (`2026-10-12`) or a UTC month (`2026-10`). */
export const SPEND_PERIOD_KINDS = ['day', 'month'] as const;
export type SpendPeriodKind = (typeof SPEND_PERIOD_KINDS)[number];
export const spendPeriodKindValidator = literalUnion(SPEND_PERIOD_KINDS);

/**
 * The aggregate's completeness. Admission refuses paid dispatch unless it is
 * `complete` (1b: "refuse paid dispatch while the totals are incomplete").
 */
export const SPEND_AGGREGATE_STATUSES = ['unreconciled', 'rebuilding', 'complete'] as const;
export type SpendAggregateStatus = (typeof SPEND_AGGREGATE_STATUSES)[number];
export const spendAggregateStatusValidator = literalUnion(SPEND_AGGREGATE_STATUSES);

/** A ledger row's quality outcome (Phase 4). Absent ⇒ not assessed. */
export const QUALITY_RESULTS = ['passed', 'failed', 'escalated', 'abstained'] as const;
export type QualityResult = (typeof QUALITY_RESULTS)[number];
export const qualityResultValidator = literalUnion(QUALITY_RESULTS);

// ── Team message markers ──────────────────────────────────────────────────

/**
 * The model guard did not run on this message. Stored on
 * `inboundMessages.securityFlags.guardNotRun`. The deterministic layers did run;
 * the semantic verdict is missing, so the guard is required before any later
 * autonomous processing (`lib/aiRouting/guardRecord.ts`).
 */
export const guardNotRunValidator = v.object({
	reason: literalUnion(GUARD_NOT_RUN_REASONS),
	at: v.number(),
});

/**
 * The ceiling (or an unverifiable spend state) stopped the model path and
 * the message waits for a person. Stored on `inboundMessages.budgetHold`; its
 * presence blocks auto-send. `missingJudgments` names what the model did not
 * judge, so the reviewer and the UI can say so.
 */
export const budgetHoldValidator = v.object({
	reason: literalUnion(BUDGET_HOLD_REASONS),
	missingJudgments: v.array(literalUnion(MISSING_JUDGMENTS)),
	at: v.number(),
});
export type BudgetHold = Infer<typeof budgetHoldValidator>;

/**
 * A spend refusal an interpretation run met (the gate, its hold, a model
 * call, a verifier batch or a claim check), stored on the run's
 * `messageInterpretations` row so a replay reports it like the run did.
 */
export const runBudgetRefusalValidator = v.object({
	reason: literalUnion(BUDGET_HOLD_REASONS),
	limit: v.string(),
});

/**
 * The spend ceiling on a user-facing AI result (an assistant answer, a visualization): the
 * paid call was refused for budget. The stable code and reason, never the
 * English sentence, so the web can say it in the reader's language.
 */
export const budgetRefusalValidator = v.object({
	code: v.literal(AI_BUDGET_ERROR_CODE),
	reason: literalUnion(BUDGET_HOLD_REASONS),
});
export type BudgetRefusal = Infer<typeof budgetRefusalValidator>;

// ── Provider batch items (L14) ────────────────────────────────────────────

/**
 * The non-interactive model calls that may go through a provider batch API:
 * knowledge extraction from a Team message, a file or a
 * Postbox message, and a file's (an attachment's) summary.
 */
export const BATCH_CONSUMERS = [
	'knowledge_message',
	'knowledge_file',
	'knowledge_mail',
	'file_summary',
] as const;
export type BatchConsumer = (typeof BATCH_CONSUMERS)[number];
export const batchConsumerValidator = literalUnion(BATCH_CONSUMERS);

/** The endpoints whose adapters have a batch API Owlat speaks: native OpenAI and Anthropic only. */
export const BATCH_PROVIDERS = ['openai-native', 'anthropic-native'] as const;
export type BatchProvider = (typeof BATCH_PROVIDERS)[number];
export const batchProviderValidator = literalUnion(BATCH_PROVIDERS);

/**
 * `submitting`: held and recorded, the provider has not confirmed it yet;
 * `submitted`: the provider accepted it and it is polled; `completed`: its
 * result was read and its ledger row written; `failed`: the provider ran it
 * and billed nothing (errored, expired, cancelled); `abandoned`: Owlat lost
 * track of it (an unconfirmed submission, or no result by its expiry), and
 * its hold is left for the expiry sweep to charge in full.
 */
export const BATCH_ITEM_STATUSES = [
	'submitting',
	'submitted',
	'completed',
	'failed',
	'abandoned',
] as const;
export type BatchItemStatus = (typeof BATCH_ITEM_STATUSES)[number];
export const batchItemStatusValidator = literalUnion(BATCH_ITEM_STATUSES);

/** What a terminal item's request came to. */
export const BATCH_ITEM_OUTCOMES = [
	'succeeded',
	'truncated',
	'invalid',
	'errored',
	'expired',
	'canceled',
	'lost',
] as const;
export type BatchItemOutcome = (typeof BATCH_ITEM_OUTCOMES)[number];
export const batchItemOutcomeValidator = literalUnion(BATCH_ITEM_OUTCOMES);

// ── Decision artifacts and sender memory ──────────────────────────────────

/** `advisory`: a verdict a surface may display or advise with. `shadow`: an observation only. */
export const DECISION_ARTIFACT_KINDS = ['advisory', 'shadow'] as const;
export const decisionArtifactKindValidator = literalUnion(DECISION_ARTIFACT_KINDS);

/**
 * `leased`: a worker holds the artifact key (`leaseExpiresAt`); `complete`: the
 * answers are stored; `abstained`: the provider declined or the answer was
 * ambiguous; `failed`: no answer. Only `complete` may be reused, and nothing
 * incomplete ever authorizes automation.
 */
export const DECISION_ARTIFACT_STATUSES = ['leased', 'complete', 'abstained', 'failed'] as const;
export const decisionArtifactStatusValidator = literalUnion(DECISION_ARTIFACT_STATUSES);

/** Which message a decision artifact or a sender-memory entry was read from. */
export const AI_SUBJECT_KINDS = ['inbound_message', 'mail_message'] as const;
export const aiSubjectKindValidator = literalUnion(AI_SUBJECT_KINDS);

/**
 * Who answered, for an artifact: the decision adapter, or the language plane
 * when the bundle ran there. `modelUsed` is the provider's reported id.
 */
export const decisionProvenanceValidator = v.object({
	provider: v.union(literalUnion(DECISION_PROVIDER_KINDS), v.literal('language')),
	modelUsed: v.optional(v.string()),
	endpoint: v.optional(literalUnion(DECISION_ENDPOINT_PROVENANCES)),
	/** The question set's catalog id (`lib/decision/catalog.ts`) or the prompt id. */
	questionSetId: v.string(),
	/** Bumped when the question set, prompt or answer mapping changes. */
	questionSetVersion: v.number(),
});

/**
 * The calibration stamp an artifact carries. `isAdapterCalibrated` is the
 * adapter's `calibrated` flag (only "TypeSafe served the pinned model").
 * `calibrationRevision` names the checked-in task/language report the answer's
 * thresholds come from; absent ⇒ uncalibrated for this task, and the block-only
 * gate refuses it as an auto-send input.
 */
export const calibrationStampValidator = v.object({
	isAdapterCalibrated: v.boolean(),
	calibrationRevision: v.optional(v.string()),
	language: v.optional(v.string()),
});

/** Why an artifact or a sender-memory entry stopped being reusable. */
export const AI_INVALIDATION_REASONS = [
	'owner_correction',
	'new_inbound',
	'policy_change',
	'model_change',
	'settings_change',
	'superseded',
	/** Mail from the remembered sender failed DMARC, so its memory no longer applies. */
	'auth_failure',
] as const;
export const aiInvalidationReasonValidator = literalUnion(AI_INVALIDATION_REASONS);

/** Where a sender-memory entry applies. `team_inbox` has no mailbox id. */
export const SENDER_MEMORY_SCOPES = ['team_inbox', 'mailbox'] as const;
export const senderMemoryScopeValidator = literalUnion(SENDER_MEMORY_SCOPES);

/** `exact`: an exact valid artifact; `template`: an evaluated message-template fingerprint. */
export const SENDER_MEMORY_MATCH_KINDS = ['exact', 'template'] as const;
export const senderMemoryMatchKindValidator = literalUnion(SENDER_MEMORY_MATCH_KINDS);

/** What authenticated the sender a memory entry is keyed by. Unauthenticated mail gets none. */
export const SENDER_AUTH_BASES = ['dmarc_pass', 'dkim_aligned', 'arc_trusted'] as const;
export const senderAuthBasisValidator = literalUnion(SENDER_AUTH_BASES);

// ── Deferred interpretation ───────────────────────────────────────────────

/** Why a source waits for its thread to be opened. */
export const interpretDeferReasonValidator = literalUnion(INTERPRET_DEFER_REASONS);
