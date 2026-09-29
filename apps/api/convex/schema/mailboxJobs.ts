import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { archiveFormatValidator } from '../lib/literalValidators';

/**
 * Mailbox data movement: the one-shot migration / archive-import / move jobs
 * that fill or relocate a mailbox. Split out of `schema/mailAccounts.ts` (size
 * cap); the accounts they read from stay there.
 *
 * Spread into `mailTables` from schema/mail.ts.
 */
export const mailboxJobsTables = {
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
		// Messages that are IN the mailbox because of this walk — stored by it, or
		// already present when it got there (Gmail's "All Mail" repeats every other
		// folder, so a dedup hit is mail the user has, not mail that was lost).
		messagesImported: v.number(),
		// Messages the worker walked past without storing — an ingest that threw,
		// or a UID the server listed but returned no body for. MISSING = 0 (rows
		// written before the two were told apart, when a failed ingest still
		// counted as an import and a wholly failed run looked like a clean one).
		// Progress is `(messagesImported + messagesFailed) / messagesTotal`, so the
		// bar still completes while the imported count stays true.
		messagesFailed: v.optional(v.number()),
		messagesIndexed: v.number(), // messages swept into the knowledge graph

		// Index-sweep cursor over mailMessages (mirrors knowledge/messageBackfill).
		indexCursorReceivedAt: v.optional(v.number()),
		indexCursorId: v.optional(v.id('mailMessages')),

		lastError: v.optional(v.string()),

		// Throttle PAUSE — a sub-state of `importing`, not a status of its own.
		// The provider's daily bandwidth budget ran out, so the worker holds the
		// walk until `resumesAt` and then picks it up unaided; the wizard reads it
		// as "resuming at …" rather than as an error. Cleared by the first batch
		// the resumed walk records. `throttlePauses` counts consecutive pauses
		// with no batch between them — past a small cap the provider is not
		// coming back on its own and the import fails after all
		// (`mail/migrationBackfill.ts`, pauseImportForThrottle).
		resumesAt: v.optional(v.number()),
		throttlePauses: v.optional(v.number()),
		// Why a `failed` import failed, when the web should say it in the user's
		// language instead of showing `lastError` (the provider's raw words) as
		// the reason. `throttle_exhausted`: the provider refused every download
		// for `throttlePauses` daily windows in a row.
		failureCode: v.optional(v.literal('throttle_exhausted')),

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
