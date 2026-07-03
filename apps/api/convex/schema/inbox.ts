import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	securityFlagsValidator,
	classificationValidator,
	contextCoverageValidator,
	draftQualityValidator,
	tokenUsageValidator,
} from '../lib/convexValidators';

/**
 * Inbox / Agent pipeline tables — AI-assisted shared inbox.
 *
 * conversationThreads + inboundMessages drive the shared inbox; agentActions
 * tracks per-step pipeline execution; agentConfig is the singleton control
 * panel; knowledgeBackfillJobs gates the initial history scan; agentMetrics,
 * agentCircuitBreakers, autonomyRules, autonomyFeedback enforce safety on
 * graduated autonomy.
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
			v.literal('open'),        // Active conversation
			v.literal('waiting'),     // Waiting for customer reply
			v.literal('resolved'),    // Marked as resolved
			v.literal('closed')       // Archived/closed
		),
		// Assigned team member (BetterAuth user ID)
		assignedTo: v.optional(v.string()),
		// Thread metadata
		messageCount: v.number(),
		lastMessageAt: v.number(),
		firstMessageAt: v.number(),
		// Latest draft status for quick queue filtering
		latestDraftStatus: v.optional(
			v.union(
				v.literal('pending'),
				v.literal('approved'),
				v.literal('rejected'),
				v.literal('sent')
			)
		),
		createdAt: v.number(),
	})
		.index('by_contact_identifier', ['contactIdentifier'])
		.index('by_status', ['status'])
		.index('by_last_message_at', ['lastMessageAt'])
		.index('by_contact', ['contactId'])
		.index('by_assigned_to', ['assignedTo'])
		.index('by_normalized_subject_and_contact', ['normalizedSubject', 'contactIdentifier']),

	// Inbound Messages - stores every inbound email with its processing state
	inboundMessages: defineTable({
		// SMTP envelope data
		messageId: v.string(),       // SMTP Message-ID header
		from: v.string(),            // Sender email address
		to: v.string(),              // Recipient email address
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
			v.literal('received'),         // Just stored, awaiting security scan
			v.literal('security_check'),   // Security filter running
			v.literal('quarantined'),      // Flagged by security filter
			v.literal('classifying'),      // Agent classification in progress
			v.literal('drafting'),         // Agent draft generation in progress
			v.literal('draft_ready'),      // Draft ready for human review
			v.literal('approved'),         // Draft approved by human or auto-approved
			v.literal('sent'),             // Reply sent
			v.literal('rejected'),         // Draft rejected by human
			v.literal('archived'),         // Archived without reply (spam, etc.)
			v.literal('failed')            // Pipeline error
		),
		// Security filter results
		securityFlags: v.optional(securityFlagsValidator),
		// Agent classification result
		classification: v.optional(classificationValidator),
		// Agent-generated draft
		draftResponse: v.optional(v.string()),
		draftSubject: v.optional(v.string()),
		// Overall confidence score for routing decisions — the CLASSIFIER's
		// certainty about category/sentiment. NOT a measure of draft correctness.
		confidenceScore: v.optional(v.number()),
		// Draft-quality self-check — a cheap-tier critique of the DRAFT itself
		// (complete / grounded / on-tone), scored 0..1. Persisted SEPARATELY from
		// confidenceScore; the route step gates auto-send on this, not on the
		// classifier confidence. Absent when the self-check failed.
		draftQuality: v.optional(draftQualityValidator),
		// Context compaction tier used (for transparency in review queue)
		contextTier: v.optional(v.union(
			v.literal('normal'),
			v.literal('compacted'),
			v.literal('emergency')
		)),
		// Retrieval coverage / grounding signal from context_retrieval —
		// advisory only (see contextCoverageValidator).
		contextCoverage: v.optional(contextCoverageValidator),
		// Human reviewer assignment
		assignedTo: v.optional(v.string()),
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
			v.literal('draft'),
			v.literal('route')
		),
		// Execution status
		status: v.union(
			v.literal('pending'),
			v.literal('running'),
			v.literal('completed'),
			v.literal('failed'),
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

	// Agent Config - operational tuning for the agent pipeline (singleton).
	// The master on/off is the `ai.agent` feature flag — not a column here.
	agentConfig: defineTable({
		// Auto-reply settings
		isAutoReplyEnabled: v.boolean(),
		confidenceThreshold: v.number(), // 0-1, minimum confidence for auto-approval
		// Organization communication style
		toneDescription: v.optional(v.string()),
		signatureTemplate: v.optional(v.string()),
		// Rate limiting
		maxDailyAutoReplies: v.optional(v.number()),
		dailyAutoReplyCount: v.optional(v.number()),
		dailyAutoReplyResetAt: v.optional(v.number()),
		// Message coalescing debounce window. Opt-in: a positive value enables
		// burst coalescing (suggested 30000 = 30s); unset/0 processes each
		// message immediately. See agent/coalescing.ts.
		coalesceWindowMs: v.optional(v.number()),
		// Timestamps
		createdAt: v.number(),
		updatedAt: v.number(),
	}),

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
		triggeredBy: v.string(),                        // identity.subject
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
		.index('by_window_start', ['windowStart']),

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

	// Agent Circuit Breakers - automated safety mechanisms
	agentCircuitBreakers: defineTable({
		breakerType: v.union(
			v.literal('llm_failure'),
			v.literal('confidence_degradation'),
			v.literal('rejection_spike')
		),
		state: v.union(
			v.literal('closed'),       // Normal operation
			v.literal('open'),         // Tripped, blocking auto-responses
			v.literal('half_open')     // Testing recovery
		),
		threshold: v.number(),
		currentValue: v.number(),
		trippedAt: v.optional(v.number()),
		recoveredAt: v.optional(v.number()),
		createdAt: v.number(),
	})
		.index('by_breaker_type', ['breakerType']),

	// Autonomy Rules - per-category auto-approval configuration
	autonomyRules: defineTable({
		category: v.string(),             // "support", "sales", "billing", etc.
		autoApproveThreshold: v.number(), // Confidence threshold (0-1)
		maxDailyAutoActions: v.number(),  // Safety cap
		currentDailyCount: v.optional(v.number()),
		dailyCountResetAt: v.optional(v.number()),
		isEnabled: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_category', ['category']),

	// Autonomy Feedback - tracks human corrections for threshold adjustment
	autonomyFeedback: defineTable({
		ruleId: v.optional(v.id('autonomyRules')),
		category: v.string(),
		action: v.union(
			v.literal('approved'),
			v.literal('rejected'),
			v.literal('edited')
		),
		agentConfidence: v.number(),
		userFeedback: v.optional(v.string()),
		inboundMessageId: v.optional(v.id('inboundMessages')),
		createdAt: v.number(),
	})
		.index('by_category', ['category'])
		.index('by_created_at', ['createdAt']),

	// Autonomy Suggestions - pending "graduation" nudges. Autonomy only ever
	// widens (a lower auto-approve threshold = easier auto-send) by the user's
	// explicit decision, never automatically. When the weekly cron observes a
	// low rejection rate it records a suggestion here instead of loosening the
	// threshold itself; an owner/admin must explicitly accept it to apply.
	autonomySuggestions: defineTable({
		category: v.string(),
		currentThreshold: v.number(),   // rule threshold at suggestion time
		suggestedThreshold: v.number(), // the looser (lower) threshold on offer
		evidence: v.object({
			approved: v.number(),      // approvals observed in the window
			sampleSize: v.number(),    // total feedback rows in the window
			rejectionRate: v.number(), // rejections / sampleSize
		}),
		createdAt: v.number(),
	})
		.index('by_category', ['category']),

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
	})
		.index('by_thread', ['threadId']),
};
