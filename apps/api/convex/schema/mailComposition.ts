import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { mailboxJobFields } from '../lib/validators/mail';
import {
	mailAttachmentShareScanValidator,
	mailAttachmentShareScopeValidator,
	mailDraftAttachmentValidator,
	mailDraftExpectedAttachmentValidator,
	mailSnippetVariableValidator,
} from '../lib/validators/mailContent';

/**
 * One stored attachment leaf. `filename` / `contentType` are exactly what the
 * client-side walker (`@owlat/shared/mailMime.extractAttachments`) reports for
 * the leaf, and the array position IS its `partIndex`, so a server-side lookup
 * picks the same part `extractAttachmentAt` would.
 */
export const mailMessagePartValidator = v.object({
	filename: v.string(),
	contentType: v.string(),
	size: v.number(),
	storageId: v.id('_storage'),
});

/** What the delivery action stored for one message, handed to the insert. */
export const mailMessageStoredPartsFields = {
	/**
	 * `stored`: every attachment leaf is in `parts`, in document order.
	 * `too_many_parts`: the message has more leaves than one ingest stores, so
	 * `parts` is empty and downloads keep using the raw `.eml`.
	 */
	status: v.union(v.literal('stored'), v.literal('too_many_parts')),
	parts: v.array(mailMessagePartValidator),
	/**
	 * The first `text/calendar` leaf (inline or attached), what the invite card
	 * reads. Absent when the message has none.
	 */
	calendarStorageId: v.optional(v.id('_storage')),
};

export const mailMessageStoredPartsValidator = v.object(mailMessageStoredPartsFields);

export const mailMessagePartsFields = {
	/** The raw `.eml` blob these parts were cut out of. */
	rawStorageId: v.id('_storage'),
	...mailMessageStoredPartsFields,
	createdAt: v.number(),
};

/**
 * Composing and attachments: drafts, attachment rows and their
 * backfill jobs, share links, signatures and snippets.
 *
 * Spread into `mailTables` from schema/mail.ts.
 */
export const mailCompositionTables = {
	mailDrafts: defineTable({
		mailboxId: v.id('mailboxes'),
		// If editing a previous draft via IMAP APPEND to Drafts folder, link it
		linkedMessageId: v.optional(v.id('mailMessages')),
		// Reply context for threading on send
		inReplyToMessageId: v.optional(v.id('mailMessages')),
		threadId: v.optional(v.id('mailThreads')),

		toAddresses: v.array(v.string()),
		ccAddresses: v.array(v.string()),
		bccAddresses: v.array(v.string()),
		fromAddress: v.string(), // selected identity
		// Send-as choice for a shared (team) inbox. When set, the reply is sent
		// from one of the acting teammate's OWN personal mailboxes rather than the
		// team identity: `fromAddress` belongs to THIS mailbox, and the sent copy,
		// outbound transport, and allowed-from allow-set all resolve from it (not
		// the thread's `mailboxId`). Unset (the common case) ⇒ the team/own
		// identity — the classic path, unchanged. Only ever points at a personal
		// mailbox the sender owns; the dispatch re-check re-validates this.
		sendAsMailboxId: v.optional(v.id('mailboxes')),
		subject: v.string(),
		// Compose mode discriminator. 'simple' uses bodyHtml directly (Tiptap rich-text);
		// 'full' uses bodyBlocks (block-based EmailBuilder, JSON-serialized EditorBlock[]).
		composerMode: v.optional(v.union(v.literal('simple'), v.literal('full'))),
		bodyHtml: v.string(),
		bodyText: v.optional(v.string()),
		bodyBlocks: v.optional(v.string()), // JSON string of EditorBlock[]
		// Schema version for `bodyBlocks` JSON. Bump on EditorBlock shape change.
		bodyBlocksVersion: v.optional(v.number()),

		attachments: v.array(mailDraftAttachmentValidator),
		// Files the draft was opened to carry and owes until they are attached
		// (an RSVP's `.ics`, a forward's attachments). Send refuses while one is
		// owed. Absent on drafts that never owed one.
		expectedAttachments: v.optional(v.array(mailDraftExpectedAttachmentValidator)),

		// "Remind me if no reply by…" — carried onto the sent message's thread as
		// a follow-up watch by the sent-effects reducer (see mail/followUps.ts).
		followUpRemindAt: v.optional(v.number()),

		// Edit-learning flywheel: a snapshot of the AI's ORIGINAL draft text, taken
		// when the composer first applies an AI-generated draft. On send, the
		// sent-effects reducer diffs this baseline against what the user actually
		// sent and feeds the delta back into the voice profile / per-contact memory
		// (mail/ai/editLearning.ts). Absent → the draft was not AI-authored (or the
		// client did not record a baseline) → no learning happens, exactly today's
		// behaviour. Snapshotted ONCE and never overwritten.
		aiDraftBaseline: v.optional(v.object({ text: v.string(), capturedAt: v.number() })),
		// An AI text holding `[[...]]` gap placeholders went into this draft (a
		// Reply Queue draft waiting for files, say), or a saved reply with gaps
		// did. Such a draft has no Answer mode ask session, so this is what keeps
		// its send guard on after a reload (mail/ai/composeDraftStore.ts
		// assertNoAnswerGaps). Set by `drafts.update`; never cleared.
		isGapGuarded: v.optional(v.boolean()),

		// Team-inbox attribution: the BetterAuth user id of the teammate who fired
		// the send, stamped by `drafts.send` from the acting session. Copied onto
		// the resulting sent message + the thread's `latestReply` so a shared inbox
		// can attribute the reply. Undefined until send (and on legacy rows).
		sentByUserId: v.optional(v.string()),
		// Per-send explicit plaintext consent. Dispatch checks this again after
		// discovery/crypto so a trust change during the undo window fails closed.
		isUnsealedSendAllowed: v.optional(v.boolean()),

		// Idempotency key for offline-outbox replays: the queued outbox
		// item's client-generated id, threaded through `drafts.create` so a
		// drain retry after a lost response reuses the draft it already
		// created instead of forking a duplicate send.
		clientNonce: v.optional(v.string()),

		// Scheduled send / undo-send window
		scheduledSendAt: v.optional(v.number()),
		undoToken: v.optional(v.string()), // opaque cancel handle, returned to client
		state: v.union(
			v.literal('draft'), // user is composing
			v.literal('pending_send'), // in undo-send window
			v.literal('scheduled') // future scheduledSendAt
		),

		lastEditedAt: v.number(),
		createdAt: v.number(),
	})
		.index('by_mailbox', ['mailboxId'])
		.index('by_mailbox_and_edited', ['mailboxId', 'lastEditedAt'])
		.index('by_state_and_scheduled', ['state', 'scheduledSendAt'])
		.index('by_undo_token', ['undoToken'])
		.index('by_client_nonce', ['clientNonce']),

	// One row per compose request (the full-page composer's `?c=`): which draft
	// its creation nonce made. Kept after the draft itself is sent or
	// discarded, so a remount of the same request learns that its draft is gone
	// instead of creating a second one. Pruned after 14 days by `drafts.create`.
	mailDraftRequestNonces: defineTable({
		mailboxId: v.id('mailboxes'),
		requestNonce: v.string(),
		draftId: v.id('mailDrafts'),
		createdAt: v.number(),
	})
		.index('by_mailbox_and_nonce', ['mailboxId', 'requestNonce'])
		.index('by_mailbox_and_created', ['mailboxId', 'createdAt']),

	// Audit log of mailbox-level events (delivery, IMAP login, etc.)

	mailAttachments: defineTable({
		mailboxId: v.id('mailboxes'),
		messageId: v.id('mailMessages'),
		filename: v.string(),
		contentType: v.string(),
		size: v.number(),
		receivedAt: v.number(),
		// Denormalized sender, lowercased — the Files view's "From" facet.
		fromAddress: v.string(),
		folderId: v.optional(v.id('mailFolders')),
		// MIME part path, so the Files view can extract exactly the same part the
		// reader does (`extractAttachmentAt`).
		partIndex: v.string(),
	})
		// Teardown + "does this message already have rows?" (backfill idempotence).
		.index('by_message', ['messageId'])
		// The Files view's default listing: newest first across the mailbox.
		.index('by_mailbox_and_received', ['mailboxId', 'receivedAt'])
		// The "From" facet, newest first within one sender.
		.index('by_mailbox_and_from', ['mailboxId', 'fromAddress', 'receivedAt'])
		// What makes `filename:` an INDEXED narrowing rather than a post-filter.
		.searchIndex('search_filenames', {
			searchField: 'filename',
			filterFields: ['mailboxId'],
		}),

	// Attachment leaves of a received message, each stored as its OWN sealed
	// blob so the reader can download one part instead of the whole raw `.eml`
	// (plan 3.5). One row per RAW BLOB, not per message: IMAP COPY shares a raw
	// blob across rows, so its parts are shared too, and they are freed when the
	// raw blob is (`mail/messagePurge.deleteMessageRowAndBlobs`). Derived data,
	// written by MX delivery only: a message without a row (older mail, IMAP
	// sync, imports) falls back to extracting from the raw `.eml` client-side.
	mailMessageParts: defineTable(mailMessagePartsFields).index('by_raw_storage', ['rawStorageId']),

	// Resumable backfill of `mailAttachments` over mail that predates the index.
	//
	// One row per mailbox (found/replaced via `by_mailbox`), so a re-run resumes
	// or restarts rather than forking a second walk. The job pages
	// `mailMessages` by cursor and writes the junction rows for each page,
	// rescheduling itself — the same shape as `mail/labels.stripLabelReferences`,
	// with a row on top so the Files view can show progress and the user can
	// cancel a walk mid-flight.
	// The job columns are `mailboxJobFields`, shared with the body-search and
	// filter-run jobs; the start/cancel lifecycle is `mail/_jobLifecycle.ts`.

	mailAttachmentBackfillJobs: defineTable({
		mailboxId: v.id('mailboxes'),
		...mailboxJobFields,
		indexedCount: v.number(),
	}).index('by_mailbox', ['mailboxId']),

	// Resumable backfill of `mailMessages.searchBody` over mail that predates the
	// deep-search opt-in (idea 32). Same one-row-per-mailbox shape as
	// `mailAttachmentBackfillJobs` above, with two differences that matter:
	//
	//  - `mode` — an `index` walk WRITES excerpts; a `purge` walk CLEARS them. The
	//    purge is what makes the opt-out real: turning the instance switch off
	//    stops new writes AND removes the plaintext already stored. Only a
	//    `completed` `index` job opens the `search_message_bodies` read path
	//    (`mail/searchBody.isBodySearchIndexComplete`), so a completed purge can
	//    never be mistaken for a ready index.
	//  - the walk runs from an ACTION, not a mutation: a large body lives in a
	//    storage blob and blob contents are unreadable from a query/mutation.
	//    The action reads a page, does its blob reads, then commits; because the
	//    row is reused across restarts, `generation` ties each commit to the run
	//    that loaded it (`mail/bodySearchBackfill.commitBatch`).

	mailBodySearchBackfillJobs: defineTable({
		mailboxId: v.id('mailboxes'),
		mode: v.union(v.literal('index'), v.literal('purge')),
		...mailboxJobFields,
		/** Rows whose `searchBody` this walk actually wrote (or cleared). */
		indexedCount: v.number(),
		/** Bumped by every start, restart and opt-out. A batch commits only into
		 * the generation it was loaded for. MISSING = 0 (rows written before it). */
		generation: v.optional(v.number()),
		/** The scheduled `runBatch` that owns the next page, written in the same
		 * mutation that schedules it. A running job whose batch is no longer
		 * pending or in progress has stalled. MISSING = no lease recorded. */
		batchFunctionId: v.optional(v.id('_scheduled_functions')),
	}).index('by_mailbox', ['mailboxId']),

	// The instance-wide sweep that clears every `searchBody` when the operator
	// turns deep body search off (ADR-0059). Singleton. Unlike the per-mailbox
	// walks above it pages the whole `mailMessages` table, so it keeps its own
	// cursor, generation and lease: a newer opt-out supersedes an older sweep,
	// and a sweep whose page failed is visible as a dead lease and restartable
	// (`mail/_bodySearchLifecycle.beginSearchBodyPurge`).
	mailBodySearchPurges: defineTable({
		...mailboxJobFields,
		generation: v.number(),
		/** Rows whose `searchBody` this sweep cleared. */
		clearedCount: v.number(),
		batchFunctionId: v.optional(v.id('_scheduled_functions')),
	}),

	// Saved searches — a named, re-runnable Postbox query.
	//
	// `rawQuery` is the query STRING exactly as typed, not the parsed payload:
	// the grammar is the user's, the parser is free to grow (negation, OR, new
	// operators all landed after this table), and re-parsing on read means a
	// saved search picks up every parser fix instead of freezing the shape it
	// had on the day it was saved. It is also what the `?q=` URL carries, so a
	// saved search and a bookmarked one are the same thing.
	//
	// Mailbox-scoped, like labels and snippets: a query naming this mailbox's
	// folders and labels is meaningless in another one.

	mailAttachmentShares: defineTable({
		mailboxId: v.id('mailboxes'),
		// BetterAuth user id of the creator, so the management list is the acting
		// person's own links even inside a shared team mailbox.
		userId: v.string(),
		// The blob, while it still exists. Absent ⇒ reclaimed (revoked or swept).
		storageId: v.optional(v.id('_storage')),
		filename: v.string(),
		contentType: v.string(),
		size: v.number(),
		// The unguessable capability. 32 chars of the URL alphabet (192 bits) —
		// this IS the access control for an `anyone`-scoped link.
		token: v.string(),
		scope: mailAttachmentShareScopeValidator,
		// Provenance, for the list ("shared from this draft/message"). Optional
		// because the source row can be discarded or purged long before the link
		// lapses, and a dangling id must not strand the share.
		sourceDraftId: v.optional(v.id('mailDrafts')),
		sourceMessageId: v.optional(v.id('mailMessages')),
		expiresAt: v.number(),
		// Stamped by the owner's immediate revoke. Wins over `expiresAt` when both
		// are true: revocation is the deliberate fact and the list must say so.
		revokedAt: v.optional(v.number()),
		// Which malware-scan outcome allowed the share ('clean' | 'skipped').
		scanVerdict: mailAttachmentShareScanValidator,
		// Serving telemetry, so an owner can tell a link nobody used from one that
		// leaked. Incremented by the public route.
		downloadCount: v.number(),
		lastAccessedAt: v.optional(v.number()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		// The public serving route's only lookup.
		.index('by_token', ['token'])
		// The management list: this person's links inside one mailbox.
		.index('by_mailbox_user', ['mailboxId', 'userId'])
		// The expiry sweep walks rows in expiry order and stops at `now`, so a
		// tick's work is proportional to what actually lapsed, not to the table.
		.index('by_expiry', ['expiresAt']),

	// Bidirectional commitment / deadline tracking (Daily Brief). A commitment is
	// either a deadline SOMEONE GAVE the owner (`inbound` — "please send it by
	// Friday") or a promise the OWNER MADE in their own sent mail (`outbound` —
	// "I'll get the draft to you Friday"). Extraction is deterministic-gated then
	// cheap-tier-LLM-refined (mail/ai/commitmentExtract.ts), behind the same aiGate
	// as the rest of Postbox AI and fail-soft. The commitment-reminder cron
	// (mail/commitments.ts) surfaces an open commitment before its deadline —
	// arming the thread follow-up (mail/followUps.ts) so it floats into the Reply
	// Queue — and marks it `reminded` exactly once. Advisory only: this never
	// sends or modifies mail.

	mailSignatures: defineTable({
		mailboxId: v.id('mailboxes'),
		name: v.string(),
		html: v.string(),
		isDefault: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_mailbox', ['mailboxId'])
		.index('by_mailbox_and_default', ['mailboxId', 'isDefault']),

	// Saved replies (the table keeps its first name, "snippets"). Inserted into
	// a draft or a Team inbox reply from the composer's `;` trigger or its
	// picker. `bodyHtml` is stored post-sanitize (same allowlist as signatures)
	// and may carry plain-text {{contact.firstName}}-style tokens and free
	// `[[...]]` gaps, both resolved at insert time (mail/savedReplies.ts).
	//
	// `scope` decides who sees a row: 'personal' ⇒ only `ownerUserId`;
	// 'shared' ⇒ every member of `organizationId`, or only the composers of
	// the team inboxes in `mailboxIds` when that is set; editable by admins.
	// Unset ⇒ a row written before saved replies, scoped to its `mailboxId`;
	// migration 0060 gives each one a scope. Member erasure deletes a
	// member's personal rows and clears `authorUserId` on shared ones.

	mailSnippets: defineTable({
		// Set on rows written before saved replies (and kept on them); unset on
		// rows that belong to a person or the organization instead.
		mailboxId: v.optional(v.id('mailboxes')),
		organizationId: v.optional(v.string()),
		scope: v.optional(v.union(v.literal('personal'), v.literal('shared'))),
		ownerUserId: v.optional(v.string()),
		authorUserId: v.optional(v.string()),
		mailboxIds: v.optional(v.array(v.id('mailboxes'))),
		// AGGREGATED — bumped by mail/savedReplies.ts:recordUse on every insert.
		useCount: v.optional(v.number()),
		lastUsedAt: v.optional(v.number()),
		name: v.string(),
		shortcut: v.string(),
		bodyHtml: v.string(),
		// Typed variables the composer resolves at insertion:
		// recipient facts, the sender identity, the date, or a prompt-on-insert
		// question. Optional so existing rows read as undefined — an undeclared
		// token still resolves through the client's implicit name table, so
		// absent = exactly today's `{{firstName}}` behaviour.
		variables: v.optional(v.array(mailSnippetVariableValidator)),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_mailbox', ['mailboxId'])
		.index('by_owner', ['ownerUserId'])
		.index('by_author', ['authorUserId'])
		.index('by_organization_and_scope', ['organizationId', 'scope']),

	// Per-user Postbox behavior preferences (one row per BetterAuth user,
	// spanning all of the user's mailboxes). Currently: what the reader does
	// after triaging (archive/trash/snooze/spam) the open message.
};
