import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	securityFlagsValidator,
	contextCoverageValidator,
	draftQualityValidator,
	groundingSourceValidator,
	agentDecisionValidator,
	tokenUsageValidator,
} from '../lib/convexValidators';
import { classificationValidator } from '../lib/validators/classification';
import { pendingClarificationValidator } from '../lib/validators/clarification';
import { attachmentSuggestionsValidator } from '../lib/validators/attachment';
import { teamReplyAttachmentsValidator } from '../lib/validators/teamReplyAttachment';
import { draftRevisionValidator } from '../lib/validators/draftRevision';
import { agentStepKindValidator } from '../agent/steps/catalog';
import { llmUsageTagFields } from '../lib/llmUsageTags';
import { conversationThreadTables } from './conversationThreads';
import {
	agentMetricTypeValidator,
	attachmentIndexingValidator,
	backfillJobStatusValidator,
	contextTierValidator,
	virusVerdictValidator,
} from '../lib/literalValidators';

/**
 * Inbox / Agent pipeline tables — AI-assisted shared inbox.
 *
 * conversationThreads (`schema/conversationThreads.ts`, split out at the size
 * cap) + inboundMessages drive the shared inbox; agentActions
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
	...conversationThreadTables,

	// Inbound Messages - stores every inbound email with its processing state
	inboundMessages: defineTable({
		// SMTP envelope data
		messageId: v.string(), // SMTP Message-ID header
		from: v.string(), // Sender email address
		to: v.string(), // Recipient email address
		subject: v.string(),
		// Message content: each part inline (sealed) OR, too large for the row, a
		// sealed blob — never both. lib/messageBodyInbound.ts reads either shape.
		textBody: v.optional(v.string()),
		htmlBody: v.optional(v.string()),
		textBodyStorageId: v.optional(v.id('_storage')),
		htmlBodyStorageId: v.optional(v.id('_storage')),
		bodyExcerpt: v.optional(v.string()), // sealed stand-in for a stored readable part
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
		// The lifecycle's archive reason (`classifier_spam`, `update_dismissed`, …),
		// written on every `→ archived` transition; the Updates Spam tab reads it.
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
		// reviewer 2–3 variants. `draftOptions[0]` is always the
		// self-checked primary draft (== `draftResponse`); the rest are
		// alternatives. Absent on the normal single-draft path and whenever the
		// options generation fails (fail-soft to the single draft). They belong
		// to that one agent draft: a saved edit, a re-draft without variants and
		// a reopen all clear them.
		draftOptions: v.optional(v.array(v.string())),
		// Advisory attachment suggestion the `draft` step computed when the inbound
		// asks for a document ("can you send X" / "see attached") and a
		// contact-scoped semanticFiles match exists. Rendered as a one-tap
		// "attach <file>?" chip in the review gate + composer. NEVER consumed by the
		// autonomous send path — human-confirmed only. Absent when nothing matched.
		attachmentSuggestions: v.optional(attachmentSuggestionsValidator),
		replyAttachments: v.optional(teamReplyAttachmentsValidator), // what its reply carried
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
		// ("Sending in 0:59 — Undo"). Cleared on any transition out of
		// `approved`. Absent for delay=0 (legacy immediate send).
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
		// When a person last took the reply over from the agent (manualReply.ts).
		// While set, late pipeline writes are refused; cleared on `→ received`.
		manualTakeoverAt: v.optional(v.number()),
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
		draftRevisions: v.optional(v.array(draftRevisionValidator)),
		// Stamped on every save-without-approving (and every revision-appending
		// edit). Drives the review queue's "Saved · edited by you" chip and its
		// saved-first sort bump. The row stays `draft_ready` — no status change.
		draftSavedAt: v.optional(v.number()),
		// A saved reply or the agent left `[[...]]` gaps in the working draft: they
		// hold Send, and `approveDraft` refuses them (DRAFT_HAS_GAPS) until filled.
		// Written by the composer's saves (`draftRevisions.appendDraftRevision`)
		// and with the agent's draft (`stepOutputs.recordDraftOutput`).
		isDraftGapGuarded: v.optional(v.boolean()),
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
		.index('by_status', ['status']),

	// Knowledge Backfill Jobs - one-time extraction of historical inbound mail,
	// created on the first ai.agent false→true toggle; walker and lifecycle in
	// knowledge/messageBackfill.ts and knowledge/backfillJobs.ts.
	knowledgeBackfillJobs: defineTable({
		status: backfillJobStatusValidator,
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
		.index('by_window_start', ['windowStart'])
		// Dashboard reads: one metricType over a recent window, bounded by the index.
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
		// When the burst's FIRST message arrived, carried across debounce restarts
		// so the hard-cap flush counts from there. Absent on old rows → createdAt.
		firstReceivedAt: v.optional(v.number()),
	}).index('by_thread', ['threadId']),
};
