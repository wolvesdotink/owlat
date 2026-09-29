import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { destinationProviderValidator } from '../lib/validators/deliverability';
import {
	externalSyncModeValidator,
	remoteFlagChangesValidator,
	remoteFolderRefValidator,
} from '../lib/validators/mail';

/**
 * External mail accounts and mailbox data movement.
 *
 * IMAP/OAuth accounts Owlat syncs from, their per-folder sync cursors and
 * sealed access tokens, and the queued write-backs to the provider. The
 * one-shot jobs that fill or relocate a mailbox live in `schema/mailboxJobs.ts`.
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

/**
 * Connection/sync status of an external mail account. Owned here, beside the
 * `externalMailAccounts.status` column; `mail/external/accounts.ts` imports it
 * for the worker's status write.
 */
export const externalAccountStatusValidator = v.union(
	v.literal('pending'), // created; worker not yet connected
	v.literal('connected'), // IMAP IDLE live
	v.literal('auth_error'), // bad credentials — needs user fix
	v.literal('error'), // transient/connection error (backoff)
	v.literal('disconnected') // user paused / removed
);

export const mailAccountsTables = {
	externalMailAccounts: defineTable({
		userId: v.string(), // BetterAuth user (connector / credential custodian)
		organizationId: v.string(),
		mailboxId: v.id('mailboxes'), // the reused inbox identity

		// DEPRECATED — nothing reads it any more. It mirrored `mailboxes.scope`,
		// and two copies of one fact let a mailbox be a team inbox on one table and
		// someone's private account on the other. Whether an account is personal is
		// now read off its mailbox (`mail/external/personalAccount.ts`); a team
		// inbox's `userId` here is the admin who connected it (credential custodian
		// + audit), and ownership of the inbox follows `mailboxes.userId` via
		// mailboxMembers. It is still WRITTEN for one release, on connect-as-team
		// and on conversion, so rolling back to the previous release (which reads
		// it) keeps treating team inboxes as team inboxes. Contract after that: stop
		// writing, clear it with a migration, then drop it (CONVENTIONS.md §
		// Schema evolution).
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
		// there is exactly one encrypt site and one decrypt site for both
		// methods. The short-lived ACCESS token minted from it is cached in its
		// own sealed row (`externalMailAccessTokens`), never on this one.
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

		// How far sync reaches. undefined ⇒ 'full': new mail comes in, changes made
		// on the provider (moves, flags, deletes) are mirrored here, and changes made
		// here are written back (`mail/external/remoteOps.ts`, `remoteState.ts`).
		// 'incoming' ⇒ only new mail comes in and the mailbox is managed in Owlat.
		syncMode: v.optional(externalSyncModeValidator),
		// When the first full reconcile after turning full sync on (or after the
		// upgrade that introduced it) finished. Until then diverging messages are
		// merged rather than pulled; see `applyRemoteObservations`.
		fullSyncAlignedAt: v.optional(v.number()),

		// Connection/sync status — the mail-sync worker is the writer.
		status: externalAccountStatusValidator,
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

	// The last OAuth access token minted for an `authMethod: 'oauth2'` account,
	// sealed in the same AES-256-GCM box as the refresh token it came from.
	//
	// A cache, not state: `getCredentialsForWorker` reuses it until a minute
	// before `expiresAt` instead of asking Google for a new token on every
	// worker connect and every /send. At most one row per account, kept off the
	// account row so the hourly write neither re-runs the account's subscribers
	// nor contends with the worker's status writes. `sourceIv` is the IV of the
	// refresh-token envelope it was minted from: a reconnect re-seals that
	// envelope under a fresh IV, so a token from the previous grant can never be
	// served. Deleted when the account is disconnected, purged or erased, and
	// when Google reports the grant revoked.
	externalMailAccessTokens: defineTable({
		accountId: v.id('externalMailAccounts'),
		sourceIv: v.string(),
		secretCiphertext: v.string(),
		secretIv: v.string(),
		secretAuthTag: v.string(),
		secretEnvelopeVersion: v.number(),
		expiresAt: v.number(),
		updatedAt: v.number(),
	}).index('by_account', ['accountId']),

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
		// UIDs skipped behind the forward high-water mark. The worker retries each
		// on later polls without head-of-line blocking new mail; after three failed
		// attempts it removes the entry and increments the operator-visible count.
		forwardIngestFailures: v.optional(v.array(v.object({ uid: v.number(), attempts: v.number() }))),
		forwardIngestFailureCount: v.optional(v.number()),

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

	// Local → remote write-back queue. Every move, flag change and permanent
	// delete a member makes in an external mailbox is recorded here, in the same
	// transaction, and the mail-sync worker replays it on the provider over IMAP
	// (`mail/external/remoteOps.ts`). A row is deleted once applied, once the
	// message turns out not to be on the server, or when its retries run out.
	externalMailRemoteOps: defineTable({
		accountId: v.id('externalMailAccounts'),
		kind: v.union(
			v.literal('move'),
			v.literal('flags'),
			v.literal('delete'),
			// A mirrored folder renamed or deleted in Owlat.
			v.literal('renameFolder'),
			v.literal('deleteFolder')
		),
		// Canonical Message-ID (no angle brackets): how the worker finds the
		// message. Absent on the two folder kinds.
		rfc822MessageId: v.optional(v.string()),
		source: remoteFolderRefValidator, // the message's folder, or the folder itself
		// 'move': where to. 'renameFolder': `{ path: [newName] }`, the new leaf name.
		target: v.optional(remoteFolderRefValidator),
		flags: v.optional(remoteFlagChangesValidator), // 'flags' only
		attempts: v.number(),
		nextAttemptAt: v.number(), // the enqueue time until a failed attempt pushes it back
		lastError: v.optional(v.string()),
		createdAt: v.number(),
	})
		.index('by_account_and_next_attempt', ['accountId', 'nextAttemptAt'])
		// A pending write-back holds a message out of inbound reconcile.
		.index('by_account_and_message', ['accountId', 'rfc822MessageId']),
};
