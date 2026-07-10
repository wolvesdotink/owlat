import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	mailMessageAttachmentValidator,
	mailDraftAttachmentValidator,
	mailAutoAdvanceValidator,
	mailReplyDefaultValidator,
	mailDensityValidator,
	mailViewModeValidator,
	mailInboxModeValidator,
	mailNotifyAboutValidator,
	mailUnsubscribeValidator,
	spamVerdictValidator,
	draftQualityValidator,
} from '../lib/convexValidators';
import { editAdjustmentValidator } from '../mail/editLearningValidators';

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
		invitationId: v.string(), // BetterAuth invitation ID
		inviteeEmail: v.string(), // canonical lowercase — claim is bound to this identity
		organizationId: v.string(),
		localpart: v.string(), // canonical lowercase
		domain: v.string(), // verified domain at invite time
		address: v.string(), // canonical "${localpart}@${domain}"
		displayName: v.optional(v.string()),
		createdAt: v.number(),
		createdByUserId: v.string(), // inviter — audit only
	})
		.index('by_invitation', ['invitationId'])
		.index('by_address', ['address'])
		// Look up an invitee's reservation by their email at first login (the
		// fresh-start welcome shows "your mailbox X is reserved — claim it").
		.index('by_invitee_email', ['inviteeEmail']),

	// Per-user mailbox identity (e.g. marcel@hinterland.camp).
	// One BetterAuth user can own multiple mailboxes.
	mailboxes: defineTable({
		userId: v.string(), // BetterAuth user ID (owner)
		organizationId: v.string(),
		address: v.string(), // canonical lowercase
		domain: v.string(), // domain part for filtering
		displayName: v.optional(v.string()),
		// Sharing model. undefined ⇒ 'personal' (a single user's mailbox;
		// back-compat for all pre-shared-inbox rows). 'shared' ⇒ a team inbox
		// whose access is governed by explicit `mailboxMembers` rows rather than
		// by the owning `userId` alone. NOTE: distinct from `kind` below, which
		// discriminates the *transport* (hosted vs external), not the sharing
		// model — the two are orthogonal.
		scope: v.optional(v.union(v.literal('personal'), v.literal('shared'))),
		// Transport discriminator. undefined ⇒ 'hosted' (Owlat-hosted mailbox;
		// back-compat for pre-external rows). 'external' ⇒ backed by a
		// user-connected IMAP/SMTP account (see externalMailAccounts).
		kind: v.optional(v.union(v.literal('hosted'), v.literal('external'))),
		// Set when kind='external'; links to the connection/credentials row.
		externalAccountId: v.optional(v.id('externalMailAccounts')),
		// Outbound transport preference for an EXTERNAL mailbox (ignored for
		// hosted mailboxes). undefined ⇒ 'external' — send through the user's own
		// SMTP via the mail-sync worker, the natural default after an import.
		// 'instance' ⇒ route outbound through this deployment's transport (the MTA
		// / SES the instance is configured with) so mail from an already-imported
		// mailbox ships from Owlat's reputation. Reversible any time under Postbox
		// settings → Sending. Switching to 'instance' is gated: the from-domain
		// must be a VERIFIED sending domain on the instance (DKIM alignment) AND
		// an instance transport must be configured — enforced in
		// mail/sendingSwitch.ts::setSendingPreference, never assumed here.
		outboundPreference: v.optional(v.union(v.literal('external'), v.literal('instance'))),
		status: v.union(v.literal('active'), v.literal('suspended'), v.literal('deleted')),
		quotaBytes: v.optional(v.number()), // null = unlimited (always unset for external)
		usedBytes: v.number(),
		uidValidity: v.number(), // initialized to Date.now()
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_address', ['address'])
		.index('by_user', ['userId'])
		.index('by_domain', ['domain'])
		.index('by_status', ['status']),

	// Explicit membership on a mailbox — the access-control source of truth for
	// shared (team) inboxes. A personal mailbox carries exactly one row: an
	// 'owner' membership for its `mailboxes.userId` (created by the backfill in
	// migrations/0034 and, going forward, at provision time). A shared mailbox
	// adds 'member' (and further 'owner') rows for the teammates who may use it.
	//
	// Org membership alone grants nothing here — access is either org
	// owner/admin acting on behalf, the mailbox's own `userId`, or an explicit
	// row in this table (see mail/permissions.ts::requireMailboxAccess).
	//
	// Wiped by the org-deletion walker and the dev reset (registered in
	// lib/tenantTables.ts before `mailboxes`, so members go before the parent).
	mailboxMembers: defineTable({
		mailboxId: v.id('mailboxes'),
		authUserId: v.string(), // BetterAuth user ID of the member
		role: v.union(v.literal('owner'), v.literal('member')),
		addedBy: v.string(), // BetterAuth user ID that granted the membership (audit)
		createdAt: v.number(),
	})
		// Access checks look up (mailbox, user) → membership; the compound index
		// is the hot path (one point read per authz decision). It also serves
		// "every member of a mailbox" (member management, cascade delete) as a
		// prefix query — `q.eq('mailboxId', …)` only — so no separate
		// `by_mailbox` single-column index is needed.
		.index('by_mailbox_user', ['mailboxId', 'authUserId'])
		// List every mailbox a user belongs to (identity resolution / inbox list).
		.index('by_user', ['authUserId']),

	// Pending team-inbox membership grant — the shared-inbox analogue of
	// `pendingMailboxes`. When an owner adds an email that is NOT yet an org
	// member to a team inbox, we reserve a grant here (and issue the org
	// invite); the grant is consumed into a real `mailboxMembers` row when that
	// person accepts and we finally have their `userId`.
	//
	// The grant is BOUND to `inviteeEmail` (canonical lowercase): the claim only
	// matches the accepting user's own login email, so another org member who
	// learned the invite can't take over someone else's inbox access (same
	// anti-hijack property as `pendingMailboxes`). `mailboxAddress` is
	// denormalized so the invitation email — sent by the auth hook before we
	// have a mailbox join — can name the inbox without a lookup.
	//
	// Wiped by the org-deletion walker and the dev reset (registered in
	// lib/tenantTables.ts before `mailboxes`, so grants go before the parent).
	pendingMailboxMembers: defineTable({
		organizationId: v.string(),
		inviteeEmail: v.string(), // canonical lowercase — claim is bound to this identity
		mailboxId: v.id('mailboxes'),
		mailboxAddress: v.string(), // denormalized team-inbox address (for the invite email)
		invitedByUserId: v.string(), // inviter — audit only
		createdAt: v.number(),
	})
		// Claim (accepting user's email) and the auth-hook email lookup both key
		// on (org, email); a person may be pre-added to several inboxes at once,
		// so this is a prefix range, not a point read.
		.index('by_org_email', ['organizationId', 'inviteeEmail'])
		// Cascade-clean grants when a team inbox is deleted (mail/mailbox.ts:remove).
		.index('by_mailbox', ['mailboxId']),

	// External mailbox connection (BYO IMAP/SMTP). Per-user link to an EXISTING
	// external mailbox (Gmail, Fastmail, a company server). 1:1 with a `mailboxes`
	// row whose kind='external'. Credentials are encrypted at rest (AES-256-GCM);
	// read queries NEVER return the ciphertext/iv/tag — only the mail-sync worker
	// (which holds INSTANCE_SECRET) decrypts. The envelope shape is versioned by
	// CURRENT_EXTERNAL_MAIL_CRED_VERSION in lib/constants.ts.
	externalMailAccounts: defineTable({
		userId: v.string(), // BetterAuth user (owner)
		organizationId: v.string(),
		mailboxId: v.id('mailboxes'), // the reused inbox identity

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
			v.literal('pending'), // created; worker not yet connected
			v.literal('connected'), // IMAP IDLE live
			v.literal('auth_error'), // bad credentials — needs user fix
			v.literal('error'), // transient/connection error (backoff)
			v.literal('disconnected') // user paused / removed
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
		folderId: v.id('mailFolders'), // local folder this remote maps to
		remoteName: v.string(), // e.g. "INBOX", "[Gmail]/Sent Mail"
		remoteUidValidity: v.number(), // remote UIDVALIDITY (resync on change)
		lastSeenUid: v.number(), // incremental (forward) fetch = lastSeenUid+1:*
		lastSeenModseq: v.optional(v.number()), // CONDSTORE fast-resync, if supported
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
		userId: v.string(), // BetterAuth user (owner)
		organizationId: v.string(),
		accountId: v.id('externalMailAccounts'),
		mailboxId: v.id('mailboxes'),
		// Provider label — drives wizard copy only ("Migrate from Google").
		source: v.union(v.literal('google'), v.literal('imap')),
		status: v.union(
			v.literal('importing'), // worker backfilling historical mail
			v.literal('indexing'), // import done; AI knowledge sweep running
			v.literal('completed'),
			v.literal('failed'),
			v.literal('cancelled')
		),
		// Feed imported mail into the knowledge graph (requires `ai.knowledge`).
		isAiIndexingEnabled: v.boolean(),

		// AGGREGATED — progress counters.
		messagesTotal: v.number(), // Σ per-folder backfillTotal (import denominator)
		messagesImported: v.number(), // Σ per-folder backfillDone (import numerator)
		messagesIndexed: v.number(), // messages swept into the knowledge graph

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
		role: v.optional(
			v.union(
				v.literal('inbox'),
				v.literal('sent'),
				v.literal('drafts'),
				v.literal('trash'),
				v.literal('spam'),
				v.literal('archive')
			)
		),
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
		// "Snooze until they reply": when set alongside `snoozedUntil` (which
		// holds the fallback cap), ANY inbound reply into the thread clears the
		// snooze early (mail/delivery.ts hook, mirroring followUps) so the
		// conversation resurfaces the moment the awaited reply lands. If no reply
		// arrives, the normal snooze sweep resurfaces it once at the cap.
		isSnoozeUntilReply: v.optional(v.boolean()),

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
		virusVerdict: v.optional(
			v.union(v.literal('clean'), v.literal('infected'), v.literal('skipped'))
		),
		spfResult: v.optional(v.string()),
		dkimResult: v.optional(v.string()),
		dmarcResult: v.optional(v.string()),
		// Published DMARC policy that applied to this message (`none`/`quarantine`/
		// `reject`). Recorded alongside `dmarcResult` so the Spam-routing decision
		// (a quarantine/reject fail → Spam) and the UI banner can distinguish a
		// monitor-only `p=none` fail from one the domain owner asked us to act on.
		dmarcPolicy: v.optional(v.string()),

		// Team-inbox attribution: on an outbound message, the BetterAuth user id of
		// the teammate who fired the send (copied from the draft at dispatch). Lets
		// a shared inbox attribute "who replied" per message. Optional — inbound
		// mail and legacy sent rows carry no sender, and the from-address alone can
		// never distinguish two teammates sending as the same shared address.
		sentByUserId: v.optional(v.string()),

		// Outbound tracking (sent path). Per-recipient state lives in
		// `recipients[]`; `state` is a denormalized aggregate derived by
		// the Postbox outbound lifecycle module (the only writer). See
		// docs/adr/0012-postbox-outbound-lifecycle-module.md.
		outbound: v.optional(
			v.object({
				// AGGREGATED — derived from recipients[] by the lifecycle module.
				// `partial` is the only literal that exists here but not on a
				// per-recipient entry; it covers any mix of recipient states.
				state: v.union(
					v.literal('queued'),
					v.literal('sent'),
					v.literal('bounced'),
					v.literal('failed'),
					v.literal('partial')
				),
				recipients: v.array(
					v.object({
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
							v.literal('failed')
						),
						sentAt: v.optional(v.number()),
						bounceMessage: v.optional(v.string()),
						errorCode: v.optional(v.string()),
					})
				),
			})
		),

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
		// Team-inbox collision safety. Set whenever an outbound reply is committed
		// to the thread; carries WHO (a BetterAuth user id) replied last so a
		// shared (team) inbox can show "last reply by …" and warn a second teammate
		// before they send a duplicate reply. `byUserId` is optional so pre-existing
		// rows and legacy dispatch paths that never recorded a sender still validate.
		// Undefined on threads with no outbound reply yet — the guard is inert then.
		latestReply: v.optional(
			v.object({
				messageId: v.id('mailMessages'),
				byUserId: v.optional(v.string()),
				at: v.number(),
				// Set when the reply was sent from the teammate's PERSONAL address
				// (send-as choice): the sent copy lives in their own mailbox, so the
				// team thread carries only this marker — teammates see the reply
				// happened and that it went out under a personal identity, so context
				// never silently forks. Undefined ⇒ replied as the team (classic).
				isFromPersonalAddress: v.optional(v.boolean()),
			})
		),
		folderRoles: v.array(v.string()),
		labelIds: v.array(v.id('mailLabels')),
		// Reply Queue (advisory AI): set when the latest inbound message looks like
		// it needs a reply from the mailbox owner. A deterministic heuristic flags
		// the candidate first (source `heuristic`, urgency `normal`); the cheap-tier
		// LLM refinement pass (mail/needsReplyClassify.ts) upgrades it with
		// urgency / askSummary / dueHint when AI is enabled and the call succeeds.
		// Cleared by any outbound reply in the thread, archive/trash of its
		// messages, or the manual clear mutation (mail/needsReply.ts).
		needsReply: v.optional(
			v.object({
				// The inbound message that triggered the flag (usually the newest).
				messageId: v.id('mailMessages'),
				detectedAt: v.number(),
				source: v.union(v.literal('heuristic'), v.literal('llm')),
				urgency: v.union(v.literal('high'), v.literal('normal'), v.literal('low')),
				// Unified cross-thread priority score (mail/priorityScore.ts): the
				// deterministic sender-importance signal (VIP / person / frecency)
				// blended with the LLM urgency. REPLACES the 3-bucket urgency for
				// Reply Queue ranking. Optional so pre-existing rows fall back to
				// their urgency bucket in the comparator until re-scored.
				priorityScore: v.optional(v.number()),
				// One-line "what they are asking" (<= 120 chars). LLM-refined only.
				askSummary: v.optional(v.string()),
				// ISO date when the message states a deadline. LLM-refined only.
				dueHint: v.optional(v.string()),
				// Plain-prose scheduling request detected on the trigger message (no .ics
				// attached — the calendar-invite path in PostboxInviteCard owns real
				// invites). Drives the "Scheduling request — draft a reply?" chip in the
				// reader. LLM-refined only; absent when nothing schedule-like was found.
				meetingIntent: v.optional(
					v.object({
						isScheduling: v.boolean(),
						// Verbatim time phrases the sender proposed ("Tuesday afternoon").
						proposedTimes: v.array(v.string()),
						// What the meeting is about, if stated (<= 120 chars).
						topic: v.optional(v.string()),
					})
				),
				// Clarification loop (Postbox-native): set when the refinement pass
				// decides a good reply needs a fact only the owner can supply and the
				// capable-tier divergence confirmation agrees it is genuinely open.
				// Flips the Reply Queue row from "Needs you" to "Needs your input".
				// LLM-refined only; every question is deterministically sanitized
				// (credential/OTP solicitations dropped) and attributed to the sender
				// in mail/needsReplyClassify.ts before it is persisted here.
				clarification: v.optional(
					v.object({
						// True while at least one question is still awaiting an answer.
						isNeeded: v.boolean(),
						questions: v.array(
							v.object({
								// Stable id matching an incoming answer back to its question.
								id: v.string(),
								// The reply-slot kind (shared taxonomy, inbox/clarificationSlots.ts).
								slotType: v.string(),
								// The question shown to the owner.
								text: v.string(),
								// Provenance + "Owlat will never ask for your password" promise.
								attribution: v.string(),
								// Suggested scoped answers rendered as one-tap chips (multiple
								// choice); absent for a free-text-only slot.
								options: v.optional(v.array(v.string())),
								// The owner's answer — absent until answered.
								answer: v.optional(
									v.object({
										value: v.string(),
										at: v.number(),
									})
								),
							})
						),
						// When the questions were surfaced (advisory ordering only).
						askedAt: v.number(),
						// Set once the owner answers — drives the draftWithAnswers path.
						answeredAt: v.optional(v.number()),
						// The starter reply produced by draftWithAnswers once the owner
						// answered. Its presence flips the card to "Draft ready".
						draft: v.optional(v.string()),
					})
				),
				// Draft-on-arrival review slot (postbox.aiDraft flag): a reply
				// pre-generated the moment the message landed — or the moment a
				// clarification was answered — via the SHARED draft service
				// (agent/shared/draftService.ts), so the owner reviews-and-sends
				// instead of starting from a blank composer. HUMAN REVIEW ONLY: its
				// presence never auto-sends. Absent when the flag is off, no AI
				// provider is configured, or generation failed (fail-soft — the
				// plain needs-reply row still renders).
				draftSlot: v.optional(
					v.object({
						// The pre-generated reply body (option 0 == this string).
						draft: v.string(),
						// Reply subject (Re: …) composed from the trigger message.
						draftSubject: v.optional(v.string()),
						// Confidence surfaced next to the draft (0..1) — the blended
						// classifier/urgency signal, NOT an auto-send authorization.
						confidence: v.number(),
						// Draft-quality self-check (completeness/grounding/tone). Absent
						// when the self-check failed → shown as "unverified" in review.
						quality: v.optional(draftQualityValidator),
						// Alternative pickable drafts (present only on low-confidence /
						// low-quality cases; options[0] == draft). Absent otherwise.
						options: v.optional(v.array(v.string())),
						// When the slot was generated (advisory; freshness display).
						generatedAt: v.number(),
					})
				),
			})
		),
		// Set when inbound ingest enqueues needs-reply classification; cleared once
		// the classify action persists a result. Backs the reconcile cron that
		// re-schedules threads whose scheduled classification was lost.
		needsReplyPendingAt: v.optional(v.number()),
		// "Remind me if no reply" follow-up watch on a sent message (Boomerang
		// parity, mail/followUps.ts). Armed at send time (from the draft's
		// followUpRemindAt) or after the fact from the reader/sent list. ANY
		// inbound delivery into the thread clears it silently; otherwise the
		// sweep cron resurfaces the thread at the deadline (sets dueAt exactly
		// once — the "No reply yet" chip + Reply Queue follow-up item key off it).
		followUp: v.optional(
			v.object({
				// The sent message being watched for a reply.
				messageId: v.id('mailMessages'),
				remindAt: v.number(),
				armedAt: v.number(),
				// Set by the sweep when the deadline passed with no reply. Its
				// presence flips the UI from "awaiting reply" to "No reply yet".
				dueAt: v.optional(v.number()),
				// Display hint for the Reply Queue ("You're waiting on <name>") —
				// the first recipient of the watched message.
				waitingOn: v.optional(v.string()),
			})
		),
		// Sweep key: mirrors followUp.remindAt while the watch is armed; cleared
		// when the watch clears OR fires (so a due watch is resurfaced exactly
		// once). Kept as a flat companion field so the cron can range-scan it
		// (same pattern as needsReplyPendingAt above).
		followUpRemindAt: v.optional(v.number()),
		// Smart-inbox category (advisory, off by default in the UI). A deterministic
		// heuristic classifies the latest inbound message first (source `heuristic`);
		// genuinely ambiguous mail is refined by the cheap-tier LLM (source `llm`,
		// mail/categoryClassify.ts) behind the same aiGate as the rest of Postbox AI.
		// A user "Recategorize as…" override always wins (source `user`) and is
		// remembered per sender in mailSenderCategoryOverrides. Set at inbound ingest
		// and by the one-shot backfill; fail-soft to `other` when the LLM is
		// unavailable. Never moves or modifies mail — this is a display grouping only.
		category: v.optional(
			v.object({
				label: v.union(
					v.literal('person'),
					v.literal('newsletter'),
					v.literal('notification'),
					v.literal('receipt'),
					v.literal('other')
				),
				source: v.union(v.literal('heuristic'), v.literal('llm'), v.literal('user')),
				classifiedAt: v.number(),
			})
		),
		// Cached advisory AI summary for the long-thread summary strip (mail/ai.ts
		// getOrGenerateThreadSummary + mail/summaryCache.ts). `messageCount` is the
		// thread's messageCount at generation time; the cache is served only while it
		// still matches the live count, so a new inbound message makes it stale and
		// the next open regenerates it (edge-triggered, never a hot loop). Absent
		// until the strip first generates one; never moves or modifies mail.
		summaryCache: v.optional(
			v.object({
				summary: v.string(),
				messageCount: v.number(),
				generatedAt: v.number(),
			})
		),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_mailbox_and_last_message', ['mailboxId', 'lastMessageAt'])
		.index('by_mailbox_and_subject', ['mailboxId', 'normalizedSubject'])
		// Backs the needs-reply reconcile cron — range scan on needsReplyPendingAt.
		.index('by_needs_reply_pending', ['needsReplyPendingAt'])
		// Backs the Reply Queue list — flagged threads per mailbox without a
		// full-table scan (undefined needsReply sorts before every number, so the
		// query lower-bounds detectedAt with gt(0), like the pending sweep above).
		.index('by_mailbox_needs_reply', ['mailboxId', 'needsReply.detectedAt'])
		// Backs the 1-minute follow-up sweep cron — range scan on
		// followUpRemindAt <= now (lower-bounded gt(0) like the snooze sweep).
		.index('by_follow_up_remind', ['followUpRemindAt'])
		// Backs the Reply Queue's "You're waiting on <name>" follow-up items —
		// due watches per mailbox without a full-table scan.
		.index('by_mailbox_follow_up_due', ['mailboxId', 'followUp.dueAt']),

	// Per-identity (mailbox) writing-voice profile, derived from the user's own
	// SENT mail so advisory AI drafts sound like them. Recomputed lazily (see
	// mail/voiceProfile.ts): a stale row is served as-is while a background
	// refresh is scheduled. `profile` is undefined until the first successful
	// derivation — absence means "exactly today's non-personalized behaviour".
	mailVoiceProfiles: defineTable({
		mailboxId: v.id('mailboxes'),
		// User toggle: "Personalize AI drafts". When false, the profile is never
		// injected into prompts (and never recomputed) even if one exists.
		isEnabled: v.boolean(),
		// Guards against scheduling a second refresh while one is in flight.
		status: v.union(v.literal('idle'), v.literal('refreshing')),
		profile: v.optional(
			v.object({
				greetings: v.array(v.string()),
				signOffs: v.array(v.string()),
				formality: v.number(), // 1 (very casual) … 5 (very formal)
				brevity: v.number(), // 1 (terse) … 5 (elaborate)
				languages: v.array(v.string()),
				isEmojiUser: v.boolean(),
				examplePhrasings: v.array(v.string()),
			})
		),
		// Number of SENT messages sampled at the last successful derivation.
		sampleCount: v.number(),
		// Sent-folder message count observed at the last derivation — a cheap way
		// to detect "> N new sent messages since we last learned the voice".
		sentCountAtCompute: v.number(),
		lastComputedAt: v.optional(v.number()),
		// User-authored standing instructions ("never use exclamation marks",
		// "sign as Dr.") merged into every draft prompt ABOVE the derived voice.
		// These are explicit user rules, never inferred, and always applied.
		standingInstructions: v.optional(v.array(v.string())),
		// Edit-learning flywheel (mail/editLearning.ts): recurring deltas the user
		// makes to the AI's OWN drafts before sending, each with a live observation
		// count. A delta only becomes a durable, injected rule once its
		// `promoted` flag flips (recurrence threshold) — one-offs never stick.
		derivedAdjustments: v.optional(v.array(editAdjustmentValidator)),
		// North-star metric: a bounded rolling window of recent normalized (0..1)
		// draft→sent edit distances. The median is derived on read.
		editDistanceSamples: v.optional(v.array(v.number())),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_mailbox', ['mailboxId']),

	// Per-recipient style memory for the edit-learning flywheel. Keyed by the
	// mailbox + the LOWERCASED recipient address so an override learned from mail
	// to contact X is ONLY ever blended when drafting to that same address — it
	// can never cross a contact-scope boundary onto another recipient. Holds
	// recipient-specific deltas (e.g. "always replies to this contact in German")
	// with the same promote-on-recurrence gate as the voice-level adjustments.
	mailContactStyleOverrides: defineTable({
		mailboxId: v.id('mailboxes'),
		contactAddress: v.string(),
		adjustments: v.array(editAdjustmentValidator),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_mailbox_and_address', ['mailboxId', 'contactAddress']),

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
		// (mail/editLearning.ts). Absent → the draft was not AI-authored (or the
		// client did not record a baseline) → no learning happens, exactly today's
		// behaviour. Snapshotted ONCE and never overwritten.
		aiDraftBaseline: v.optional(v.object({ text: v.string(), capturedAt: v.number() })),

		// Team-inbox attribution: the BetterAuth user id of the teammate who fired
		// the send, stamped by `drafts.send` from the acting session. Copied onto
		// the resulting sent message + the thread's `latestReply` so a shared inbox
		// can attribute the reply. Undefined until send (and on legacy rows).
		sentByUserId: v.optional(v.string()),

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
		.index('by_undo_token', ['undoToken']),

	// Audit log of mailbox-level events (delivery, IMAP login, etc.)
	mailAuditLog: defineTable({
		mailboxId: v.id('mailboxes'),
		event: v.string(),
		details: v.optional(v.string()),
		ip: v.optional(v.string()),
		userAgent: v.optional(v.string()),
		occurredAt: v.number(),
	}).index('by_mailbox_and_time', ['mailboxId', 'occurredAt']),

	// App passwords for native IMAP/SMTP clients (Apple Mail, Thunderbird, …)
	// The cleartext password is shown ONCE at creation and never recoverable.
	// The first 4 chars are stored separately so the resolver can narrow to a
	// small candidate set before running the (intentionally slow) hash compare.
	mailAppPasswords: defineTable({
		mailboxId: v.id('mailboxes'),
		userId: v.string(),
		label: v.string(), // e.g. "iPhone Mail", "Thunderbird"
		passwordHash: v.string(), // PBKDF2-SHA256 derived; encoded as <salt-hex>:<hash-hex>
		passwordPrefix: v.string(), // first 4 chars, lowercase
		scopes: v.array(v.union(v.literal('imap'), v.literal('smtp'))),
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
		address: v.string(), // lowercase canonical
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
		priority: v.number(), // lower number runs first
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
		alias: v.string(), // canonical lowercase
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
	}).index('by_mailbox', ['mailboxId']),

	// RFC 3834-compliant vacation auto-responder.
	mailVacationResponders: defineTable({
		mailboxId: v.id('mailboxes'),
		isEnabled: v.boolean(),
		subject: v.string(),
		bodyText: v.string(),
		bodyHtml: v.optional(v.string()),
		startAt: v.optional(v.number()),
		endAt: v.optional(v.number()),
		replyIntervalDays: v.number(), // anti-loop: max once-per-N-days per sender
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_mailbox', ['mailboxId']),

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
		email: v.string(), // canonical lowercase
		displayName: v.optional(v.string()),
		organization: v.optional(v.string()),
		// Frecency proxy — bumped each time the user sends to this address.
		// Used to rank autocomplete suggestions.
		useCount: v.number(),
		lastUsedAt: v.number(),
		// Explicit "important sender" flag the owner toggles on a contact. Feeds
		// the Reply Queue priority score (a VIP outranks everyone). Optional so
		// existing rows read as undefined (not a VIP).
		isVip: v.optional(v.boolean()),
		// HEY-style screener: set once the owner accepts this first-time sender,
		// letting their mail into the Reply Queue / clarification loop. Optional so
		// existing rows read as undefined (unscreened, i.e. treated as accepted for
		// pre-existing correspondents that already have a row).
		isScreenerAccepted: v.optional(v.boolean()),
		createdAt: v.number(),
	})
		.index('by_mailbox_and_email', ['mailboxId', 'email'])
		.index('by_mailbox_and_lastUsed', ['mailboxId', 'lastUsedAt']),

	// Per-sender smart-inbox category overrides. When the user "Recategorizes as…"
	// a thread, the chosen category is remembered here for that sender so future
	// mail from them lands in the same section without another LLM call. A user
	// override always beats both the deterministic heuristic and the LLM.
	mailSenderCategoryOverrides: defineTable({
		mailboxId: v.id('mailboxes'),
		senderEmail: v.string(), // canonical lowercase
		label: v.union(
			v.literal('person'),
			v.literal('newsletter'),
			v.literal('notification'),
			v.literal('receipt'),
			v.literal('other')
		),
		updatedAt: v.number(),
	}).index('by_mailbox_and_sender', ['mailboxId', 'senderEmail']),

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

	// Per-mailbox canned responses ("snippets"). Inserted into a draft via the
	// composer's "/" slash-trigger. `bodyHtml` is stored post-sanitize (same
	// allowlist as signatures) and may carry plain-text {{firstName}}-style
	// placeholder tokens resolved at insert time from the draft's recipient.
	mailSnippets: defineTable({
		mailboxId: v.id('mailboxes'),
		name: v.string(),
		shortcut: v.string(),
		bodyHtml: v.string(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_mailbox', ['mailboxId'])
		.index('by_mailbox_and_shortcut', ['mailboxId', 'shortcut']),

	// Per-user Postbox behavior preferences (one row per BetterAuth user,
	// spanning all of the user's mailboxes). Currently: what the reader does
	// after triaging (archive/trash/snooze/spam) the open message.
	mailUserSettings: defineTable({
		userId: v.string(), // BetterAuth user ID (owner)
		autoAdvance: mailAutoAdvanceValidator,
		// Inline compose autocomplete ("Writing suggestions"). Optional so existing
		// rows read as undefined; the reader defaults it ON when the `ai` flag is on.
		isWritingSuggestionsOn: v.optional(v.boolean()),
		// Auto-summarize long threads: show the cached one-line AI summary strip at the
		// top of long conversations. Optional so existing rows read as undefined; the
		// reader defaults it ON when the `ai` flag is on (user opt-out within an
		// AI-enabled deploy).
		isAutoSummarizeOn: v.optional(v.boolean()),
		// Default reply behavior: whether the primary reply affordance (Reply button
		// and the `r` shortcut) opens a plain Reply or a Reply-all. Optional so
		// existing rows read as undefined; the reader defaults it to 'reply'.
		replyDefault: v.optional(mailReplyDefaultValidator),
		// List/reader density: 'comfortable' (roomy default) vs 'compact' (tighter
		// rows + single-line subject/snippet). Optional so existing rows read as
		// undefined; the reader defaults it to 'comfortable'.
		density: v.optional(mailDensityValidator),
		// Inbox list view mode: 'flat' (single message list), 'conversations'
		// (thread-grouped), or 'categories' (smart-inbox sections). Inbox-only —
		// other folders always render flat. Optional so existing rows read as
		// undefined; the reader defaults it to 'flat'.
		viewMode: v.optional(mailViewModeValidator),
		// Inbox landing mode: 'today' (focused single-column landing view) vs
		// 'browse' (the full three-pane folder UI). Persisted as the last-used
		// mode. Optional so existing rows read as undefined; the reader defaults
		// it to 'today'.
		inboxMode: v.optional(mailInboxModeValidator),
		// Play a short confirmation sound when a message is dispatched. Optional so
		// existing rows read as undefined; the reader defaults it OFF (opt-in).
		isSendSoundOn: v.optional(v.boolean()),
		// Desktop notification scope: which new inbox mail fires a native toast.
		// Optional so existing rows read as undefined; the desktop reader defaults it
		// to 'people-important' once smart categories exist and 'everything'
		// otherwise (a fresh deploy without the classifier still notifies for all).
		notifyAbout: v.optional(mailNotifyAboutValidator),
		// Sub-setting of notifyAbout: whether non-`person` mail still increments the
		// dock/taskbar unread badge (the toast can be quiet while the badge stays
		// truthful). Optional so existing rows read as undefined; the reader defaults
		// it ON (badge counts everything — the pre-existing behavior).
		isBadgeNonPeopleOn: v.optional(v.boolean()),
		// HEY-style first-time-sender screener. When ON, mail from a sender who is
		// not a known contact / VIP / already-accepted is held OUT of the Reply
		// Queue and clarification loop until the owner accepts them. Optional so
		// existing rows read as undefined; the reader defaults it OFF (opt-in), so
		// a deploy that never toggles it keeps today's behaviour.
		isSenderScreenerOn: v.optional(v.boolean()),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_user', ['userId']),

	// Bidirectional commitment / deadline tracking (Daily Brief). A commitment is
	// either a deadline SOMEONE GAVE the owner (`inbound` — "please send it by
	// Friday") or a promise the OWNER MADE in their own sent mail (`outbound` —
	// "I'll get the draft to you Friday"). Extraction is deterministic-gated then
	// cheap-tier-LLM-refined (mail/commitmentExtract.ts), behind the same aiGate
	// as the rest of Postbox AI and fail-soft. The commitment-reminder cron
	// (mail/commitments.ts) surfaces an open commitment before its deadline —
	// arming the thread follow-up (mail/followUps.ts) so it floats into the Reply
	// Queue — and marks it `reminded` exactly once. Advisory only: this never
	// sends or modifies mail.
	mailCommitments: defineTable({
		mailboxId: v.id('mailboxes'),
		threadId: v.id('mailThreads'),
		// The source message the commitment was extracted from (inbound message
		// that stated a deadline, or the owner's own sent message that made a
		// promise). One commitment per message+direction (dedup key).
		messageId: v.id('mailMessages'),
		// `inbound` = a deadline someone gave the owner; `outbound` = a promise the
		// owner made in sent mail.
		direction: v.union(v.literal('inbound'), v.literal('outbound')),
		// One line describing the commitment (<= 200 chars).
		description: v.string(),
		// The other party (who is owed / who is waiting). Display hint.
		counterparty: v.optional(v.string()),
		// Parsed absolute deadline (ms epoch), when the source stated a concrete
		// date. Absent when only a fuzzy phrase was found — the row still shows in
		// the brief but the pre-lapse reminder needs a concrete dueAt.
		dueAt: v.optional(v.number()),
		// The raw deadline phrase as written ("by Friday", "end of week"), for the
		// auditable brief even when it could not be parsed to a timestamp.
		dueHintRaw: v.optional(v.string()),
		status: v.union(
			v.literal('open'),
			v.literal('reminded'),
			v.literal('done'),
			v.literal('lapsed')
		),
		source: v.union(v.literal('heuristic'), v.literal('llm')),
		// Set once the pre-lapse reminder fired (status → reminded), so the cron
		// never re-reminds the same commitment.
		remindedAt: v.optional(v.number()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_mailbox', ['mailboxId'])
		// Dedup / idempotency: at most one commitment per source message+direction.
		.index('by_message', ['messageId', 'direction'])
		// Backs the pre-lapse reminder scan — open commitments per mailbox ordered
		// by deadline.
		.index('by_mailbox_status_due', ['mailboxId', 'status', 'dueAt']),

	// "What needs you today" digest snapshot (Daily Brief), rebuilt by the daily
	// cron per active mailbox (mail/dailyBrief.ts). Holds the ranked list of
	// things that need the owner (pending replies + clarification questions + due
	// follow-ups + deadlines/commitments), plus the AUDITABLE bundle of low-signal
	// mail (newsletters / receipts / notifications) it folded away — a digest that
	// silently hides something important is a trust-killer, so the exact bundled
	// threads are always inspectable. Read-only in-app surface; never sends mail
	// (an optional email delivery is a separate opt-in).
	mailDailyBriefs: defineTable({
		mailboxId: v.id('mailboxes'),
		generatedAt: v.number(),
		// Ranked "needs you" items, highest priority first (mail/priorityScore.ts).
		items: v.array(
			v.object({
				kind: v.union(
					v.literal('needs_reply'),
					v.literal('clarification'),
					v.literal('followup'),
					v.literal('commitment')
				),
				threadId: v.id('mailThreads'),
				priorityScore: v.number(),
				title: v.string(),
				subtitle: v.optional(v.string()),
				// Absolute deadline (ms) when the item carries one.
				dueAt: v.optional(v.number()),
			})
		),
		// The auditable "what I bundled" view — every low-signal thread the brief
		// folded into the digest, so nothing is hidden without a trail.
		bundled: v.array(
			v.object({
				threadId: v.id('mailThreads'),
				category: v.union(v.literal('newsletter'), v.literal('notification'), v.literal('receipt')),
				fromAddress: v.string(),
				subject: v.string(),
			})
		),
		// Per-category bundled counts, for the digest header without re-counting.
		bundledCounts: v.object({
			newsletter: v.number(),
			notification: v.number(),
			receipt: v.number(),
		}),
		createdAt: v.number(),
	}).index('by_mailbox_and_generated', ['mailboxId', 'generatedAt']),

	// Daily Brief CARD cache (mail/brief.ts) — the small per-owner greeting card
	// at the top of the Today view: a <=3-sentence template summary of what
	// happened while the owner was away (new mail since local midnight, drafts
	// the agent prepared, open questions blocking the agent). One row per
	// mailbox + viewer, upserted in place; regenerated at most once per local
	// morning or when >=5 new messages arrived since the cached card
	// (stale-while-revalidate — the read query serves the cache instantly and
	// flags staleness for a background refresh). Deterministic counts only —
	// no LLM output is persisted here. Distinct from `mailDailyBriefs` (the
	// ranked "needs you" digest snapshot); this is only the greeting card.
	mailBriefCards: defineTable({
		mailboxId: v.id('mailboxes'),
		// BetterAuth user id of the viewer the card belongs to (dismissal and
		// the "your morning" framing are personal, not mailbox-global).
		userId: v.string(),
		// Viewer-local calendar day (YYYY-MM-DD) the card was generated for —
		// supplied by the client, since the server has no timezone. Only ever
		// affects the caller's own card.
		localDay: v.string(),
		generatedAt: v.number(),
		counts: v.object({
			// Inbox messages received since the viewer's local midnight.
			newMail: v.number(),
			// Reply drafts the agent prepared in the overnight window.
			drafted: v.number(),
			// Open clarification questions blocking the agent on the owner.
			questions: v.number(),
			// Low-signal mail (newsletter/notification/receipt) auto-filed in
			// the overnight window.
			autoFiled: v.number(),
		}),
		// Set to the viewer-local day the owner dismissed the card; the card is
		// hidden while this matches the viewer's current local day and comes
		// back the next morning.
		dismissedDay: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_mailbox_and_user', ['mailboxId', 'userId']),

	// A member who lands in the fresh-start flow with no mailbox and no way to
	// connect one (no reserved hosted mailbox AND external accounts disabled)
	// can ask an admin to set one up. This is the honest dead-end escape hatch —
	// a single in-app request per member that admins resolve. Idempotent per
	// member: one open row at a time (see mail/mailboxRequest.ts).
	mailboxRequests: defineTable({
		// BetterAuth user id of the member asking for a mailbox.
		authUserId: v.string(),
		organizationId: v.string(),
		// Denormalised for the admin list so it needn't join userProfiles.
		requesterEmail: v.string(),
		requesterName: v.optional(v.string()),
		// Optional free-text note ("I need marcel@…").
		note: v.optional(v.string()),
		status: v.union(v.literal('open'), v.literal('resolved')),
		createdAt: v.number(),
		// Admin who resolved it + when (audit; unset while open).
		resolvedByUserId: v.optional(v.string()),
		resolvedAt: v.optional(v.number()),
	})
		.index('by_auth_user_id', ['authUserId'])
		.index('by_org_and_status', ['organizationId', 'status']),
};
