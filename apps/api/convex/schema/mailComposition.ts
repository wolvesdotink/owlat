import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { mailJobStatusValidator } from '../lib/literalValidators';
import {
	mailAttachmentShareScanValidator,
	mailAttachmentShareScopeValidator,
	mailDraftAttachmentValidator,
	mailSnippetVariableValidator,
} from '../lib/mailContentValidators';

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
		.index('by_scheduled', ['scheduledSendAt'])
		.index('by_state_and_scheduled', ['state', 'scheduledSendAt'])
		.index('by_undo_token', ['undoToken'])
		.index('by_client_nonce', ['clientNonce']),

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

	// Resumable backfill of `mailAttachments` over mail that predates the index.
	//
	// One row per mailbox (found/replaced via `by_mailbox`), so a re-run resumes
	// or restarts rather than forking a second walk. The job pages
	// `mailMessages` by cursor and writes the junction rows for each page,
	// rescheduling itself — the same shape as `mail/labels.stripLabelReferences`,
	// with a row on top so the Files view can show progress and the user can
	// cancel a walk mid-flight.

	mailAttachmentBackfillJobs: defineTable({
		mailboxId: v.id('mailboxes'),
		status: mailJobStatusValidator,
		// Resumable pagination cursor over `mailMessages` (Convex continueCursor).
		cursor: v.optional(v.string()),
		scannedCount: v.number(),
		indexedCount: v.number(),
		startedAt: v.number(),
		updatedAt: v.number(),
		finishedAt: v.optional(v.number()),
		errorMessage: v.optional(v.string()),
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

	mailBodySearchBackfillJobs: defineTable({
		mailboxId: v.id('mailboxes'),
		mode: v.union(v.literal('index'), v.literal('purge')),
		status: mailJobStatusValidator,
		// Resumable pagination cursor over `mailMessages` (Convex continueCursor).
		cursor: v.optional(v.string()),
		scannedCount: v.number(),
		/** Rows whose `searchBody` this walk actually wrote (or cleared). */
		indexedCount: v.number(),
		startedAt: v.number(),
		updatedAt: v.number(),
		finishedAt: v.optional(v.number()),
		errorMessage: v.optional(v.string()),
	}).index('by_mailbox', ['mailboxId']),

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

	// Per-mailbox canned responses ("snippets"). Inserted into a draft via the
	// composer's "/" slash-trigger. `bodyHtml` is stored post-sanitize (same
	// allowlist as signatures) and may carry plain-text {{firstName}}-style
	// placeholder tokens resolved at insert time from the draft's recipient.

	mailSnippets: defineTable({
		mailboxId: v.id('mailboxes'),
		name: v.string(),
		shortcut: v.string(),
		bodyHtml: v.string(),
		// Typed variables the composer resolves at insertion (plan idea 13):
		// recipient facts, the sender identity, the date, or a prompt-on-insert
		// question. Optional so existing rows read as undefined — an undeclared
		// token still resolves through the client's implicit name table, so
		// absent = exactly today's `{{firstName}}` behaviour.
		variables: v.optional(v.array(mailSnippetVariableValidator)),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_mailbox', ['mailboxId'])
		.index('by_mailbox_and_shortcut', ['mailboxId', 'shortcut']),

	// Per-user Postbox behavior preferences (one row per BetterAuth user,
	// spanning all of the user's mailboxes). Currently: what the reader does
	// after triaging (archive/trash/snooze/spam) the open message.
};
