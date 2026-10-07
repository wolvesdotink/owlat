import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { threadRefFields } from '../lib/validators/threadRef';
import {
	activityActorValidator,
	activityDeltaValidator,
	activityOpRefValidator,
	activityProvenanceValidator,
	activityTypeValidator,
	activityVisibilityValidator,
	briefCompletenessValidator,
	coverageEntryValidator,
	draftRefKindValidator,
	evidenceValidator,
	factStatusValidator,
	factValueValidator,
	fileClaimValidator,
	interpretCoverageValidator,
	interpretEligibilitySignalsValidator,
	interpretModeValidator,
	interpretationSkipReasonValidator,
	interpretationSourceValidator,
	interpretationStatusValidator,
	itemAmountValidator,
	itemCompletionValidator,
	itemConsequenceKindValidator,
	itemCorrectionValidator,
	itemDispositionValidator,
	itemDueValidator,
	itemFacetValidator,
	itemIntentValidator,
	itemResponsibilityValidator,
	itemRevisionRefValidator,
	itemStatusValidator,
	itemCorrectionKindValidator,
	itemListBucketValidator,
	itemVerifyValidator,
	localizedSealedTextValidator,
	noteSourceValidator,
	newPromiseValidator,
	ownerInputRefValidator,
	participantRefValidator,
	planVerdictValidator,
	responsePlanStanceValidator,
	sourceManifestValidator,
	streamPositionValidator,
	threadViewValidator,
} from '../lib/validators/threadBrief';

/**
 * The thread brief tables, children before parents: note reactions, the
 * correction log, plans, viewer state and activity before the items and facts
 * they point at, interpretations, their source snapshots and the brief row
 * last. The order the organization wipe deletes them in.
 */
export const THREAD_BRIEF_TABLES = [
	'noteReactions',
	'threadItemCorrections',
	'draftResponsePlans',
	'threadViewerState',
	'threadActivity',
	'threadFacts',
	'threadItems',
	'messageInterpretations',
	'interpretSources',
	'threadBriefs',
] as const;

export type ThreadBriefTable = (typeof THREAD_BRIEF_TABLES)[number];

/**
 * Thread brief (SPEC §2, ADR-0072): per-message interpretation folded into
 * per-thread items, facts and activity by a deterministic reducer
 * (`mail/interpret/reduce.ts`).
 *
 * Every table names its thread through `threadRefFields` (`threadKind` plus
 * exactly one of `mailThreadId` / `conversationThreadId`,
 * `lib/validators/threadRef.ts`) and inherits that thread's read permission:
 * mailbox access for `mail`, Team Inbox membership for `team`.
 *
 * Team surfaces (agent Team Inbox threads and shared-scope mailboxes) run in
 * `actions` mode: they never write `threadFacts` or `threadBriefs.overview`.
 *
 * Fields commented `sealed` hold an at-rest envelope written through
 * `lib/messageBody.ts`, the same seal as message bodies. A sealed JSON blob
 * carries a sibling `<field>Version`.
 *
 * ERASURE: purging a message, thread, mailbox or account removes or recomputes
 * every row here that depends on it (interpretations by source, items and
 * facts whose evidence it held, plans, activity). `deletionEpoch` on
 * interpretations and briefs blocks an in-flight interpretation from writing
 * erased content back.
 *
 * Spread into `defineSchema()` from schema.ts via `...threadBriefTables`.
 */
export const threadBriefTables = {
	// One row per (source message, content revision, extractor version):
	// immutable once complete, reused on replay.
	messageInterpretations: defineTable({
		...threadRefFields,
		source: interpretationSourceValidator,
		// lib/validators/threadBrief.ts interpretationSourceKey(source).
		sourceKey: v.string(),
		// Hash of the scoped, segmented content that was read.
		contentRevision: v.string(),
		// mail/interpret/schema.ts INTERPRET_EXTRACTOR_VERSION.
		extractorVersion: v.number(),
		mode: interpretModeValidator,
		status: interpretationStatusValidator,
		skipReason: v.optional(interpretationSkipReasonValidator),
		// Eligibility inputs, persisted so a retry decides on the same ones.
		eligibility: v.optional(interpretEligibilitySignalsValidator),
		sourceManifest: v.optional(sourceManifestValidator),
		coverage: v.optional(interpretCoverageValidator),
		// The validated model proposals plus `latest`, as JSON. Sealed.
		payload: v.optional(v.string()),
		// Shape version of `payload` (mail/interpret/schema.ts INTERPRET_PAYLOAD_VERSION).
		payloadVersion: v.optional(v.number()),
		// Short machine reason for `failed` / `partial` (never mail text).
		errorCode: v.optional(v.string()),
		// The thread's deletion epoch when the run started; a mismatch at write time drops it.
		deletionEpoch: v.number(),
		// When the reducer folded this extraction into the thread (same
		// transaction as the write); a replay of an applied row is a no-op.
		appliedAt: v.optional(v.number()),
		// The newest applied extraction of its source (one per source): the
		// row the brief's source counters count.
		isCurrent: v.optional(v.boolean()),
		// Message date of the source: the order an ordered replay folds it in.
		sourceAt: v.optional(v.number()),
		// Fingerprint of the stored body the run read (mail/interpret/sourceVersion.ts);
		// the reducer refuses a write when the body changed since.
		sourceVersion: v.optional(v.string()),
		// Retryable partial or failed runs: attempts so far and when the next is due.
		retryCount: v.optional(v.number()),
		nextRetryAt: v.optional(v.number()),
		// Brief mode: the message's exact wording must stay in view beside the
		// brief (legal notice, changed terms, payment details), and why. Kept
		// out of the sealed payload so the brief finds every such source by index.
		isExactWordingRequired: v.optional(v.boolean()),
		exactWordingReason: v.optional(
			v.union(
				v.literal('legal'),
				v.literal('terms'),
				v.literal('payment_details'),
				v.literal('security')
			)
		),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		// Idempotency: one extraction per source revision and extractor version.
		.index('by_source_revision', ['sourceKey', 'contentRevision', 'extractorVersion'])
		.index('by_mail_thread', ['mailThreadId'])
		// "Read the exact wording": every source of a thread that asked for it.
		.index('by_mail_thread_exact_wording', ['mailThreadId', 'isExactWordingRequired'])
		.index('by_conversation_thread', ['conversationThreadId']),

	// Informational claims of personal mail threads (brief mode only).
	threadFacts: defineTable({
		...threadRefFields,
		// @owlat/shared/threadBrief factKeyString({entity, attribute, context}):
		// a short normalized label, stored plain so it can be matched.
		factKey: v.string(),
		// The claim in the source language. Sealed.
		assertion: v.string(),
		display: localizedSealedTextValidator,
		value: v.optional(factValueValidator),
		evidence: v.array(evidenceValidator),
		provenance: activityProvenanceValidator,
		supersedesId: v.optional(v.id('threadFacts')),
		conflictsWithId: v.optional(v.id('threadFacts')),
		status: factStatusValidator,
		// `<sourceKey>#f<index>`: the proposal that created it, so an ordered
		// replay maps a rebuilt fact back onto this row.
		lineage: v.optional(v.string()),
		revision: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		// "Where things stand": a thread's current facts.
		.index('by_mail_thread_and_status', ['mailThreadId', 'status']),

	// One obligation each. Status (the work) and disposition (what we told the
	// other side) are separate; see @owlat/shared/threadBrief LEGAL_STATUS_EDGES.
	threadItems: defineTable({
		...threadRefFields,
		// Mailbox of a mail thread, denormalized for the cross-thread reads
		// (Workbench "To do" band). Absent on team threads.
		mailboxId: v.optional(v.id('mailboxes')),
		// Bumped on every change; plans and activity bind to it.
		revision: v.number(),
		intent: itemIntentValidator,
		facets: v.array(itemFacetValidator),
		// What makes the item consequential (verifier input, isConsequential in
		// @owlat/shared/threadBriefRules). Absent = the model did not say, which
		// counts as consequential.
		consequences: v.optional(v.array(itemConsequenceKindValidator)),
		// The obligation in the source language. Sealed.
		assertion: v.string(),
		display: localizedSealedTextValidator,
		requester: participantRefValidator,
		responsible: participantRefValidator,
		beneficiary: v.optional(participantRefValidator),
		responsibility: itemResponsibilityValidator,
		// Team: the teammate working on it (D4). Never changes responsibility.
		assigneeUserId: v.optional(v.string()),
		status: itemStatusValidator,
		disposition: itemDispositionValidator,
		// Set when status is done.
		completion: v.optional(itemCompletionValidator),
		due: v.optional(itemDueValidator),
		amount: v.optional(itemAmountValidator),
		// The choices a decision offers, as written.
		options: v.optional(v.array(v.string())),
		evidence: v.array(evidenceValidator),
		replacedById: v.optional(v.id('threadItems')),
		possibleDuplicateOfId: v.optional(v.id('threadItems')),
		correction: v.optional(itemCorrectionValidator),
		verify: itemVerifyValidator,
		// The brief list it sits in (mail/interpret/counters.ts listBucketOf), written
		// with every item write; threadBriefs.itemCounts counts the same partition.
		listBucket: v.optional(itemListBucketValidator),
		// Conflicting evidence after a human correction, or a security flag.
		isReviewNeeded: v.optional(v.boolean()),
		// "Remind me" (lives next to the lifecycle, never changes it).
		remindAt: v.optional(v.number()),
		commitmentId: v.optional(v.id('mailCommitments')),
		// Normalized counterparty address for cross-thread items (P4).
		counterpartyKey: v.optional(v.string()),
		// `<sourceKey>#<index>`: the proposal that created it, so an ordered
		// replay keeps the item's id.
		lineage: v.optional(v.string()),
		// Message date of the first evidence: the "age" of compareForYou.
		askedAt: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		// Trailing updatedAt: the 30-day closed lookback of the prompt and the brief
		// reads a status by update time (a long history never hides a recent change).
		.index('by_mail_thread_and_status', ['mailThreadId', 'status', 'updatedAt'])
		.index('by_conversation_thread_and_status', ['conversationThreadId', 'status', 'updatedAt'])
		// One list of a thread in due order / in asking order: the list row's top
		// item is the first row of one of these (mail/interpret/briefTop.ts).
		.index('by_mail_thread_bucket_due', ['mailThreadId', 'listBucket', 'due.at'])
		.index('by_mail_thread_bucket_asked', ['mailThreadId', 'listBucket', 'askedAt'])
		.index('by_mailbox_responsibility_due', ['mailboxId', 'responsibility', 'status', 'due.at'])
		.index('by_counterparty', ['counterpartyKey'])
		// Member erasure: the items assigned to an erased member fall back to Unassigned.
		.index('by_assignee', ['assigneeUserId']),

	// Append-only per-thread log.
	threadActivity: defineTable({
		...threadRefFields,
		// Per-thread sequence, allocated from threadBriefs.lastActivitySeq.
		seq: v.number(),
		// Writer-chosen key; a second append with the same key is a no-op.
		idempotencyKey: v.string(),
		type: activityTypeValidator,
		actor: activityActorValidator,
		provenance: activityProvenanceValidator,
		visibility: activityVisibilityValidator,
		itemId: v.optional(v.id('threadItems')),
		itemRevision: v.optional(v.number()),
		delta: v.optional(activityDeltaValidator),
		opRef: v.optional(activityOpRefValidator),
		// Row detail as JSON (quotes, counts, names). Sealed.
		payload: v.optional(v.string()),
		payloadVersion: v.optional(v.number()),
		eventAt: v.number(),
		recordedAt: v.number(),
	})
		.index('by_mail_thread_and_seq', ['mailThreadId', 'seq'])
		.index('by_conversation_thread_and_seq', ['conversationThreadId', 'seq'])
		.index('by_idempotency_key', ['idempotencyKey'])
		// Erasure (mail/interpret/purge.ts): an item's rows go with the item, and
		// a row whose operation names a purged message goes with the message.
		.index('by_item', ['itemId'])
		.index('by_op_ref', ['opRef.id']),

	// One row per source message, written when interpretation is enqueued
	// (mail/interpret/sources.ts): the eligibility signals every retry reuses,
	// and for a team reply the immutable text that was sent.
	interpretSources: defineTable({
		...threadRefFields,
		source: interpretationSourceValidator,
		sourceKey: v.string(),
		eligibility: interpretEligibilitySignalsValidator,
		// Team replies: the sent content, captured at send finalization. Sealed.
		snapshot: v.optional(
			v.object({ subject: v.string(), text: v.string(), capturedAt: v.number() })
		),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_source_key', ['sourceKey'])
		// Thread erasure (mail/interpret/purgeRows.ts threadBriefRanges).
		.index('by_mail_thread', ['mailThreadId'])
		.index('by_conversation_thread', ['conversationThreadId']),

	// One row per thread: the reducer's revision, checkpoint and completeness.
	threadBriefs: defineTable({
		...threadRefFields,
		mode: interpretModeValidator,
		// Revision of the thread's source content the brief was folded from.
		sourceRevision: v.number(),
		// Compare-and-set counter of applyInterpretation.
		interpretationRevision: v.number(),
		// Last applied source, in thread order: out-of-order input replays from here.
		checkpoint: v.optional(
			v.object({
				sourceKey: v.string(),
				sourceAt: v.number(),
				interpretationId: v.id('messageInterpretations'),
			})
		),
		// Highest threadActivity.seq handed out.
		lastActivitySeq: v.number(),
		completeness: briefCompletenessValidator,
		// Per-source counts of the current extractions (mail/interpret/counters.ts),
		// maintained in the transaction that changes them; completeness reads them.
		sourceCounts: v.optional(
			v.object({
				complete: v.number(),
				partial: v.number(),
				failed: v.number(),
				unreadable: v.number(),
				skipped: v.number(),
			})
		),
		// Item counts by list (open per responsibility, unconfirmed proposals,
		// closed, untracked), maintained by every writer of an item's status,
		// responsibility or verify state. `proposal` is absent on rows written
		// before it existed (read as 0).
		itemCounts: v.optional(
			v.object({
				us: v.number(),
				them: v.number(),
				unclear: v.number(),
				proposal: v.optional(v.number()),
				closed: v.number(),
				hidden: v.number(),
			})
		),
		// Bumped by every purge touching the thread.
		deletionEpoch: v.number(),
		// Compaction cache (mail threads only, disposable): per locale, JSON. Sealed.
		overview: v.optional(
			v.object({
				revision: v.number(),
				version: v.number(),
				generatedAt: v.number(),
				en: v.optional(v.string()), // sealed
				de: v.optional(v.string()), // sealed
			})
		),
		updatedAt: v.number(),
	})
		.index('by_mail_thread', ['mailThreadId'])
		.index('by_conversation_thread', ['conversationThreadId']),

	// Per viewer and thread: view override and "since you last looked". Does not
	// replace mailThreadVisits or threadReads.
	threadViewerState: defineTable({
		...threadRefFields,
		// BetterAuth user id.
		userId: v.string(),
		viewOverride: v.optional(threadViewValidator),
		seenInterpretationRevision: v.number(),
		seenActivitySeq: v.number(),
		// Team stream: last entry actually viewed.
		streamPosition: v.optional(streamPositionValidator),
		updatedAt: v.number(),
	})
		.index('by_user_and_mail_thread', ['userId', 'mailThreadId'])
		.index('by_user_and_conversation_thread', ['userId', 'conversationThreadId'])
		// Every viewer's row of one thread: thread erasure and scope invalidation.
		.index('by_mail_thread', ['mailThreadId'])
		.index('by_conversation_thread', ['conversationThreadId']),

	// A person's correction of the model about an item ("Not a request"), kept
	// for the interpretation eval: which kind of item the model got wrong, and
	// under which extractor. Structure only, never the item's text: the text
	// stays on the item (sealed) and goes with it.
	threadItemCorrections: defineTable({
		...threadRefFields,
		itemId: v.id('threadItems'),
		// The item revision the correction was made against.
		itemRevision: v.number(),
		kind: itemCorrectionKindValidator,
		// BetterAuth user id of who corrected it.
		userId: v.string(),
		// The item as the model had it.
		intent: itemIntentValidator,
		facets: v.array(itemFacetValidator),
		responsibility: itemResponsibilityValidator,
		verify: itemVerifyValidator,
		// The extractions its evidence came from (interpretationSourceKey + revision).
		evidenceSources: v.array(v.object({ sourceKey: v.string(), contentRevision: v.string() })),
		createdAt: v.number(),
	})
		.index('by_mail_thread', ['mailThreadId'])
		.index('by_conversation_thread', ['conversationThreadId'])
		// Erasure: a deleted item's corrections go with it; an erased member's are anonymized.
		.index('by_item', ['itemId'])
		.index('by_user', ['userId']),

	// Emoji reactions on internal notes: Team Inbox `threadNotes` and Postbox
	// thread discussion `chatMessages`. One row per (note, person, emoji);
	// toggled through `mail/interpret/noteReactions.ts`, bounded per note.
	noteReactions: defineTable({
		...threadRefFields,
		noteSource: noteSourceValidator,
		// Set when noteSource === 'threadNote'.
		threadNoteId: v.optional(v.id('threadNotes')),
		// Set when noteSource === 'chatMessage'.
		chatMessageId: v.optional(v.id('chatMessages')),
		// BetterAuth user id of who reacted.
		userId: v.string(),
		emoji: v.string(),
		createdAt: v.number(),
	})
		.index('by_thread_note', ['threadNoteId', 'userId', 'emoji'])
		.index('by_chat_message', ['chatMessageId', 'userId', 'emoji'])
		.index('by_mail_thread', ['mailThreadId'])
		.index('by_conversation_thread', ['conversationThreadId'])
		// Member erasure: an erased member's reactions go.
		.index('by_user', ['userId']),

	// Per draft: the stances, coverage and claims of its self-check, bound to
	// the draft hash and the item revisions it was built against.
	draftResponsePlans: defineTable({
		...threadRefFields,
		draftKind: draftRefKindValidator,
		// Set when draftKind === 'mailDraft'.
		mailDraftId: v.optional(v.id('mailDrafts')),
		// Set when draftKind === 'inboundDraft' (the team draft lives on the inbound message).
		inboundMessageId: v.optional(v.id('inboundMessages')),
		threadRevision: v.number(),
		itemRevisions: v.array(itemRevisionRefValidator),
		stances: v.array(responsePlanStanceValidator),
		ownerInputs: v.array(ownerInputRefValidator),
		coverage: v.array(coverageEntryValidator),
		newPromises: v.array(newPromiseValidator),
		fileClaims: v.array(fileClaimValidator),
		draftHash: v.string(),
		verdict: planVerdictValidator,
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_mail_draft', ['mailDraftId'])
		.index('by_inbound_draft', ['inboundMessageId'])
		// Every plan of one thread: thread erasure and scope invalidation.
		.index('by_mail_thread', ['mailThreadId'])
		.index('by_conversation_thread', ['conversationThreadId']),
};
