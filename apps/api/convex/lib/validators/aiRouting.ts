/**
 * Validators for the AI routing records (ADR-0073): the routing policy row, the
 * admission records, the guard and budget markers on Team messages, decision
 * artifacts and sender memory. The vocabularies come from
 * `@owlat/shared/aiRouting`, so the settings form and the stored shape cannot
 * drift apart. A leaf module: the schema loads it.
 */

import { v, type Infer } from 'convex/values';
import {
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
 * guard and classify calls, which may use the triage allowance (D1). `shadow`:
 * shadow traffic, bounded by the shadow allowance (D4). `standard`: the rest.
 * Absent on a ledger row ⇒ `standard`.
 */
export const BUDGET_CLASSES = ['standard', 'triage', 'shadow'] as const;
export type BudgetClass = (typeof BUDGET_CLASSES)[number];
export const budgetClassValidator = literalUnion(BUDGET_CLASSES);

/** Who waits on an admitted call. Background work defers at the ceiling (D1). */
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
 * D13: the model guard did not run on this message. Stored on
 * `inboundMessages.securityFlags.guardNotRun`. The deterministic layers did run;
 * the semantic verdict is missing, so the guard is required before any later
 * autonomous processing (`lib/aiRouting/guardRecord.ts`).
 */
export const guardNotRunValidator = v.object({
	reason: literalUnion(GUARD_NOT_RUN_REASONS),
	at: v.number(),
});

/**
 * D1: the ceiling (or an unverifiable spend state) stopped the model path and
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
	/** D12: mail from the remembered sender failed DMARC, so its memory no longer applies. */
	'auth_failure',
] as const;
export const aiInvalidationReasonValidator = literalUnion(AI_INVALIDATION_REASONS);

/** Where a sender-memory entry applies (D12). `team_inbox` has no mailbox id. */
export const SENDER_MEMORY_SCOPES = ['team_inbox', 'mailbox'] as const;
export const senderMemoryScopeValidator = literalUnion(SENDER_MEMORY_SCOPES);

/** `exact`: an exact valid artifact; `template`: an evaluated message-template fingerprint. */
export const SENDER_MEMORY_MATCH_KINDS = ['exact', 'template'] as const;
export const senderMemoryMatchKindValidator = literalUnion(SENDER_MEMORY_MATCH_KINDS);

/** What authenticated the sender a memory entry is keyed by. Unauthenticated mail gets none. */
export const SENDER_AUTH_BASES = ['dmarc_pass', 'dkim_aligned', 'arc_trusted'] as const;
export const senderAuthBasisValidator = literalUnion(SENDER_AUTH_BASES);

// ── Deferred interpretation ───────────────────────────────────────────────

/** D10: why a source waits for its thread to be opened. */
export const interpretDeferReasonValidator = literalUnion(INTERPRET_DEFER_REASONS);
