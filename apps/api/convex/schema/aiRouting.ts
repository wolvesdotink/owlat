import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { llmUsagePlaneValidator } from '../lib/llmUsageTags';
import { entryTypeValidator } from './knowledge';
import {
	admissionPriorityValidator,
	aiInvalidationReasonValidator,
	aiSubjectKindValidator,
	aiTaskNameValidator,
	budgetClassValidator,
	calibrationStampValidator,
	decisionArtifactKindValidator,
	decisionArtifactStatusValidator,
	decisionProvenanceValidator,
	reservationStatusValidator,
	routingSwitchFields,
	senderAuthBasisValidator,
	senderMemoryMatchKindValidator,
	senderMemoryScopeValidator,
	spendAggregateStatusValidator,
	spendPeriodKindValidator,
} from '../lib/validators/aiRouting';

/**
 * AI routing tables (ADR-0073): the routing policy, admission's spend aggregate
 * and reservations, decision artifacts and sender memory. The embedding-space
 * tables are in `schema/embeddingSpaces.ts`; the ledger stays `llmUsageEvents`
 * (`schema/inbox.ts`), the single source of settled spend.
 *
 * Erasure: decision artifacts go with their message (contact erasure for a
 * Team message, member erasure for a mailbox's mail); sender memory goes with
 * its mailbox or its Team contact. Both carry `expiresAt` and the daily
 * retention sweep deletes them past it (`maintenance/retention.ts`).
 */

/**
 * Every table ADR-0073 adds (here and in `schema/embeddingSpaces.ts`), children
 * before parents. The tenant registry and the workspace deletion spread it.
 */
/** One extracted knowledge entry, as the extraction model returns it (`knowledge/extractedEntries.ts`). */
export const extractedEntryValidator = v.object({
	type: entryTypeValidator,
	title: v.string(),
	content: v.string(),
	confidence: v.number(),
	tags: v.optional(v.array(v.string())),
});

export const AI_ROUTING_TABLES = [
	'decisionArtifacts',
	'senderMemory',
	'llmReservations',
	'llmSpendPeriods',
	'llmSpendAggregateState',
	'shadowQuotaEntries',
	'shadowQuotaDays',
	'knowledgeExtractionProgress',
	'aiRoutingPolicy',
	'embeddingReembedJobs',
	'embeddingAttestations',
	'embeddingCoverage',
	'embeddingSpaces',
] as const;

export type AiRoutingTable = (typeof AI_ROUTING_TABLES)[number];

/** The routing policy's columns, exported for the admin mutation's arguments. */
export const aiRoutingPolicyFields = {
	...routingSwitchFields,
	/** L7: knowledge entries embedded per message. Absent ⇒ no cap (today). */
	knowledgeEntryCapPerMessage: v.optional(v.number()),
	/** Phase 3: verifiable claims per message. Absent ⇒ no cap (today). */
	verifyClaimCapPerMessage: v.optional(v.number()),
	/** L9: tasks whose prompts carry cache markers. Absent ⇒ none (today). */
	promptCacheTasks: v.optional(v.array(aiTaskNameValidator)),
	/** D1: share of each ceiling held back for paid guard and classify. Absent ⇒ 0.1. */
	triageAllowanceFraction: v.optional(v.number()),
	/** D4: share of eligible messages that may be shadowed, at most 0.1. Absent ⇒ 0.1. */
	shadowMaxMessageFraction: v.optional(v.number()),
	/** D4: share of the daily ceiling shadow traffic may spend, at most 0.05. Absent ⇒ 0.05. */
	shadowMaxCeilingFraction: v.optional(v.number()),
	/** D4: finite USD cap on shadow spend; required to shadow without a daily ceiling. */
	shadowCapUsd: v.optional(v.number()),
	/** Bumped by every save; artifacts and ledger rows record the version they ran under. */
	policyVersion: v.number(),
	updatedAt: v.number(),
	/** The admin who saved it (auth user id). */
	updatedBy: v.string(),
};

export const aiRoutingTables = {
	// SINGLETON (at most one row). Absent ⇒ every default, which is today's
	// behaviour. Read through `aiRouting/policy.ts` and `resolveRoutingPolicy`.
	aiRoutingPolicy: defineTable(aiRoutingPolicyFields),

	// AGGREGATED — settled spend per UTC day and month, per plane and budget
	// class, derived ONLY from `llmUsageEvents`: every ledger insert adds its
	// row's micro-USD here in the same mutation (lib/aiRouting/spendPeriods.ts),
	// and a rebuild recomputes every bucket from the ledger. Never holds
	// reservations. `generation` is the rebuild that last reset the bucket.
	llmSpendPeriods: defineTable({
		periodKind: spendPeriodKindValidator,
		/** `YYYY-MM-DD` for a day, `YYYY-MM` for a month (UTC). */
		periodKey: v.string(),
		plane: llmUsagePlaneValidator,
		budgetClass: budgetClassValidator,
		settledMicrousd: v.number(),
		/** The part of `settledMicrousd` that ledger rows marked `isEstimated`. */
		estimatedMicrousd: v.number(),
		eventCount: v.number(),
		generation: v.number(),
		updatedAt: v.number(),
	}).index('by_period', ['periodKind', 'periodKey', 'plane', 'budgetClass']),

	// SINGLETON — whether `llmSpendPeriods` is complete. Absent ⇒ `unreconciled`.
	// Admission refuses paid dispatch until a rebuild has reconciled the ledger's
	// history and set `complete`. A rebuild bumps `generation`, counts ledger
	// rows created before `rebuildCutoff` page by page (`cursor`), while live
	// writers keep adding rows created after it.
	llmSpendAggregateState: defineTable({
		status: spendAggregateStatusValidator,
		generation: v.number(),
		rebuildCutoff: v.optional(v.number()),
		cursor: v.optional(v.string()),
		scannedCount: v.number(),
		startedAt: v.optional(v.number()),
		completedAt: v.optional(v.number()),
		lastError: v.optional(v.string()),
		updatedAt: v.number(),
	}),

	// Admission holds (1b). One row per admitted call, keyed by the caller's
	// idempotent `reservationId`. Only `held` rows count against headroom, and a
	// reservation is never summed as spend: settlement writes the ledger row
	// (reported usage, or a conservative estimate marked `isEstimated`) and then
	// marks the hold `settled`. `released`: the call never reached a provider.
	// `expired`: the sweep settled a hold whose action died. Terminal rows age
	// out with the audit window.
	llmReservations: defineTable({
		reservationId: v.string(),
		rootRequestId: v.string(),
		parentCallId: v.optional(v.string()),
		plane: llmUsagePlaneValidator,
		task: aiTaskNameValidator,
		budgetClass: budgetClassValidator,
		priority: admissionPriorityValidator,
		/** Integer micro-USD held: the whole allowed path (every attempt, any escalation). */
		heldMicrousd: v.number(),
		/** Integer micro-USD the ledger rows of this reservation settled at. */
		settledMicrousd: v.optional(v.number()),
		status: reservationStatusValidator,
		modelId: v.optional(v.string()),
		endpoint: v.optional(v.string()),
		maxAttempts: v.number(),
		/**
		 * Each request's own bound, keyed by the meter's request id and attempt
		 * (admission lane): a request whose usage is unknown is charged at its
		 * own bound. An entry without a key bounds any request of the hold.
		 */
		requestBounds: v.optional(
			v.array(
				v.object({
					requestId: v.optional(v.string()),
					attempt: v.optional(v.number()),
					microusd: v.number(),
				})
			)
		),
		/**
		 * The part of a settlement estimate not yet offset by a request row that
		 * arrived after the hold closed (admission lane). Such a row is charged
		 * against it first, so the final charge is max(estimate, reported).
		 */
		estimateRemainingMicrousd: v.optional(v.number()),
		policyVersion: v.number(),
		expiresAt: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_reservation_id', ['reservationId'])
		.index('by_root_request_id', ['rootRequestId'])
		// Outstanding holds per plane and class: admission sums these.
		.index('by_status_and_plane', ['status', 'plane', 'budgetClass'])
		// The expiry sweep: held rows past `expiresAt`.
		.index('by_status_and_expires_at', ['status', 'expiresAt'])
		// Retention: terminal rows past the audit window.
		.index('by_status_and_updated_at', ['status', 'updatedAt']),

	// D4's message share, counted (admission lane). One row per (task, UTC day):
	// how many eligible messages asked to be shadowed and how many were. A
	// message is admitted only while admitted + 1 ≤ floor(share × eligible).
	shadowQuotaDays: defineTable({
		task: aiTaskNameValidator,
		/** `YYYY-MM-DD` (UTC). */
		dayKey: v.string(),
		eligibleCount: v.number(),
		admittedCount: v.number(),
		updatedAt: v.number(),
	})
		.index('by_task_and_day', ['task', 'dayKey'])
		.index('by_updated_at', ['updatedAt']),

	// Each message's answer for a (task, day), so asking again is idempotent
	// and counted once. `subjectKey` is an opaque message id; rows age out with
	// the retention sweep after a week.
	shadowQuotaEntries: defineTable({
		task: aiTaskNameValidator,
		dayKey: v.string(),
		subjectKey: v.string(),
		isAdmitted: v.boolean(),
		createdAt: v.number(),
	})
		.index('by_task_and_subject', ['task', 'subjectKey', 'dayKey'])
		.index('by_created_at', ['createdAt']),

	// A knowledge extraction that stopped part-way (a spend-admission refusal
	// between entries, or a crash) is `in_progress` until a run saves every
	// entry and hands them to the structural linker, then `complete` (admission
	// lane). Ids only, no content; rows age out with the retention sweep.
	knowledgeExtractionProgress: defineTable({
		sourceType: v.union(v.literal('agent_extracted'), v.literal('file'), v.literal('email')),
		sourceId: v.string(),
		status: v.union(v.literal('in_progress'), v.literal('complete')),
		/** While `in_progress`: the entries the model returned, so a resumed run saves them without asking again. */
		entries: v.optional(v.array(extractedEntryValidator)),
		updatedAt: v.number(),
	})
		.index('by_source', ['sourceType', 'sourceId'])
		// Retention ages out `complete` markers only (Sol r3 F2).
		.index('by_status_and_updated_at', ['status', 'updatedAt']),

	// Decision artifacts (Phase 2, D9, D11): a bundle's typed answers for one
	// message, keyed by task, message, content hash and policy version
	// (`artifactKey`), with the provenance and calibration stamp the block-only
	// gate reads. `advisory` verdicts may feed displays and advice; `shadow`
	// observations only record what the bundle said beside today's source
	// (`baseline`). No artifact drives a destructive action (D9), and only a
	// `complete`, uninvalidated one is reusable. `answers` and `baseline` are
	// JSON of LABELS (enum values, scores, probabilities), never message text.
	decisionArtifacts: defineTable({
		artifactKey: v.string(),
		task: aiTaskNameValidator,
		kind: decisionArtifactKindValidator,
		status: decisionArtifactStatusValidator,
		subjectKind: aiSubjectKindValidator,
		inboundMessageId: v.optional(v.id('inboundMessages')),
		mailMessageId: v.optional(v.id('mailMessages')),
		/** Set for every Postbox subject, so the mailbox's erasure finds it. */
		mailboxId: v.optional(v.id('mailboxes')),
		/** Hash of the bounded evidence the bundle was asked about (message and segment). */
		contentHash: v.string(),
		policyVersion: v.number(),
		/** Settings, knowledge and permission versions the evidence was built under. */
		contextVersion: v.optional(v.string()),
		provenance: v.optional(decisionProvenanceValidator),
		calibration: v.optional(calibrationStampValidator),
		answers: v.optional(v.string()),
		answersVersion: v.optional(v.number()),
		baseline: v.optional(v.string()),
		baselineVersion: v.optional(v.number()),
		/** Shadow: whether the bundle agreed with the baseline on every compared field. */
		isAgreement: v.optional(v.boolean()),
		rootRequestId: v.optional(v.string()),
		/** A `leased` row's lease; a worker may take the key over once it passes. */
		leaseExpiresAt: v.optional(v.number()),
		invalidatedAt: v.optional(v.number()),
		invalidationReason: v.optional(aiInvalidationReasonValidator),
		expiresAt: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_artifact_key', ['artifactKey'])
		.index('by_inbound_message', ['inboundMessageId', 'task'])
		.index('by_mail_message', ['mailMessageId', 'task'])
		.index('by_mailbox', ['mailboxId'])
		// Shadow agreement and calibration reports, per task, over time.
		.index('by_task_and_kind', ['task', 'kind', 'createdAt'])
		.index('by_expires_at', ['expiresAt']),

	// Sender memory (D12): a remembered outcome for an AUTHENTICATED sender in
	// one scope (a mailbox, or the Team Inbox), reusable only for an exact valid
	// artifact (`matchKind: exact`, `matchKey` = content hash) or an evaluated
	// template fingerprint (`template`, `matchKey` = fingerprint at
	// `fingerprintVersion`), under the same thread state, policy and model.
	// Advisory only: it changes no routing. An owner correction invalidates the
	// sender's entries for the task; every entry expires. The sender is stored
	// as a digest of the normalized address, never the address.
	senderMemory: defineTable({
		scope: senderMemoryScopeValidator,
		mailboxId: v.optional(v.id('mailboxes')),
		/** Team scope: the sender's contact, so the contact's erasure deletes the entry. */
		contactId: v.optional(v.id('contacts')),
		/** SHA-256 hex of the lowercased authenticated sender address. */
		senderDigest: v.string(),
		authBasis: senderAuthBasisValidator,
		task: aiTaskNameValidator,
		matchKind: senderMemoryMatchKindValidator,
		matchKey: v.string(),
		fingerprintVersion: v.optional(v.number()),
		threadStateKey: v.optional(v.string()),
		policyVersion: v.number(),
		/** `<provider>/<model>` that produced the remembered outcome. */
		modelIdentity: v.string(),
		/** JSON of the remembered labels; never message text. */
		outcome: v.string(),
		outcomeVersion: v.number(),
		/** The artifact the entry was learned from (`decisionArtifacts.artifactKey`). */
		sourceArtifactKey: v.optional(v.string()),
		hitCount: v.number(),
		lastHitAt: v.optional(v.number()),
		invalidatedAt: v.optional(v.number()),
		invalidationReason: v.optional(aiInvalidationReasonValidator),
		expiresAt: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		// Lookup and owner-correction invalidation (any prefix of it); a mailbox's
		// erasure reads the `scope: 'mailbox', mailboxId` prefix.
		.index('by_lookup', ['scope', 'mailboxId', 'senderDigest', 'task', 'matchKind', 'matchKey'])
		.index('by_contact', ['contactId'])
		.index('by_expires_at', ['expiresAt']),
};
