import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { mailCategoryLabelValidator, mailCategorySourceValidator } from '../lib/literalValidators';
import {
	arrivalFilterMatchValidator,
	arrivalOperationActorValidator,
	arrivalOperationChangeValidator,
	arrivalOperationKindValidator,
	arrivalOperationStatusValidator,
	degradedByValidator,
	depthValidator,
	exclusiveWinnersValidator,
	pendingAiFilterValidator,
	placementValidator,
	reasonKeyValidator,
	senderPlacementOverrideValidator,
	senderStatusSourceValidator,
	senderStatusValidator,
	senderUnsubscribeValidator,
	unreadArchiveEvidenceValidator,
} from '../lib/validators/arrival';
import { mailArrivalRulesTables } from './mailArrivalRules';

/**
 * Read on arrival (SPEC §2.9): the arrival tables, children before parents.
 * The order the organization wipe deletes them in, and the list the tenant
 * registry, the wipe union and the coverage tests spread.
 */
export const MAIL_ARRIVAL_TABLES = [
	'mailDraftOfferUsage',
	'mailArrivalOperationChanges',
	'mailDelayedActions',
	'mailDigests',
	'mailRuleDrafts',
	'mailArrivalRecords',
	'mailSenderProfiles',
	'mailArrivalOperations',
] as const;

export type MailArrivalTable = (typeof MAIL_ARRIVAL_TABLES)[number];

/**
 * Read on arrival: what happened to each live inbound message of a personal
 * Postbox mailbox, per-sender standing and counters, and the undo log.
 *
 * Every row is mailbox-scoped and inherits the mailbox's read permission.
 *
 * ERASURE (SPEC §0): member erasure, an external mailbox's teardown and the
 * organization wipe delete every row with its mailbox
 * (`mail/arrival/mailboxRows.ts`, the wipe steps). Purging a message deletes
 * its arrival record, delayed actions and the change rows that name it, drops
 * its lines from unsent digests and clears a gist read from it: ranges of the
 * resumable `sources` purge job (`mail/arrival/purgeRanges.ts`). A mailbox that
 * becomes a team inbox loses all of it (`mail/arrival/sharedConversion.ts`).
 * Every row except the sender profile and the draft-offer usage carries
 * `expiresAt` (`maintenance/retention.ts`). Offer usage has no time limit: it
 * goes with its thread (`threadAggregates.ts`), the owed message
 * (`purgeRanges.ts`) or the mailbox.
 *
 * Spread into `mailTables` from schema/mail.ts.
 */
export const mailArrivalTables = {
	// One row per live inbound message (§2.8). Each writer patches only its own
	// fields in its own mutation: category refinement (category, AI answers),
	// the run (depth, modelCalls, reasonKeys), delivery (filterMatches).
	mailArrivalRecords: defineTable({
		mailboxId: v.id('mailboxes'),
		threadId: v.id('mailThreads'),
		messageId: v.id('mailMessages'),
		sourceKey: v.string(),
		// The message's place in its thread (the interpret source's
		// `sourceOrderKey`, mail/interpret/sourceOrder.ts). Records are
		// inbound-only, so the thread's newest inbound record is one indexed read.
		sourceOrderKey: v.optional(v.string()),
		depth: v.optional(depthValidator),
		category: v.optional(mailCategoryLabelValidator),
		categorySource: v.optional(mailCategorySourceValidator),
		filterMatches: v.optional(v.array(arrivalFilterMatchValidator)),
		// Deterministic part matched at ingest; waits for the R2 answer bound to
		// THIS message (≤5, highest priority first).
		pendingAiFilters: v.optional(v.array(pendingAiFilterValidator)),
		// From a matched placement/digest rule action.
		rulePlacement: v.optional(placementValidator),
		// One persisted resolution of the exclusive actions across both passes (§6.2).
		exclusiveWinners: v.optional(exclusiveWinnersValidator),
		// ABA guard for undoing a `recordRulePlacement` change (§4.4).
		lastOperationId: v.optional(v.id('mailArrivalOperations')),
		modelCalls: v.number(),
		reasonKeys: v.array(reasonKeyValidator),
		degradedBy: v.optional(degradedByValidator),
		createdAt: v.number(),
		updatedAt: v.number(),
		expiresAt: v.number(), // 90 days
	})
		.index('by_message', ['messageId'])
		.index('by_thread_created', ['threadId', 'createdAt'])
		// §2.8 projection: `.order('desc').first()` is the newest inbound message.
		.index('by_thread_source_order', ['threadId', 'sourceOrderKey'])
		// Mailbox erasure.
		.index('by_mailbox', ['mailboxId'])
		.index('by_expires', ['expiresAt']),

	// One row per (mailbox, sender). The sender is keyed by `senderDigest`
	// (decision/senderMemory.ts `senderDigest`: SHA-256 hex of the bare
	// lowercased address); `address` is stored like `mailContacts.email`
	// (canonical lowercase, plaintext, mailbox-private) for the Senders page.
	mailSenderProfiles: defineTable({
		mailboxId: v.id('mailboxes'),
		senderDigest: v.string(),
		address: v.string(), // canonical lowercase, like mailContacts.email
		displayName: v.optional(v.string()),
		status: senderStatusValidator,
		statusSource: senderStatusSourceValidator,
		statusChangedAt: v.optional(v.number()),
		statusOperationId: v.optional(v.id('mailArrivalOperations')),
		placementOverride: v.optional(senderPlacementOverrideValidator),
		placementOverrideOperationId: v.optional(v.id('mailArrivalOperations')),
		// The last settled category.
		kind: v.optional(mailCategoryLabelValidator),
		// 13 calendar-week buckets ("about 90 days"), newest at `weekAnchor`.
		weekAnchor: v.number(),
		deliveredWeeks: v.array(v.number()),
		openedWeeks: v.array(v.number()),
		lastDeliveredAt: v.optional(v.number()),
		unsubscribe: v.optional(senderUnsubscribeValidator),
		// Written by lane drafts only (§7).
		autoDraftPausedAt: v.optional(v.number()),
		unusedDraftStreak: v.number(),
		unreadArchiveEvidence: v.optional(unreadArchiveEvidenceValidator),
		learnedNoticeAt: v.optional(v.number()),
		// ABA guard for undo (§4.4).
		lastOperationId: v.optional(v.id('mailArrivalOperations')),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_mailbox_sender', ['mailboxId', 'senderDigest'])
		.index('by_mailbox_status_last', ['mailboxId', 'status', 'lastDeliveredAt'])
		.index('by_mailbox_last', ['mailboxId', 'lastDeliveredAt']),

	// Undo log header (§4.4); its changes are `mailArrivalOperationChanges`.
	mailArrivalOperations: defineTable({
		mailboxId: v.id('mailboxes'),
		kind: arrivalOperationKindValidator,
		actor: arrivalOperationActorValidator,
		senderDigest: v.optional(v.string()),
		threadId: v.optional(v.id('mailThreads')),
		messageId: v.optional(v.id('mailMessages')),
		filterId: v.optional(v.id('mailFilters')),
		// The person's free-text Fix reason. Sealed.
		reason: v.optional(v.string()),
		changeCount: v.number(),
		status: arrivalOperationStatusValidator,
		createdAt: v.number(),
		undoneAt: v.optional(v.number()),
		expiresAt: v.number(), // 30 days
	})
		.index('by_mailbox_created', ['mailboxId', 'createdAt'])
		.index('by_expires', ['expiresAt']),

	// One row per changed entity, written in the SAME mutation as the change.
	// `messageId` and `labelId` copy the change's ids to the top level so a
	// message purge finds its rows by index (`mail/arrival/changeRows.ts`
	// builds the row; write through it). A `messageLabel` change may name a
	// label deleted since: undo re-checks that the label still exists in the
	// mailbox and skips the row otherwise (`undo_partial`), as filter runs do.
	mailArrivalOperationChanges: defineTable({
		operationId: v.id('mailArrivalOperations'),
		mailboxId: v.id('mailboxes'),
		change: arrivalOperationChangeValidator,
		messageId: v.optional(v.id('mailMessages')),
		labelId: v.optional(v.id('mailLabels')),
		// SPEC `clearedNeedsReply` (renamed for the is* boolean rule): an archive
		// cleared a reply-queue verdict that undo does not restore.
		isNeedsReplyCleared: v.optional(v.boolean()),
		createdAt: v.number(),
		expiresAt: v.number(), // 30 days
	})
		.index('by_operation', ['operationId'])
		.index('by_message', ['messageId'])
		.index('by_mailbox', ['mailboxId'])
		.index('by_expires', ['expiresAt']),

	// Unused-draft streak (SPEC §7, mail/draftPause.ts): one row per offered AI
	// reply (an arrival slot or a clarification draft) whose outcome already
	// counted, keyed `<threadId>:<owed messageId>`. Checked and written in the
	// mutation that counts, so no copy of the offer counts again. No expiry:
	// deleted with the thread, the owed message (a message purge) or the mailbox.
	mailDraftOfferUsage: defineTable({
		mailboxId: v.id('mailboxes'),
		threadId: v.id('mailThreads'),
		offerKey: v.string(),
		countedAt: v.number(),
	})
		.index('by_mailbox_offer', ['mailboxId', 'offerKey'])
		.index('by_thread', ['threadId']),

	...mailArrivalRulesTables,
};
