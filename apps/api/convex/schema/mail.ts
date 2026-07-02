import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	mailMessageAttachmentValidator,
	mailDraftAttachmentValidator,
	mailAutoAdvanceValidator,
	mailUnsubscribeValidator,
	spamVerdictValidator,
} from '../lib/convexValidators';

/**
 * Personal Mail (Postbox) tables — Gmail-equivalent backend.
 *
 * Distinct from `inboundMessages`/`conversationThreads` which power the
 * AI-assisted shared support inbox (defined in schema.ts).
 *
 * Spread into `defineSchema()` from schema.ts via `...mailTables`.
 */
export const mailTables = {
// ============================================================
// Personal Mail (Postbox) Tables — Gmail-equivalent backend
// Distinct from `inboundMessages`/`conversationThreads` which
// power the AI-assisted shared support inbox.
// ============================================================

// Reserved-mailbox intent attached to a BetterAuth invitation. Admins
// can pre-pick `localpart@verifiedDomain` at invite time; the row is
// consumed (`claimForInvitation`) when the invitee accepts and we
// finally have their `userId`.
pendingMailboxes: defineTable({
	invitationId: v.string(),                 // BetterAuth invitation ID
	inviteeEmail: v.string(),                 // canonical lowercase — claim is bound to this identity
	organizationId: v.string(),
	localpart: v.string(),                    // canonical lowercase
	domain: v.string(),                       // verified domain at invite time
	address: v.string(),                      // canonical "${localpart}@${domain}"
	displayName: v.optional(v.string()),
	createdAt: v.number(),
	createdByUserId: v.string(),              // inviter — audit only
})
	.index('by_invitation', ['invitationId'])
	.index('by_address', ['address']),

// Per-user mailbox identity (e.g. marcel@hinterland.camp).
// One BetterAuth user can own multiple mailboxes.
mailboxes: defineTable({
	userId: v.string(),                       // BetterAuth user ID (owner)
	organizationId: v.string(),
	address: v.string(),                      // canonical lowercase
	domain: v.string(),                       // domain part for filtering
	displayName: v.optional(v.string()),
	// Transport discriminator. undefined ⇒ 'hosted' (Owlat-hosted mailbox;
	// back-compat for pre-external rows). 'external' ⇒ backed by a
	// user-connected IMAP/SMTP account (see externalMailAccounts).
	kind: v.optional(v.union(v.literal('hosted'), v.literal('external'))),
	// Set when kind='external'; links to the connection/credentials row.
	externalAccountId: v.optional(v.id('externalMailAccounts')),
	status: v.union(
		v.literal('active'),
		v.literal('suspended'),
		v.literal('deleted')
	),
	quotaBytes: v.optional(v.number()),       // null = unlimited (always unset for external)
	usedBytes: v.number(),
	uidValidity: v.number(),                  // initialized to Date.now()
	createdAt: v.number(),
	updatedAt: v.number(),
})
	.index('by_address', ['address'])
	.index('by_user', ['userId'])
	.index('by_domain', ['domain'])
	.index('by_status', ['status']),

// External mailbox connection (BYO IMAP/SMTP). Per-user link to an EXISTING
// external mailbox (Gmail, Fastmail, a company server). 1:1 with a `mailboxes`
// row whose kind='external'. Credentials are encrypted at rest (AES-256-GCM);
// read queries NEVER return the ciphertext/iv/tag — only the mail-sync worker
// (which holds INSTANCE_SECRET) decrypts. The envelope shape is versioned by
// CURRENT_EXTERNAL_MAIL_CRED_VERSION in lib/constants.ts.
externalMailAccounts: defineTable({
	userId: v.string(),                       // BetterAuth user (owner)
	organizationId: v.string(),
	mailboxId: v.id('mailboxes'),             // the reused inbox identity

	// IMAP (receive). isImapSecure=true ⇒ implicit TLS (993); false ⇒ STARTTLS (143).
	imapHost: v.string(),
	imapPort: v.number(),
	isImapSecure: v.boolean(),
	// SMTP (send). isSmtpSecure=true ⇒ implicit TLS (465); false ⇒ STARTTLS (587).
	smtpHost: v.string(),
	smtpPort: v.number(),
	isSmtpSecure: v.boolean(),

	// Auth. Most providers share one login across IMAP+SMTP; smtpUsername is
	// optional and defaults to imapUsername when unset. Only password auth is
	// supported today (providers connect via an IMAP/SMTP app password); there is
	// no OAuth2 connect/token-refresh/XOAUTH2 path, so the enum stays a single
	// literal rather than carrying an unreachable 'oauth2' branch.
	authMethod: v.literal('password'),
	imapUsername: v.string(),
	smtpUsername: v.optional(v.string()),

	// Encrypted credential envelope (AES-256-GCM). The plaintext is a JSON blob
	// ({ imapPassword, smtpPassword? }); these fields hold its ciphertext/iv/tag.
	// secretEnvelopeVersion pairs the blob per the CONVENTIONS.md versioning rule.
	secretCiphertext: v.string(),
	secretIv: v.string(),
	secretAuthTag: v.string(),
	secretEnvelopeVersion: v.number(),

	// Connection/sync status — the mail-sync worker is the writer.
	status: v.union(
		v.literal('pending'),                 // created; worker not yet connected
		v.literal('connected'),               // IMAP IDLE live
		v.literal('auth_error'),              // bad credentials — needs user fix
		v.literal('error'),                   // transient/connection error (backoff)
		v.literal('disconnected')             // user paused / removed
	),
	lastError: v.optional(v.string()),
	lastErrorAt: v.optional(v.number()),
	lastConnectedAt: v.optional(v.number()),
	lastSyncAt: v.optional(v.number()),

	createdAt: v.number(),
	updatedAt: v.number(),
})
	.index('by_user', ['userId'])
	.index('by_mailbox', ['mailboxId'])
	.index('by_status', ['status']),

// Per-(account, folder) IMAP sync cursor. Separate from mailFolders' own
// uidValidity/uidNext (those track Owlat-as-IMAP-server); these track
// Owlat-as-IMAP-client of the remote server, for incremental UID fetch.
externalMailFolderSync: defineTable({
	accountId: v.id('externalMailAccounts'),
	mailboxId: v.id('mailboxes'),
	folderId: v.id('mailFolders'),            // local folder this remote maps to
	remoteName: v.string(),                   // e.g. "INBOX", "[Gmail]/Sent Mail"
	remoteUidValidity: v.number(),            // remote UIDVALIDITY (resync on change)
	lastSeenUid: v.number(),                  // incremental (forward) fetch = lastSeenUid+1:*
	lastSeenModseq: v.optional(v.number()),   // CONDSTORE fast-resync, if supported
	lastSyncedAt: v.number(),

	// ── Historical backfill (migration) ──────────────────────────────────
	// Forward sync (lastSeenUid) only ever pulls NEW mail. A migration
	// (see `mailboxMigrations`) walks the OLD mail too, descending from the
	// high-water mark to UID 1. `backfillCursor` is the highest remote UID
	// NOT yet backfilled (the worker fetches `[cursor-batch+1 : cursor]` then
	// drops the cursor): undefined = backfill not initialized for this folder;
	// 0 = this folder's history is fully imported.
	backfillCursor: v.optional(v.number()),
	// Snapshot of the folder's high-water UID at backfill start (≈ message
	// count) — the import progress-bar denominator for this folder.
	backfillTotal: v.optional(v.number()),
	// Messages backfilled from this folder so far (numerator).
	backfillDone: v.optional(v.number()),
})
	.index('by_account', ['accountId'])
	.index('by_account_and_remote', ['accountId', 'remoteName'])
	.index('by_folder', ['folderId']),

// Mailbox migration job — a one-time historical import of a connected
// external mailbox (e.g. "Migrate from Google"). 1:1 with an
// `externalMailAccounts` row. Two phases the worker + a Convex sweep drive:
//   importing  — the mail-sync worker backfills historical mail into Postbox
//                (per-folder cursors on externalMailFolderSync).
//   indexing   — a chunked sweep feeds the imported messages into the
//                contact-scoped knowledge graph so the AI learns from them.
// Both `messages*` counters are AGGREGATED — written only by the worker
// (import) and the indexer (index); user-facing mutations must not touch them.
mailboxMigrations: defineTable({
	userId: v.string(),                       // BetterAuth user (owner)
	organizationId: v.string(),
	accountId: v.id('externalMailAccounts'),
	mailboxId: v.id('mailboxes'),
	// Provider label — drives wizard copy only ("Migrate from Google").
	source: v.union(v.literal('google'), v.literal('imap')),
	status: v.union(
		v.literal('importing'),               // worker backfilling historical mail
		v.literal('indexing'),                // import done; AI knowledge sweep running
		v.literal('completed'),
		v.literal('failed'),
		v.literal('cancelled'),
	),
	// Feed imported mail into the knowledge graph (requires `ai.knowledge`).
	isAiIndexingEnabled: v.boolean(),

	// AGGREGATED — progress counters.
	messagesTotal: v.number(),                // Σ per-folder backfillTotal (import denominator)
	messagesImported: v.number(),             // Σ per-folder backfillDone (import numerator)
	messagesIndexed: v.number(),              // messages swept into the knowledge graph

	// Index-sweep cursor over mailMessages (mirrors knowledgeBackfill).
	indexCursorReceivedAt: v.optional(v.number()),
	indexCursorId: v.optional(v.id('mailMessages')),

	lastError: v.optional(v.string()),
	startedAt: v.number(),
	importCompletedAt: v.optional(v.number()),
	completedAt: v.optional(v.number()),
	updatedAt: v.number(),
})
	// Every read resolves the migration through its account (1:1). by_mailbox/
	// by_user/by_status/by_started_at were unused — add one back when a concrete
	// query (e.g. an ops sweep) needs it.
	.index('by_account', ['accountId']),

// IMAP-visible folders. System folders carry a `role`; user folders
// have role=undefined and arbitrary names.
mailFolders: defineTable({
	mailboxId: v.id('mailboxes'),
	name: v.string(),
	role: v.optional(v.union(
		v.literal('inbox'),
		v.literal('sent'),
		v.literal('drafts'),
		v.literal('trash'),
		v.literal('spam'),
		v.literal('archive')
	)),
	parentId: v.optional(v.id('mailFolders')),
	uidValidity: v.number(),
	uidNext: v.number(),
	highestModseq: v.number(),
	totalCount: v.number(),
	unseenCount: v.number(),
	subscribed: v.boolean(),
	createdAt: v.number(),
	updatedAt: v.number(),
})
	.index('by_mailbox', ['mailboxId'])
	.index('by_mailbox_and_name', ['mailboxId', 'name'])
	.index('by_mailbox_and_role', ['mailboxId', 'role']),

// Core mail message envelope. Body in ctx.storage as raw RFC822.
mailMessages: defineTable({
	mailboxId: v.id('mailboxes'),
	folderId: v.id('mailFolders'),
	uid: v.number(),
	modseq: v.number(),

	// RFC 5322 envelope (parsed once at delivery)
	rfc822MessageId: v.string(),
	inReplyTo: v.optional(v.string()),
	references: v.optional(v.array(v.string())),
	threadId: v.id('mailThreads'),

	fromAddress: v.string(),
	fromName: v.optional(v.string()),
	toAddresses: v.array(v.string()),
	ccAddresses: v.array(v.string()),
	bccAddresses: v.array(v.string()),
	replyToAddress: v.optional(v.string()),
	subject: v.string(),
	normalizedSubject: v.string(),
	snippet: v.string(),

	// Storage refs
	rawStorageId: v.id('_storage'),
	rawSize: v.number(),
	textBodyStorageId: v.optional(v.id('_storage')),
	textBodyInline: v.optional(v.string()),
	htmlBodyStorageId: v.optional(v.id('_storage')),
	htmlBodyInline: v.optional(v.string()),

	// Attachments (content stays inside the raw .eml; we only store metadata)
	attachments: v.array(mailMessageAttachmentValidator),
	hasAttachments: v.boolean(),

	// IMAP flags
	flagSeen: v.boolean(),
	flagFlagged: v.boolean(),
	flagAnswered: v.boolean(),
	flagDraft: v.boolean(),
	flagDeleted: v.boolean(),
	customFlags: v.array(v.string()),
	labelIds: v.array(v.id('mailLabels')),

	// Snooze (P8): hides the message from the inbox until the timestamp
	// passes; a 1-min cron sweep returns it (and bumps the thread
	// `lastMessageAt` so the inbox sort floats it back to the top).
	snoozedUntil: v.optional(v.number()),
	// Folder the message snoozed FROM, so the wakeup cron knows where
	// to put it back.
	snoozedFromFolderId: v.optional(v.id('mailFolders')),

	// List mail: parsed List-Unsubscribe / List-Unsubscribe-Post target
	// (RFC 2369 / RFC 8058), extracted once at ingest from the raw header
	// block. Absent for non-list mail — the reader's Unsubscribe chip keys
	// off this field's presence.
	unsubscribe: v.optional(mailUnsubscribeValidator),

	// Delivery/security metadata
	receivedAt: v.number(),
	internalDate: v.number(),
	spamScore: v.optional(v.number()),
	spamVerdict: v.optional(spamVerdictValidator),
	virusVerdict: v.optional(v.union(v.literal('clean'), v.literal('infected'), v.literal('skipped'))),
	spfResult: v.optional(v.string()),
	dkimResult: v.optional(v.string()),
	dmarcResult: v.optional(v.string()),
	// Published DMARC policy that applied to this message (`none`/`quarantine`/
	// `reject`). Recorded alongside `dmarcResult` so the Spam-routing decision
	// (a quarantine/reject fail → Spam) and the UI banner can distinguish a
	// monitor-only `p=none` fail from one the domain owner asked us to act on.
	dmarcPolicy: v.optional(v.string()),

	// Outbound tracking (sent path). Per-recipient state lives in
	// `recipients[]`; `state` is a denormalized aggregate derived by
	// the Postbox outbound lifecycle module (the only writer). See
	// docs/adr/0012-postbox-outbound-lifecycle-module.md.
	outbound: v.optional(v.object({
		// AGGREGATED — derived from recipients[] by the lifecycle module.
		// `partial` is the only literal that exists here but not on a
		// per-recipient entry; it covers any mix of recipient states.
		state: v.union(
			v.literal('queued'),
			v.literal('sent'),
			v.literal('bounced'),
			v.literal('failed'),
			v.literal('partial'),
		),
		recipients: v.array(v.object({
			// 0-based position in the deduplicated To+Cc+Bcc list at
			// dispatch time. Stable across the row's lifetime.
			idx: v.number(),
			// Recipient email — metadata; not unique on the row (To+Cc
			// can collide on the same address).
			address: v.string(),
			// Deterministic from `idx`: `pb-<mailMessageId>-<idx>`.
			mtaJobId: v.string(),
			state: v.union(
				v.literal('queued'),
				v.literal('sent'),
				v.literal('bounced'),
				v.literal('failed'),
			),
			sentAt: v.optional(v.number()),
			bounceMessage: v.optional(v.string()),
			errorCode: v.optional(v.string()),
		})),
	})),

	createdAt: v.number(),
	updatedAt: v.number(),
})
	.index('by_folder_and_uid', ['folderId', 'uid'])
	// Smallest-UID unseen message per folder for IMAP `* OK [UNSEEN]` — an O(1)
	// indexed `first()` instead of collecting + sorting the whole folder.
	.index('by_folder_and_seen', ['folderId', 'flagSeen', 'uid'])
	.index('by_folder_and_modseq', ['folderId', 'modseq'])
	.index('by_mailbox_and_received', ['mailboxId', 'receivedAt'])
	// Folder-scoped arrival order — backs the per-folder list page directly (no
	// mailbox-wide overfetch-then-filter that starved minority folders).
	.index('by_folder_and_received', ['folderId', 'receivedAt'])
	// Mailbox-scoped snooze range — backs the "Snoozed" view without scanning
	// the whole mailbox.
	.index('by_mailbox_and_snoozed', ['mailboxId', 'snoozedUntil'])
	.index('by_thread', ['threadId'])
	.index('by_rfc822_message_id', ['rfc822MessageId'])
	.index('by_mailbox_and_from', ['mailboxId', 'fromAddress'])
	.index('by_mailbox_and_unseen', ['mailboxId', 'flagSeen'])
	// Backs the 1-minute snooze sweep cron — range scan on snoozedUntil <= now.
	.index('by_snoozed_until', ['snoozedUntil'])
	.searchIndex('search_messages', {
		searchField: 'snippet',
		filterFields: ['mailboxId', 'folderId', 'fromAddress', 'flagSeen', 'flagFlagged'],
	}),

// Conversation grouping across folders. Aggregates updated by mutations.
mailThreads: defineTable({
	mailboxId: v.id('mailboxes'),
	normalizedSubject: v.string(),
	participants: v.array(v.string()),
	messageCount: v.number(),
	unreadCount: v.number(),
	hasFlagged: v.boolean(),
	hasAttachments: v.boolean(),
	lastMessageAt: v.number(),
	firstMessageAt: v.number(),
	latestSnippet: v.string(),
	latestFromAddress: v.string(),
	latestSubject: v.string(),
	// Newest message in the thread — the row a conversation list links to.
	latestMessageId: v.optional(v.id('mailMessages')),
	folderRoles: v.array(v.string()),
	labelIds: v.array(v.id('mailLabels')),
	createdAt: v.number(),
	updatedAt: v.number(),
})
	.index('by_mailbox_and_last_message', ['mailboxId', 'lastMessageAt'])
	.index('by_mailbox_and_subject', ['mailboxId', 'normalizedSubject']),

// Gmail-style labels (orthogonal to folders).
mailLabels: defineTable({
	mailboxId: v.id('mailboxes'),
	name: v.string(),
	color: v.optional(v.string()),
	createdAt: v.number(),
})
	.index('by_mailbox', ['mailboxId'])
	.index('by_mailbox_and_name', ['mailboxId', 'name']),

// Compose drafts. Live separately from mailMessages so autosaves don't
// pollute the Drafts folder IMAP view. On Send, the draft is finalized
// into mailMessages (Sent folder) and the draft row is deleted.
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
	fromAddress: v.string(),                  // selected identity
	subject: v.string(),
	// Compose mode discriminator. 'simple' uses bodyHtml directly (Tiptap rich-text);
	// 'full' uses bodyBlocks (block-based EmailBuilder, JSON-serialized EditorBlock[]).
	composerMode: v.optional(v.union(v.literal('simple'), v.literal('full'))),
	bodyHtml: v.string(),
	bodyText: v.optional(v.string()),
	bodyBlocks: v.optional(v.string()),       // JSON string of EditorBlock[]
	// Schema version for `bodyBlocks` JSON. Bump on EditorBlock shape change.
	bodyBlocksVersion: v.optional(v.number()),

	attachments: v.array(mailDraftAttachmentValidator),

	// Scheduled send / undo-send window
	scheduledSendAt: v.optional(v.number()),
	undoToken: v.optional(v.string()),        // opaque cancel handle, returned to client
	state: v.union(
		v.literal('draft'),                    // user is composing
		v.literal('pending_send'),             // in undo-send window
		v.literal('scheduled')                  // future scheduledSendAt
	),

	lastEditedAt: v.number(),
	createdAt: v.number(),
})
	.index('by_mailbox', ['mailboxId'])
	.index('by_mailbox_and_edited', ['mailboxId', 'lastEditedAt'])
	.index('by_scheduled', ['scheduledSendAt'])
	.index('by_state_and_scheduled', ['state', 'scheduledSendAt'])
	.index('by_undo_token', ['undoToken']),

// Audit log of mailbox-level events (delivery, IMAP login, etc.)
mailAuditLog: defineTable({
	mailboxId: v.id('mailboxes'),
	event: v.string(),
	details: v.optional(v.string()),
	ip: v.optional(v.string()),
	userAgent: v.optional(v.string()),
	occurredAt: v.number(),
})
	.index('by_mailbox_and_time', ['mailboxId', 'occurredAt']),

// App passwords for native IMAP/SMTP clients (Apple Mail, Thunderbird, …)
// The cleartext password is shown ONCE at creation and never recoverable.
// The first 4 chars are stored separately so the resolver can narrow to a
// small candidate set before running the (intentionally slow) hash compare.
mailAppPasswords: defineTable({
	mailboxId: v.id('mailboxes'),
	userId: v.string(),
	label: v.string(),                       // e.g. "iPhone Mail", "Thunderbird"
	passwordHash: v.string(),                // PBKDF2-SHA256 derived; encoded as <salt-hex>:<hash-hex>
	passwordPrefix: v.string(),              // first 4 chars, lowercase
	scopes: v.array(
		v.union(v.literal('imap'), v.literal('smtp'))
	),
	createdAt: v.number(),
	lastUsedAt: v.optional(v.number()),
	lastUsedIp: v.optional(v.string()),
	lastUsedUa: v.optional(v.string()),
	revokedAt: v.optional(v.number()),
})
	.index('by_mailbox', ['mailboxId'])
	.index('by_user', ['userId'])
	.index('by_prefix', ['passwordPrefix']),

// Sliding-window auth-failure log. Backs the SMTP submission rate limit
// (the IMAP path uses Redis for lower latency). A cron sweeps entries
// older than 24h. Index by lowercase address + occurredAt so the
// throttle check is a single range scan.
mailAuthFailures: defineTable({
	address: v.string(),                       // lowercase canonical
	ip: v.optional(v.string()),
	scope: v.union(v.literal('imap'), v.literal('smtp')),
	occurredAt: v.number(),
})
	.index('by_address_and_time', ['address', 'occurredAt'])
	.index('by_ip_and_time', ['ip', 'occurredAt'])
	.index('by_time', ['occurredAt']),

// Sieve-style filters that run on inbound mail before final folder
// placement. Conditions are AND'd; multiple filters can match (priority
// ascending) unless a matching filter sets stopProcessing=true.
mailFilters: defineTable({
	mailboxId: v.id('mailboxes'),
	name: v.string(),
	isEnabled: v.boolean(),
	priority: v.number(),                     // lower number runs first
	conditions: v.array(
		v.object({
			field: v.union(
				v.literal('from'),
				v.literal('to'),
				v.literal('cc'),
				v.literal('subject'),
				v.literal('body'),
				v.literal('header'),
				v.literal('size'),
				v.literal('hasAttachment')
			),
			headerName: v.optional(v.string()),
			op: v.union(
				v.literal('contains'),
				v.literal('notContains'),
				v.literal('equals'),
				v.literal('matches'),
				v.literal('greaterThan'),
				v.literal('lessThan'),
				v.literal('isTrue')
			),
			value: v.optional(v.string()),
			valueNumber: v.optional(v.number()),
		})
	),
	actions: v.array(
		v.object({
			type: v.union(
				v.literal('moveToFolder'),
				v.literal('addLabel'),
				v.literal('markRead'),
				v.literal('markFlagged'),
				v.literal('forward'),
				v.literal('delete'),
				v.literal('discard')
			),
			folderId: v.optional(v.id('mailFolders')),
			labelId: v.optional(v.id('mailLabels')),
			forwardTo: v.optional(v.string()),
		})
	),
	stopProcessing: v.boolean(),
	createdAt: v.number(),
	updatedAt: v.number(),
})
	.index('by_mailbox', ['mailboxId'])
	.index('by_mailbox_and_priority', ['mailboxId', 'priority']),

// Aliases — alternate addresses (e.g. marcel+sales@hl.camp) that
// deliver into the same mailbox. Cheap rewrites at the MX layer.
mailAliases: defineTable({
	alias: v.string(),                        // canonical lowercase
	targetMailboxId: v.id('mailboxes'),
	organizationId: v.string(),
	createdAt: v.number(),
})
	.index('by_alias', ['alias'])
	.index('by_target', ['targetMailboxId']),

// External-forwarding rule. On delivery the message is forwarded to
// `forwardTo`; if `keepLocalCopy=false`, the local insert is skipped.
mailForwarding: defineTable({
	mailboxId: v.id('mailboxes'),
	forwardTo: v.string(),
	keepLocalCopy: v.boolean(),
	isEnabled: v.boolean(),
	createdAt: v.number(),
	updatedAt: v.number(),
})
	.index('by_mailbox', ['mailboxId']),

// RFC 3834-compliant vacation auto-responder.
mailVacationResponders: defineTable({
	mailboxId: v.id('mailboxes'),
	isEnabled: v.boolean(),
	subject: v.string(),
	bodyText: v.string(),
	bodyHtml: v.optional(v.string()),
	startAt: v.optional(v.number()),
	endAt: v.optional(v.number()),
	replyIntervalDays: v.number(),            // anti-loop: max once-per-N-days per sender
	createdAt: v.number(),
	updatedAt: v.number(),
})
	.index('by_mailbox', ['mailboxId']),

// Per-(mailbox, sender) record so the responder doesn't reply to the
// same person more than once within `replyIntervalDays`.
mailVacationLog: defineTable({
	mailboxId: v.id('mailboxes'),
	senderEmail: v.string(),
	repliedAt: v.number(),
})
	.index('by_mailbox_and_sender', ['mailboxId', 'senderEmail'])
	.index('by_replied_at', ['repliedAt']),

// Personal address book — distinct from CRM `contacts` (which is
// org-shared). Auto-populated as the user composes / replies, and
// surfaceable in the To/Cc/Bcc autocomplete.
mailContacts: defineTable({
	mailboxId: v.id('mailboxes'),
	email: v.string(),                        // canonical lowercase
	displayName: v.optional(v.string()),
	organization: v.optional(v.string()),
	// Frecency proxy — bumped each time the user sends to this address.
	// Used to rank autocomplete suggestions.
	useCount: v.number(),
	lastUsedAt: v.number(),
	createdAt: v.number(),
})
	.index('by_mailbox_and_email', ['mailboxId', 'email'])
	.index('by_mailbox_and_lastUsed', ['mailboxId', 'lastUsedAt']),

// Per-mailbox signatures. Default-on-new-draft when isDefault=true.
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

// Per-user Postbox behavior preferences (one row per BetterAuth user,
// spanning all of the user's mailboxes). Currently: what the reader does
// after triaging (archive/trash/snooze/spam) the open message.
mailUserSettings: defineTable({
	userId: v.string(),                       // BetterAuth user ID (owner)
	autoAdvance: mailAutoAdvanceValidator,
	createdAt: v.number(),
	updatedAt: v.number(),
})
	.index('by_user', ['userId']),
};
