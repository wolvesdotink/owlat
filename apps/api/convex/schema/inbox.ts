import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	securityFlagsValidator,
	classificationValidator,
	contextCoverageValidator,
	draftQualityValidator,
	groundingSourceValidator,
	agentDecisionValidator,
	tokenUsageValidator,
} from '../lib/convexValidators';
import { pendingClarificationValidator } from '../inbox/clarificationValidators';
import { attachmentSuggestionsValidator } from '../inbox/attachmentValidators';

/**
 * Inbox / Agent pipeline tables — AI-assisted shared inbox.
 *
 * conversationThreads + inboundMessages drive the shared inbox; agentActions
 * tracks per-step pipeline execution; knowledgeBackfillJobs gates the initial
 * history scan; agentMetrics + llmUsageEvents cover monitoring/spend;
 * coalesceBatches debounces bursts.
 *
 * The autonomy / graduated-trust tables (agentConfig, agentCircuitBreakers,
 * autonomyRules, autonomyFeedback, autonomySuggestions, agentShadowDecisions,
 * agentShadowScorecard) live in schema/autonomy.ts (split per CONVENTIONS
 * "split only above ~500 LOC").
 *
 * Spread into `defineSchema()` from schema.ts via `...inboxTables`.
 */
export const inboxTables = {
	// Conversation Threads - groups related inbound/outbound messages into conversations
	conversationThreads: defineTable({
		subject: v.string(),
		// Normalized subject for matching (stripped of Re:/Fwd: prefixes, lowercased)
		normalizedSubject: v.string(),
		// Linked contact
		contactId: v.optional(v.id('contacts')),
		// Channel-neutral thread-list display identifier: an email for
		// email/generic channels, a raw phone/handle for SMS/WhatsApp/chat.
		// (Renamed from `contactEmail` in ADR-0032 — the misnomer the
		// channel work had already broken.)
		contactIdentifier: v.string(),
		// Thread status
		status: v.union(
			v.literal('open'), // Active conversation
			v.literal('waiting'), // Waiting for customer reply
			v.literal('resolved'), // Marked as resolved
			v.literal('closed') // Archived/closed
		),
		// Assigned team member (BetterAuth user ID)
		assignedTo: v.optional(v.string()),
		// Thread metadata
		messageCount: v.number(),
		lastMessageAt: v.number(),
		firstMessageAt: v.number(),
		// Latest draft status for quick queue filtering
		latestDraftStatus: v.optional(
			v.union(v.literal('pending'), v.literal('approved'), v.literal('rejected'), v.literal('sent'))
		),
		// Team snooze — hide the thread from the Open filter until this timestamp,
		// then the wake cron (inbox/snooze.ts → internalSweep) clears it and marks
		// it returned. Mirrors the Postbox mail snooze shape (mail/snooze.ts).
		// Absent = not snoozed. `snooze()` rejects any `until <= now`, so a real
		// value is always a future ms-epoch.
		snoozedUntil: v.optional(v.number()),
		// Set by the wake cron when a snooze lapses (or by an inbound reply that
		// clears an active snooze). Drives the transient "returned" marker on the
		// thread row so a resurfaced thread is visibly distinct from a never-snoozed
		// one. Never gates any query; purely a read-side hint.
		snoozeReturnedAt: v.optional(v.number()),
		createdAt: v.number(),
	})
		.index('by_contact_identifier', ['contactIdentifier'])
		.index('by_status', ['status'])
		.index('by_last_message_at', ['lastMessageAt'])
		.index('by_contact', ['contactId'])
		.index('by_assigned_to', ['assignedTo'])
		.index('by_snoozed_until', ['snoozedUntil'])
		.index('by_normalized_subject_and_contact', ['normalizedSubject', 'contactIdentifier']),

	// Inbound Messages - stores every inbound email with its processing state
	inboundMessages: defineTable({
		// SMTP envelope data
		messageId: v.string(), // SMTP Message-ID header
		from: v.string(), // Sender email address
		to: v.string(), // Recipient email address
		subject: v.string(),
		// Message content
		textBody: v.optional(v.string()),
		htmlBody: v.optional(v.string()),
		// Threading headers (RFC 5322)
		inReplyTo: v.optional(v.string()),
		references: v.optional(v.string()),
		// Raw headers (JSON string for audit)
		headers: v.optional(v.string()),
		// Attachment metadata (JSON array: [{filename, contentType, size}], content stored separately)
		attachmentMeta: v.optional(v.string()),
		// Relationships
		threadId: v.optional(v.id('conversationThreads')),
		contactId: v.optional(v.id('contacts')),
		// Processing state machine
		processingStatus: v.union(
			v.literal('received'), // Just stored, awaiting security scan
			v.literal('security_check'), // Security filter running
			v.literal('quarantined'), // Flagged by security filter
			v.literal('classifying'), // Agent classification in progress
			v.literal('drafting'), // Agent draft generation in progress
			v.literal('draft_ready'), // Draft ready for human review
			v.literal('awaiting_clarification'), // Parked awaiting an owner answer before drafting
			v.literal('approved'), // Draft approved by human or auto-approved
			v.literal('sent'), // Reply sent
			v.literal('rejected'), // Draft rejected by human
			v.literal('archived'), // Archived without reply (spam, etc.)
			v.literal('failed') // Pipeline error
		),
		// Security filter results
		securityFlags: v.optional(securityFlagsValidator),
		// Agent classification result
		classification: v.optional(classificationValidator),
		// Agent-generated draft
		draftResponse: v.optional(v.string()),
		draftSubject: v.optional(v.string()),
		// Optional alternative drafts offered at the review gate (concise /
		// hedged / detailed). Present ONLY on lower-confidence / low-quality
		// cases, where the `draft` step spends one extra generation to give the
		// reviewer 2–3 pickable variants. `draftOptions[0]` is always the
		// self-checked primary draft (== `draftResponse`); the rest are
		// alternatives. Absent on the normal single-draft path and whenever the
		// options generation fails (fail-soft to the single draft).
		draftOptions: v.optional(v.array(v.string())),
		// Advisory attachment suggestion the `draft` step computed when the inbound
		// asks for a document ("can you send X" / "see attached") and a
		// contact-scoped semanticFiles match exists. Rendered as a one-tap
		// "attach <file>?" chip in the review gate + composer. NEVER consumed by the
		// autonomous send path — human-confirmed only. Absent when nothing matched.
		attachmentSuggestions: v.optional(attachmentSuggestionsValidator),
		// Overall confidence score for routing decisions — the CLASSIFIER's
		// certainty about category/sentiment. NOT a measure of draft correctness.
		confidenceScore: v.optional(v.number()),
		// Draft-quality self-check — a cheap-tier critique of the DRAFT itself
		// (complete / grounded / on-tone), scored 0..1. Persisted SEPARATELY from
		// confidenceScore; the route step gates auto-send on this, not on the
		// classifier confidence. Absent when the self-check failed.
		draftQuality: v.optional(draftQualityValidator),
		// Context compaction tier used (for transparency in review queue)
		contextTier: v.optional(
			v.union(v.literal('normal'), v.literal('compacted'), v.literal('emergency'))
		),
		// Retrieval coverage / grounding signal from context_retrieval —
		// advisory only (see contextCoverageValidator).
		contextCoverage: v.optional(contextCoverageValidator),
		// The prior emails + knowledge entries that context_retrieval actually
		// assembled into the draft's briefing (the same contact-scoped set the
		// draft was grounded in). Read-side provenance for the review UI's
		// "Grounded in:" list — drives no routing. See groundingSourceValidator.
		groundingSources: v.optional(v.array(groundingSourceValidator)),
		// The router's auto-approve / human-review outcome + the exact reason it
		// computed + the classifier confidence at decision time. Read-side mirror
		// of the routing decision so the review UI can explain WHY. See
		// agentDecisionValidator.
		agentDecision: v.optional(agentDecisionValidator),
		// Human reviewer assignment
		assignedTo: v.optional(v.string()),
		// Cancellable pending-send marker for a delayed AUTONOMOUS auto-send.
		// Set when an auto-approved message schedules its send after the
		// configurable undo window (agentConfig.autoSendDelayMs) instead of
		// firing immediately. `scheduledFnId` is the handle the cancel path
		// (`cancelAutoSend`) passes to `ctx.scheduler.cancel` to abort an
		// in-flight delayed send; `sendAt` powers the UI countdown
		// ("Sending in 0:59 — Undo"). Cleared on any transition out of
		// `approved`. Absent for human-reviewed approvals and for delay=0
		// (legacy immediate send).
		pendingAutoSend: v.optional(
			v.object({
				scheduledFnId: v.id('_scheduled_functions'),
				sendAt: v.number(),
				scheduledAt: v.number(),
			})
		),
		// Open clarification questions parked before drafting. Set when the
		// clarify step routes the message to `awaiting_clarification`;
		// answered via `inbox.answerClarification`, which folds each answer back in
		// as a TRUSTED `[CONFIRMED BY OWNER]` block and resumes the draft. See
		// pendingClarificationValidator.
		pendingClarification: v.optional(pendingClarificationValidator),
		// Set when a draft was produced from an ABANDONED clarification (the owner
		// never answered within the window and the fallback cron resumed a
		// best-guess). It is a hard, fail-closed block on autonomous sending — the
		// route step's final safety gate refuses to auto-send while this is set, so
		// a best-guess reply always goes to human review. Never cleared by the
		// pipeline; a human reviews and sends (or discards) the draft.
		isAutoSendBlocked: v.optional(v.boolean()),
		// Set once a human edits the agent draft on the review queue (editDraft).
		// Used to tell an UNEDITED owner-send of an answered-clarification draft
		// (a strong positive autonomy outcome) apart from an edited-then-sent one.
		isDraftEdited: v.optional(v.boolean()),
		// Error tracking
		errorMessage: v.optional(v.string()),
		// Timestamps
		receivedAt: v.number(),
		processedAt: v.optional(v.number()),
	})
		.index('by_message_id', ['messageId'])
		.index('by_thread', ['threadId'])
		.index('by_processing_status', ['processingStatus'])
		.index('by_received_at', ['receivedAt'])
		.index('by_contact', ['contactId'])
		.index('by_assigned_to_and_status', ['assignedTo', 'processingStatus']),

	// Agent Actions - tracks individual pipeline step executions
	agentActions: defineTable({
		inboundMessageId: v.id('inboundMessages'),
		// Which pipeline step this action represents — matches the
		// AgentStepKind union in convex/agent/steps/types.ts. The
		// `plan` kind was dropped pre-prod with ADR-0014.
		actionType: v.union(
			v.literal('security_scan'),
			v.literal('context_retrieval'),
			v.literal('classify'),
			v.literal('clarify'),
			v.literal('draft'),
			v.literal('route')
		),
		// Execution status. `failed` is a RETRYABLE terminal-of-attempt state
		// the retry cron (processingLifecycle.retryFailedActions) picks back up;
		// `abandoned` is the TRUE terminal state, set once retries are exhausted
		// (retryCount >= MAX_RETRY_ATTEMPTS) so the by_status='failed' scan only
		// ever holds still-retryable rows and can't be starved by a growing head
		// of lifetime-exhausted failures.
		status: v.union(
			v.literal('pending'),
			v.literal('running'),
			v.literal('completed'),
			v.literal('failed'),
			v.literal('abandoned'),
			v.literal('skipped')
		),
		// Step input/output (JSON strings for flexibility)
		input: v.optional(v.string()),
		output: v.optional(v.string()),
		// Error tracking
		errorMessage: v.optional(v.string()),
		retryCount: v.number(),
		// Performance tracking
		startedAt: v.optional(v.number()),
		completedAt: v.optional(v.number()),
		durationMs: v.optional(v.number()),
		// LLM usage tracking
		modelUsed: v.optional(v.string()),
		tokenUsage: v.optional(tokenUsageValidator),
		createdAt: v.number(),
	})
		.index('by_inbound_message', ['inboundMessageId'])
		.index('by_status', ['status'])
		.index('by_inbound_message_and_type', ['inboundMessageId', 'actionType']),

	// Knowledge Backfill Jobs - tracks one-time bulk extraction of historical
	// inbound mail into the knowledge graph. Created when the agent master
	// toggle flips false→true and no prior job exists.
	knowledgeBackfillJobs: defineTable({
		status: v.union(
			v.literal('pending'),
			v.literal('running'),
			v.literal('completed'),
			v.literal('cancelled'),
			v.literal('failed')
		),
		triggeredBy: v.string(), // identity.subject
		totalCount: v.number(),
		scannedCount: v.number(),
		extractedCount: v.number(),
		skippedCount: v.number(),
		errorCount: v.number(),
		// Resumable cursor (compound: receivedAt then _id for stable ordering)
		cursorReceivedAt: v.optional(v.number()),
		cursorId: v.optional(v.id('inboundMessages')),
		startedAt: v.number(),
		updatedAt: v.number(),
		finishedAt: v.optional(v.number()),
		errorMessage: v.optional(v.string()),
	})
		.index('by_status', ['status'])
		.index('by_started_at', ['startedAt']),

	// Agent Metrics - rolling window metrics for monitoring
	agentMetrics: defineTable({
		metricType: v.union(
			v.literal('queue_depth'),
			v.literal('processing_latency'),
			v.literal('classification_accuracy'),
			v.literal('auto_approve_ratio'),
			v.literal('rejection_rate'),
			v.literal('llm_cost'),
			v.literal('error_rate')
		),
		value: v.number(),
		windowStart: v.number(),
		windowEnd: v.number(),
		createdAt: v.number(),
	})
		.index('by_metric_type', ['metricType'])
		.index('by_window_start', ['windowStart'])
		// Dashboard reads select one metricType over a recent window; the
		// compound index bounds the scan to that type's window instead of
		// filtering windowStart in memory after an equality-only index seek.
		.index('by_metric_type_and_window_start', ['metricType', 'windowStart']),

	// Per-call LLM usage + estimated cost for EVERY feature, not just the inbound
	// agent (which also records to agentActions). Gives a deployment-wide AI-spend
	// view, the data foundation for budget alerts. Windowed reads via the system
	// by_creation_time index; retention prunes the tail.
	llmUsageEvents: defineTable({
		feature: v.string(),
		modelUsed: v.optional(v.string()),
		promptTokens: v.number(),
		completionTokens: v.number(),
		totalTokens: v.number(),
		costUsd: v.number(),
		createdAt: v.number(),
	}).index('by_feature', ['feature']),

	// Thread Presence - ephemeral "who is here" rows for the shared-inbox thread
	// view. One row per (thread, user); `mode` is `viewing` while the thread is
	// open and `replying` while a reply/review editor is focused. `heartbeatAt`
	// is refreshed every ~20s by the client (inbox/presence.ts → heartbeat); a
	// row is considered ACTIVE only while `heartbeatAt` is within
	// PRESENCE_ACTIVE_WINDOW_MS (60s), and the `sweep expired presence` cron
	// deletes rows past that window. Purely a read-side collaboration hint — it
	// never gates a mutation and never records an audit-log entry.
	threadPresence: defineTable({
		threadId: v.id('conversationThreads'),
		userId: v.string(), // BetterAuth user ID
		mode: v.union(v.literal('viewing'), v.literal('replying')),
		heartbeatAt: v.number(),
	})
		.index('by_thread', ['threadId'])
		.index('by_user', ['userId'])
		.index('by_heartbeat', ['heartbeatAt'])
		// One row per (user, thread) — point-read the caller's own presence on
		// heartbeat/leave via `.unique()` instead of scanning all their rows.
		.index('by_user_thread', ['userId', 'threadId'])
		// Range-scan a thread's ACTIVE rows (heartbeatAt within the window)
		// directly on the index — no in-memory window predicate.
		.index('by_thread_heartbeat', ['threadId', 'heartbeatAt']),

	// Coalesce Batches - one in-flight debounce window per thread. When rapid
	// messages arrive on the same thread, the pending batch's scheduled job is
	// cancelled and re-scheduled, so only the latest message triggers a single
	// agent-pipeline run (older ones are superseded). See agent/coalescing.ts.
	coalesceBatches: defineTable({
		threadId: v.id('conversationThreads'),
		jobId: v.id('_scheduled_functions'),
		leaderMessageId: v.id('inboundMessages'),
		createdAt: v.number(),
		// When the FIRST message of the current burst arrived. Carried forward
		// across debounce restarts (unlike `createdAt`, which is per row) so the
		// hard-cap flush is measured from the start of the burst. Optional for
		// rows written before the field existed; readers fall back to createdAt.
		firstReceivedAt: v.optional(v.number()),
	}).index('by_thread', ['threadId']),
};
