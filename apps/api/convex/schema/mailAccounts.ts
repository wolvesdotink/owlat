import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { destinationProviderValidator } from '../delivery/deliverabilityValidators';
import { archiveFormatValidator } from '../lib/literalValidators';

/**
 * External mail accounts and mailbox data movement.
 *
 * IMAP/OAuth accounts Owlat syncs from, their per-folder sync cursors, and the
 * one-shot migration / archive-import / move jobs that fill or relocate a
 * mailbox.
 *
 * Spread into `mailTables` from schema/mail.ts.
 */
/**
 * What a completed Google authorization should DO — captured when the flow
 * STARTS, so the callback (which only carries `code` + `state`) cannot redirect
 * the grant into a different operation than the one the user consented to.
 *
 * Declared here rather than in `mail/external/googleOAuth.ts` because the state
 * table persists it: the schema module is the leaf both the table definition and
 * the functions can import without closing a cycle. `googleOAuth.ts` re-exports
 * it (with its TS type) as the feature's public surface.
 *
 *   connect       — a new personal BYO mailbox
 *   update        — re-authorize the caller's existing personal mailbox
 *   connectShared — a new team inbox, with its initial roster
 *   updateShared  — re-authorize an existing team inbox
 *   connectSeed   — a deliverability seed mailbox
 */
export const googleOAuthIntentValidator = v.union(
	v.object({ kind: v.literal('connect') }),
	v.object({ kind: v.literal('update') }),
	v.object({
		kind: v.literal('connectShared'),
		displayName: v.optional(v.string()),
		memberUserIds: v.array(v.string()),
	}),
	v.object({ kind: v.literal('updateShared'), mailboxId: v.id('mailboxes') }),
	v.object({ kind: v.literal('connectSeed'), seedProvider: destinationProviderValidator })
);

export const mailAccountsTables = {
	externalMailAccounts: defineTable({
		userId: v.string(), // BetterAuth user (connector / credential custodian)
		organizationId: v.string(),
		mailboxId: v.id('mailboxes'), // the reused inbox identity

		// Sharing model, mirroring `mailboxes.scope`. undefined ⇒ 'personal' (a
		// single user's BYO mailbox; back-compat for every pre-shared-inbox row).
		// 'shared' ⇒ the credentials back a TEAM inbox (its mailbox is
		// kind='external', scope='shared') whose access is governed by
		// `mailboxMembers`, not the connecting `userId`. A shared account is org
		// infrastructure: it is EXCLUDED from the per-user "one live personal
		// external account" limit and from the personal-external surfaces
		// (getForCurrentUser / disconnect / purge / the move flow), which all
		// resolve the caller's PERSONAL account only. `userId` on a shared row is
		// the admin who connected it (credential custodian + audit); ownership of
		// the inbox itself follows `mailboxes.userId` via mailboxMembers.
		scope: v.optional(v.union(v.literal('personal'), v.literal('shared'))),

		// What the connection is FOR. undefined ⇒ 'mail' (every pre-seed row): an
		// ordinary BYO mailbox synced into Postbox. 'seed' ⇒ a deliverability SEED
		// mailbox: a free consumer account the operator owns purely so Owlat can
		// mail itself a shadow copy and see which folder it lands in (gate 5 of
		// the deliverability controller). A seed account reuses this table's
		// sealed-credential handling and the shipped IMAP client verbatim — there
		// is no second credential model — but it is NOT a user inbox: it is
		// excluded from the personal-external surfaces and its mail is never
		// indexed. Zero seed accounts is a SUPPORTED configuration.
		purpose: v.optional(v.union(v.literal('mail'), v.literal('seed'))),
		// Mailbox provider of a seed account, on the routing cell's destination
		// axis. Set at connect time from the account's domain/host; drives the
		// per-provider placement roll-up. Seed rows only.
		seedProvider: v.optional(destinationProviderValidator),
		// Last time the rotation nudge was EMITTED into the audit log. Purely a
		// de-duplication stamp for the background sweep — it does NOT gate
		// due-ness, or a sweep tick would extinguish the very signal it exists to
		// raise. Absent ⇒ never emitted for the current cycle.
		seedRotationRemindedAt: v.optional(v.number()),
		// Last time an OPERATOR acknowledged the rotation nudge. This is what the
		// 90-day clock runs from (absent ⇒ it runs from `createdAt`), so the
		// reminder stands until a human acts on it. A reminder is a nudge on a
		// connected seed, never a blocking warning or a "setup incomplete" state.
		seedRotationAcknowledgedAt: v.optional(v.number()),

		// IMAP (receive). isImapSecure=true ⇒ implicit TLS (993); false ⇒ STARTTLS (143).
		imapHost: v.string(),
		imapPort: v.number(),
		isImapSecure: v.boolean(),
		// SMTP (send). isSmtpSecure=true ⇒ implicit TLS (465); false ⇒ STARTTLS (587).
		smtpHost: v.string(),
		smtpPort: v.number(),
		isSmtpSecure: v.boolean(),

		// Auth. Most providers share one login across IMAP+SMTP; smtpUsername is
		// optional and defaults to imapUsername when unset.
		//
		// 'password' — an IMAP/SMTP app password, the path every provider supports
		// and the one that needs no operator configuration.
		// 'oauth2' — an authorization-code grant the user completed in their
		// provider's own sign-in (today: Google, `oauthProvider: 'google'`). The
		// mail-sync worker authenticates with SASL XOAUTH2 using a short-lived
		// access token the backend mints on demand from a stored REFRESH token.
		// That refresh token lives INSIDE the same encrypted envelope below
		// (`{ oauthRefreshToken }` instead of `{ imapPassword, smtpPassword }`), so
		// there is exactly one encrypt site and one decrypt site for both methods
		// and no access-token column ever hits disk.
		//
		// Every pre-OAuth row is 'password', so widening the union adds a case
		// rather than changing one (CONVENTIONS.md §Schema evolution).
		authMethod: v.union(v.literal('password'), v.literal('oauth2')),
		// Which provider's authorization server issued the refresh token. Absent on
		// every password row; set together with `authMethod: 'oauth2'`.
		oauthProvider: v.optional(v.literal('google')),
		imapUsername: v.string(),
		smtpUsername: v.optional(v.string()),

		// Encrypted credential envelope (AES-256-GCM). The plaintext is a JSON blob
		// — `{ imapPassword, smtpPassword? }` on a password row, `{ oauthRefreshToken }`
		// on an oauth2 one; these fields hold its ciphertext/iv/tag.
		// secretEnvelopeVersion pairs the blob per the CONVENTIONS.md versioning rule.
		//
		// OPTIONAL because disconnecting is supposed to FORGET the credential:
		// `mail/external/accountTeardown.ts` drops all four fields when a member
		// disconnects their mailbox (or an admin retires it, or a seed is retired),
		// leaving the row for its audit trail and its retained mail with no secret
		// in it. A live account always carries the envelope — connect and every
		// credential rotation write all four together — so absent means
		// "disconnected", and `getCredentialsForWorker` answers such a row with the
		// terminal `disconnected` reason instead of handing the worker anything.
		secretCiphertext: v.optional(v.string()),
		secretIv: v.optional(v.string()),
		secretAuthTag: v.optional(v.string()),
		secretEnvelopeVersion: v.optional(v.number()),

		// A hard purge is draining this account's data (set when `purge` schedules
		// the cascade, cleared only by the row's own deletion at the end of it).
		// The rows survive for as long as the chunked delete runs, so without this
		// marker the account reads as an ordinary disconnected one with mail kept —
		// and reconnecting mid-drain would re-attach a mailbox the cascade is about
		// to delete.
		purgeStartedAt: v.optional(v.number()),
		// An ADMIN retired this mailbox (`mail/mailbox/identity.ts`'s `remove`),
		// rather than its owner disconnecting it. A reconnect must not re-attach
		// such a mailbox — that would undo an administrative decision — so the
		// owner reconnecting the same address gets a fresh mailbox, as they did
		// before re-attach existed.
		adminRetiredAt: v.optional(v.number()),

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
		.index('by_status', ['status'])
		// Seed-mailbox lookup for the placement prober. Legacy rows carry no
		// `purpose`, so this index only ever returns explicitly-tagged accounts.
		//
		// `status` is IN the index, not filtered after a bounded page, because
		// disconnecting an account is a SOFT status change (`mail/mailbox/identity.ts`'s
		// `remove` patches the row to 'disconnected' and keeps it). Filtering a
		// `.take(cap)` page would let retired rows eat slots — the per-org connect
		// cap would read short and stop refusing, and the roll-up would silently
		// drop live seeds off the end of the page. Selecting the LIVE statuses
		// through the index is the only shape where both are exact.
		.index('by_org_purpose_and_status', ['organizationId', 'purpose', 'status'])
		// The prober's GLOBAL sweep selects on exactly `purpose` and PAGINATES with
		// a cursor the worker carries across ticks. Filtering a bounded `by_status`
		// page for seeds after the fact goes silently dark on any deployment with
		// more connectable accounts than the page bound; a bounded page of seeds
		// with no cursor starves whichever orgs sort last, permanently.
		.index('by_purpose', ['purpose']),

	// One in-flight Google authorization-code exchange.
	//
	// The OAuth handshake spans two HTTP round trips through a third party, so the
	// `state` nonce and the PKCE `code_verifier` have to outlive the request that
	// minted them. This row is that storage and nothing more: single-use (the
	// exchange deletes it, success or failure), short-lived (15 minutes), and
	// scoped to the user who started the flow — a callback presenting another
	// user's `state` is refused. It carries no token and no secret; the
	// `code_verifier` is a per-attempt nonce whose only power is to complete an
	// exchange the same user already began.
	//
	// `intent` is what the completed exchange should DO (connect a personal
	// mailbox, re-authorize one, connect or re-authorize a team inbox, connect a
	// deliverability seed) — captured at start so the callback page, which knows
	// only `code` + `state`, cannot choose a different one. `returnTo` is the
	// same-site relative path the callback navigates back to.
	externalMailOAuthStates: defineTable({
		userId: v.string(),
		organizationId: v.string(),
		provider: v.literal('google'),
		state: v.string(),
		codeVerifier: v.string(),
		intent: googleOAuthIntentValidator,
		returnTo: v.string(),
		createdAt: v.number(),
		expiresAt: v.number(),
	})
		.index('by_state', ['state'])
		.index('by_user', ['userId']),

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
		// Which kind of mailbox this import belongs to. MISSING = 'personal' —
		// every row written before shared imports existed is a personal migration.
		// A `shared` row imports a TEAM inbox's history (`mail/migrationShared.ts`,
		// owner/admin-gated by mailbox id) and differs from a personal one in two
		// ways the completion paths read off this field rather than re-deriving
		// from a mailbox that may already be soft-deleted:
		//   · it NEVER stamps an onboarding step — a team inbox is org
		//     infrastructure, not the admin's own mailbox setup;
		//   · knowledge indexing defaults OFF (opt-in per import) — fanning a
		//     team's whole history into the org knowledge graph is a privacy and
		//     cost decision the person starting the import has to make.
		scope: v.optional(v.union(v.literal('personal'), v.literal('shared'))),
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

	// Upload-based archive import (idea 50) — the migration path for people who
	// have no live account left to connect.
	//
	// `mailboxMigrations` above walks a CONNECTED external mailbox over IMAP. That
	// covers a move; it does nothing for the far more common shape of the problem:
	// a Gmail Takeout `.mbox` on a laptop, a `.eml` saved out of a dead client, an
	// archive from a provider that closed. This table is the same job idea over
	// bytes the user hands us instead of a server we can log into.
	//
	// RESUMABILITY is `cursorBytes`: the byte offset into the uploaded archive up
	// to which every message has been committed. The parse (`@owlat/mail-message`)
	// and the split (`@owlat/shared/mboxArchive`) both run in an action that
	// budgets itself and reschedules, so an archive larger than one action's
	// lifetime finishes across as many runs as it takes and a failed run re-reads
	// only the messages after the last commit. The offsets are BYTES because the
	// action decodes the archive as latin1 — one char per byte.

	mailArchiveImports: defineTable({
		userId: v.string(), // BetterAuth user (mailbox owner who uploaded it)
		mailboxId: v.id('mailboxes'),
		// The uploaded archive. Deleted when the job reaches a terminal state —
		// the imported messages are the artifact, not the upload.
		storageId: v.optional(v.id('_storage')),
		// What the user picked it from, for the wizard's copy only.
		filename: v.string(),
		// `mbox` splits on `From_` separators; `eml` is one message, whole file.
		format: archiveFormatValidator,
		totalBytes: v.number(),
		// Resume point: bytes fully committed. Never moves backwards.
		cursorBytes: v.number(),
		messagesImported: v.number(),
		// Duplicates (same Message-ID already in the mailbox) and entries the
		// parser could not turn into a message. Counted, never silently dropped.
		messagesSkipped: v.number(),
		// Gmail Takeout labels created on the way in (`X-Gmail-Labels`).
		labelsCreated: v.number(),
		status: v.union(
			v.literal('importing'),
			v.literal('completed'),
			v.literal('failed'),
			v.literal('cancelled')
		),
		lastError: v.optional(v.string()),
		startedAt: v.number(),
		completedAt: v.optional(v.number()),
		updatedAt: v.number(),
	})
		// The wizard reads the caller's most recent job for their mailbox.
		.index('by_mailbox', ['mailboxId'])
		.index('by_user', ['userId']),

	// Staged "move my mailbox here" job — the full move of a connected external
	// mailbox onto an Owlat-hosted mailbox on the SAME address, ending with the
	// external account demoted to a READ-ONLY ARCHIVE. Distinct from
	// `mailboxMigrations` (a one-time HISTORICAL import that leaves the external
	// account live and syncing): a move stops sync at the end, points inbound MX
	// at this deployment, and keeps the old mailbox's history queryable — nothing
	// is deleted. 1:1 with the external account being moved.
	//
	// Stages advance one way — provisioning → cutover_pending → archived — but
	// each transition is IDEMPOTENT (re-running the current stage is a no-op) and
	// the whole job is PAUSABLE (`isPaused`) so a member can stop between DNS steps
	// and resume later without losing place. Rollback = cancel the job before it
	// reaches `archived` (mail/mailboxMove.ts:cancel): the archive demotion is the
	// only irreversible step and it never runs until the final stage, so repointing
	// MX back loses nothing.

	mailboxMoves: defineTable({
		userId: v.string(), // BetterAuth user (mailbox owner running the move)
		organizationId: v.string(),
		accountId: v.id('externalMailAccounts'), // the external account being moved
		sourceMailboxId: v.id('mailboxes'), // the external mailbox (becomes the archive)
		address: v.string(), // canonical address kept through the move
		domain: v.string(), // domain part — the one whose MX must point here
		stage: v.union(
			v.literal('provisioning'), // waiting for a hosted mailbox on this address
			v.literal('cutover_pending'), // hosted mailbox exists; waiting on MX cutover
			v.literal('archived') // external demoted to read-only archive; move done
		),
		isPaused: v.boolean(),
		// Hosted mailbox provisioned on the same address (set at the
		// provisioning → cutover_pending transition; the live inbox after cutover).
		hostedMailboxId: v.optional(v.id('mailboxes')),
		// The admin mailbox request raised when the mover can't create a hosted
		// mailbox themselves (hosted creation is admin-only) — surfaced, never
		// bypassed. Resolved once an admin provisions. Absent when the mover is an
		// admin who provisioned directly.
		provisionRequestId: v.optional(v.id('mailboxRequests')),
		createdAt: v.number(),
		updatedAt: v.number(),
		archivedAt: v.optional(v.number()),
	})
		// The mover reads/advances their own move (at most one live per user).
		.index('by_user', ['userId'])
		// 1:1 lookup from the external account (idempotent start).
		.index('by_account', ['accountId']),

	// IMAP-visible folders. System folders carry a `role`; user folders
	// have role=undefined and arbitrary names.
};
