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
import { agentStepKindValidator } from '../agent/steps/catalog';
import { llmUsageTagFields } from '../lib/llmUsageTags';
import {
	agentMetricTypeValidator,
	attachmentIndexingValidator,
	contextTierValidator,
	virusVerdictValidator,
} from '../lib/literalValidators';

/**
 * Inbox / Agent pipeline tables — AI-assisted shared inbox.
 *
 * conversationThreads + inboundMessages drive the shared inbox; agentActions
 * tracks per-step pipeline execution; knowledgeBackfillJobs gates the initial
 * history scan; agentMetrics + llmUsageEvents cover monitoring/spend;
 * coalesceBatches debounces bursts.
 *
 * The per-person collaboration signals (threadPresence, threadReads,
 * inboxAssignmentNotices) live in `schema/inboxCollaboration.ts`.
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
		// Originating channel for the thread-list channel chip. Absent (or 'email')
		// = the default email channel and renders NO chip; a non-email value
		// ('sms' / 'whatsapp' / …) surfaces a single channel chip on the row.
		// Denormalized at create time by the thread module so the list never has to
		// join to the newest message to know the channel.
		channel: v.optional(v.string()),
		// Newest message's sealed-at-rest preview — denormalized by the thread module on
		// each inbound_activity so the team-inbox row can show a snippet line
		// without an N+1 read of the latest inboundMessages/unifiedMessages row.
		// Read-side hint only; opened by inbox queries and never gates a query.
		lastPreview: v.optional(v.string()),
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
		// Status + recency: lets the Team Inbox filter pills page an Open / Waiting
		// / Resolved view in true lastMessageAt order (both directions) instead of
		// falling back to creation order on the plain by_status index.
		.index('by_status_and_last_message_at', ['status', 'lastMessageAt'])
		.index('by_last_message_at', ['lastMessageAt'])
		.index('by_contact', ['contactId'])
		.index('by_assigned_to', ['assignedTo'])
		.index('by_snoozed_until', ['snoozedUntil'])
		.index('by_normalized_subject_and_contact', ['normalizedSubject', 'contactIdentifier'])
		// Team Inbox TEXT SEARCH. Two indexes rather than one denormalized
		// `searchableText` column: a thread's subject and its participant are both
		// written once at insert and never patched (inbox/threads/module.ts), so a
		// third derived column would only add a backfill and a drift risk for
		// exactly the two fields the pickers already matched client-side. The
		// search path reads both and merges them (inbox/threadFilters.ts).
		//
		// SEALED-AT-REST NOTE (Sealed Mail E8b): these index thread METADATA — the
		// subject line and the participant address — not a message body.
		// `lastPreview` IS a sealed body and is deliberately NOT indexed here.
		// See lib/atRestBodies.ts.
		.searchIndex('search_thread_subject', { searchField: 'subject' })
		.searchIndex('search_thread_participant', { searchField: 'contactIdentifier' }),

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
		// Attachment metadata, as a JSON array, in one of TWO shapes discriminated
		// by `attachmentMetaVersion` beside it:
		//   0 (the column absent) — `{filename, contentType, size}`, everything
		//     written before the raw-carrying route existed. The bytes were not
		//     stored, so there was nothing for a reader to address;
		//   1 — `{filename?, contentType, size, partIndex?}`. The BYTES are in the
		//     sealed raw `.eml` at `rawStorageId` below, and `partIndex` is how a
		//     reader addresses one part inside it.
		// An unvalidated JSON string, unlike the structured
		// `mailMessages.attachments`, so every reader parses it defensively.
		attachmentMeta: v.optional(v.string()),
		// The shape of the blob above — CONVENTIONS.md "Schema evolution" requires
		// a JSON `v.string()` column to carry one, so the next change to that
		// shape is a version bump rather than a reader guessing from whether a
		// field happens to be present.
		attachmentMetaVersion: v.optional(v.number()),
		// The whole received message, sealed at rest (`lib/sealedBlob.ts`). The
		// attachment bytes, the AV scan input and the reader's download all come
		// out of this one blob rather than a second copy per part.
		//
		// OPTIONAL, unlike the REQUIRED `mailMessages.rawStorageId`/`rawSize`
		// pair: every row written before this landed has none, and mail arriving
		// through the legacy `/webhooks/mta` route (an older MTA binary, a DLQ
		// replay) still has none. Absent means "no raw stored" — a first-class
		// state every reader handles, not a backfill waiting to happen.
		rawStorageId: v.optional(v.id('_storage')),
		// Size of that blob, in bytes. KEPT past the sweep on purpose: once the
		// bytes are released it is the only thing left that says how big the
		// original message was, and the reader shows it beside the "no longer
		// stored" line so the entry is a fact rather than an absence.
		rawSize: v.optional(v.number()),
		// Aggregate malware verdict over the message's attachment leaves, from the
		// MTA's ClamAV endpoint. `infected` quarantines the row and skips the agent
		// pipeline. ABSENT IS NOT `clean`: it means nothing was scanned — either
		// there was nothing to scan or the scanner is not configured — and the two
		// are indistinguishable, so no verdict is asserted.
		virusVerdict: v.optional(virusVerdictValidator),
		// Sweep marker for the raw-blob retention pass, set with `rawStorageId` and
		// cleared with it. It exists because almost every row in this table
		// predates raw storage and holds no blob: a time-only walk would re-scan
		// the entire history on every tick and never terminate, while an index
		// keyed on the marker only ever contains rows that still hold bytes.
		isRawRetained: v.optional(v.literal(true)),
		// When the retention sweep released this message's raw blob. It is what
		// separates "the window passed" from "the bytes were never carried" —
		// every row older than the raw-carrying route has no `rawStorageId`
		// either, and telling a user that a 90-day window expired on a message
		// from last week is simply false. Set exactly once, by the sweep.
		rawReleasedAt: v.optional(v.number()),
		// What attachment capture did with this message's files — see
		// `lib/literalValidators.ts:attachmentIndexingValidator`. Absent on a
		// message with no eligible attachments and on every row that predates the
		// marker. Patched after the insert, because capture runs after it.
		attachmentIndexing: v.optional(attachmentIndexingValidator),
		// RFC 8601 inbound authentication verdicts, computed by the MTA over the
		// raw bytes at ingest (SPF on MAIL FROM, DKIM on the d= signature, DMARC
		// binding the two to the From domain via alignment). The AI-inbox path
		// used to DROP these — the personal-mailbox path (`mailMessages`) has
		// carried them since inbound auth landed. Persisted here so the reader can
		// render an honest sender-authenticity badge. ALL optional: an older MTA
		// (or a disabled check) sends the field absent, which renders as "unknown"
		// downstream — NEVER as "pass". RFC 8601 keyword strings
		// (`pass`/`fail`/`softfail`/`neutral`/`none`/`temperror`/`permerror`).
		spfResult: v.optional(v.string()),
		dkimResult: v.optional(v.string()),
		dmarcResult: v.optional(v.string()),
		// The published DMARC policy (`none`/`quarantine`/`reject`) that applied to
		// the From domain, captured alongside `dmarcResult` so the reader can tell a
		// monitor-only `p=none` fail from one the domain owner asked us to act on.
		dmarcPolicy: v.optional(v.string()),
		// Sealed Mail (E4): mirrored flags of the inbound unsealing outcome on the
		// AI-inbox path (decrypt-on-ingest, D3). The full record lives on the
		// mailMessages side; here only what the reader's badge needs. `isSealed` is
		// true when the message arrived as PGP/MIME ciphertext; `isSignatureValid`
		// is present ONLY when we decrypted it AND checked the signature (true iff
		// it verified against the pinned sender key — an undecryptable message
		// carries `isSealed:true` with no signature claim). All optional: plaintext
		// mail and pre-E4 rows omit them entirely.
		isSealed: v.optional(v.boolean()),
		isSignatureValid: v.optional(v.boolean()),
		signerFingerprint: v.optional(v.string()),
		signerInstance: v.optional(v.string()),
		// F1 (D9): mirrored display fields of the inbound SIGNED-but-not-encrypted
		// PGP verdict, the signed-plaintext sibling of the sealed mirror above.
		// The full `inboundSignatureInfo` record lives on the mailMessages side;
		// here only what the reader's badge needs. `isInboundSignatureValid` is
		// present ONLY when the message was structurally PGP-signed AND the
		// verifier ran (true iff the signature verified against the pinned/
		// discovered sender key); `inboundSignerFingerprint` only when it
		// verified. Distinct from the sealed fields above so the fail-closed
		// sealed semantics stay untouched. Absent on plaintext mail and pre-F1 rows.
		isInboundSignatureValid: v.optional(v.boolean()),
		inboundSignerFingerprint: v.optional(v.string()),
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
			v.literal('informational'), // Needs no reply — surfaced on the Updates dashboard
			v.literal('approved'), // Draft approved by human or auto-approved
			v.literal('sent'), // Reply sent
			v.literal('rejected'), // Draft rejected by human
			v.literal('archived'), // Archived without reply (spam, etc.)
			v.literal('failed') // Pipeline error
		),
		// Why the message was archived (the lifecycle's archive reason, e.g.
		// `classifier_spam`, `update_dismissed`). Written on every `→ archived`
		// transition so the Updates dashboard's Spam tab can list what the
		// classifier caught. Absent on rows archived before the field existed.
		archiveReason: v.optional(v.string()),
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
		contextTier: v.optional(contextTierValidator),
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
		// Cancellable pending-send marker for a DELAYED approved send. Set when
		// an approved message schedules its send after a configurable undo window
		// instead of firing immediately — an AUTONOMOUS auto-approve
		// (agentConfig.autoSendDelayMs) or a HUMAN approve
		// (agentConfig.humanApproveUndoDelayMs). `scheduledFnId` is the handle
		// the cancel path (`cancelAutoSend`) passes to `ctx.scheduler.cancel` to
		// abort an in-flight delayed send; `sendAt` powers the UI countdown
		// ("Sending in 0:59 — Undo" / "Approved — Undo (14s)"). Cleared on any
		// transition out of `approved`. Absent for delay=0 (legacy immediate
		// send).
		pendingAutoSend: v.optional(
			v.object({
				scheduledFnId: v.id('_scheduled_functions'),
				sendAt: v.number(),
				scheduledAt: v.number(),
			})
		),
		// Provenance of the LAST `approved` transition: 'auto' (router
		// auto-approve) or 'human' (reviewer approve). The send-time learning
		// recorder consults this rather than trusting `sendApprovedReply`'s
		// optional `autonomous` arg, because the stuck-approved reconcile
		// re-fires that action without the arg — an autonomous send recovered by
		// the cron must not train the loop as a human approval. Absent on
		// messages approved before this field existed (read as human, matching
		// the arg-absent semantics).
		approvalSource: v.optional(v.union(v.literal('auto'), v.literal('human'))),
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
		// True while the working draft differs from the agent original (kept in
		// sync by every revision-appending save — see inbox/draftRevisions.ts).
		// Used to tell an UNEDITED owner-send of an answered-clarification draft
		// (a strong positive autonomy outcome) apart from an edited-then-sent one.
		isDraftEdited: v.optional(v.boolean()),
		// Non-destructive draft revision history (D7, save-without-approving).
		// Seeded on the FIRST human save with the agent's original as revision 0
		// (`savedBy: 'agent'`), then one entry appended per save / revise-apply
		// (`savedBy` = the saving user's id). Revision 0 is immutable — the
		// review diff renders against it, and the approve-time `'edited'`
		// autonomy signal compares the sent text to it. Absent until a human
		// saves.
		draftRevisions: v.optional(
			v.array(
				v.object({
					text: v.string(),
					subject: v.optional(v.string()),
					savedAt: v.number(),
					savedBy: v.string(),
				})
			)
		),
		// Stamped on every save-without-approving (and every revision-appending
		// edit). Drives the review queue's "Saved · edited by you" chip and its
		// saved-first sort bump. The row stays `draft_ready` — no status change.
		draftSavedAt: v.optional(v.number()),
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
		.index('by_assigned_to_and_status', ['assignedTo', 'processingStatus'])
		// Drives the raw-blob retention sweep: the equality component keeps the
		// scanned range to rows that still hold a blob, so the walk is bounded by
		// what is left to release rather than by the size of the table.
		.index('by_raw_retention', ['isRawRetained', 'receivedAt']),

	// Agent Actions - tracks individual pipeline step executions
	agentActions: defineTable({
		inboundMessageId: v.id('inboundMessages'),
		// Which pipeline step this action represents — matches the
		// AgentStepKind union in convex/agent/steps/types.ts. The
		// `plan` kind was dropped pre-prod with ADR-0014.
		actionType: agentStepKindValidator,
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
		metricType: agentMetricTypeValidator,
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

	// Per-call LLM usage + estimated cost for EVERY feature and every plane, not
	// just the inbound agent (which also records to agentActions). Windowed reads
	// via the system by_creation_time index; retention prunes the tail. The four
	// optional tags — plane, plus the decision plane's — are lib/llmUsageTags.ts.
	llmUsageEvents: defineTable({
		feature: v.string(),
		organizationId: v.optional(v.string()),
		pluginId: v.optional(v.string()),
		modelUsed: v.optional(v.string()),
		promptTokens: v.number(),
		completionTokens: v.number(),
		totalTokens: v.number(),
		costUsd: v.number(),
		createdAt: v.number(),
		...llmUsageTagFields,
	})
		.index('by_feature', ['feature'])
		.index('by_organization_id_and_created_at', ['organizationId', 'createdAt'])
		.index('by_organization_id_and_plugin_id_and_created_at', [
			'organizationId',
			'pluginId',
			'createdAt',
		]),

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
