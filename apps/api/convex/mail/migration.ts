/**
 * Mailbox migration orchestration — "Migrate from Google" and friends.
 *
 * A migration is a one-time historical import of a *connected* external mailbox
 * (see `mail/externalAccounts.ts`). The connection itself (IMAP/SMTP creds, the
 * mail-sync worker, forward sync of NEW mail) already exists; this module adds
 * the two extra phases that turn a connection into a migration:
 *
 *   importing — the worker walks each folder's history DOWN from the high-water
 *               mark to UID 1 (forward sync only ever pulls new mail), via the
 *               per-folder backfill cursors on `externalMailFolderSync`.
 *   indexing  — once import is done, `mail/migrationIndexing.ts` sweeps the
 *               imported messages into the contact-scoped knowledge graph.
 *
 * This file owns the IMPORT phase + lifecycle entry points. It hands off to the
 * indexing phase via `completeBackfillImport`. The public surface (start /
 * getStatus / cancel) is the wizard's; the internal surface
 * (getBackfillWork / initFolderBackfill / recordBackfillProgress /
 * completeBackfillImport) is the mail-sync worker's (admin-key only).
 */

import { v } from 'convex/values';
import { internalQuery, internalMutation } from '../_generated/server';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { assertFeatureEnabled, isFeatureEnabled } from '../lib/featureFlags';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';

// Chunk size for the post-import knowledge sweep (paced inside runIndexChunk).
const INDEX_CHUNK_SIZE = 25;

const sourceValidator = v.union(v.literal('google'), v.literal('imap'));

/** Active = the worker/indexer still has work to do. */
function isActiveStatus(status: string): boolean {
	return status === 'importing' || status === 'indexing';
}

// ============================================================
// Public surface (the migration wizard)
// ============================================================

/**
 * Most recent migration for the caller's connected mailbox, with derived
 * progress for the wizard, or `null`. Soft-auth (org members only).
 */
// public: soft-auth — returns null for anonymous/non-members; scoped to the caller's own account
export const getStatus = publicQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) return null;
		const account = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_user', (q) => q.eq('userId', s.userId))
			.first();
		if (!account) return null;
		const migration = await ctx.db
			.query('mailboxMigrations')
			.withIndex('by_account', (q) => q.eq('accountId', account._id))
			.order('desc')
			.first();
		if (!migration) return null;

		// Past the importing phase the import is, by definition, complete — show
		// 100 rather than a ratio that can fall short when the server returned
		// fewer fetchable bodies than its message count.
		const importPercent =
			migration.status !== 'importing'
				? 100
				: migration.messagesTotal > 0
					? Math.min(100, Math.round((migration.messagesImported / migration.messagesTotal) * 100))
					: 0;
		const indexPercent =
			migration.messagesImported > 0
				? Math.min(100, Math.round((migration.messagesIndexed / migration.messagesImported) * 100))
				: migration.status === 'completed'
					? 100
					: 0;

		return {
			_id: migration._id,
			status: migration.status,
			source: migration.source,
			isAiIndexingEnabled: migration.isAiIndexingEnabled,
			messagesTotal: migration.messagesTotal,
			messagesImported: migration.messagesImported,
			messagesIndexed: migration.messagesIndexed,
			importPercent,
			indexPercent,
			startedAt: migration.startedAt,
			importCompletedAt: migration.importCompletedAt,
			completedAt: migration.completedAt,
			lastError: migration.lastError,
		};
	},
});

/**
 * Begin migrating the caller's connected external mailbox. Idempotent: if a
 * migration is already in flight it's returned as-is. Otherwise a fresh job is
 * created and each discovered folder's backfill cursor is reset so the worker
 * re-imports the full history from the high-water mark on its next pass. AI
 * indexing is enabled only when the `ai.knowledge` feature is on.
 */
// authz: self — operates only on the caller's own connected external mailbox (by_user on the session userId)
export const start = authedMutation({
	args: { source: v.optional(sourceValidator) },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.activeOrganizationId || !s.role) throwForbidden('Not authenticated');

		const account = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_user', (q) => q.eq('userId', s.userId))
			.first();
		if (!account || account.status === 'disconnected') {
			throwInvalidInput('Connect a mailbox before starting a migration.');
		}
		// The worker (listConnectableAccounts) deliberately excludes `auth_error`
		// accounts, so a migration started on one would sit at `importing`
		// forever with no connection ever opened. Refuse it and steer the user
		// back to re-entering credentials first.
		if (account.status === 'auth_error') {
			throwInvalidInput(
				"Your mailbox connection isn't working — re-enter your credentials before starting a migration.",
			);
		}

		// Idempotent: reuse an in-flight migration rather than spawning a second.
		const existing = await ctx.db
			.query('mailboxMigrations')
			.withIndex('by_account', (q) => q.eq('accountId', account._id))
			.order('desc')
			.first();
		if (existing && isActiveStatus(existing.status)) {
			return { migrationId: existing._id, status: existing.status };
		}

		// Reset per-folder backfill cursors so the worker re-walks the full
		// history (a prior run leaves them at 0). Forward-sync's `lastSeenUid`
		// is untouched — new mail keeps flowing.
		const syncRows = await ctx.db
			.query('externalMailFolderSync')
			.withIndex('by_account', (q) => q.eq('accountId', account._id))
			.collect(); // bounded: per-account folder cursors (≤ a handful)
		for (const r of syncRows) {
			await ctx.db.patch(r._id, {
				backfillCursor: undefined,
				backfillTotal: undefined,
				backfillDone: undefined,
			});
		}

		const isAiIndexingEnabled = await isFeatureEnabled(ctx, 'ai.knowledge');
		const now = Date.now();
		const migrationId = await ctx.db.insert('mailboxMigrations', {
			userId: s.userId,
			organizationId: s.activeOrganizationId,
			accountId: account._id,
			mailboxId: account.mailboxId,
			source: args.source ?? 'imap',
			status: 'importing',
			isAiIndexingEnabled,
			messagesTotal: 0,
			messagesImported: 0,
			messagesIndexed: 0,
			startedAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('mailAuditLog', {
			mailboxId: account.mailboxId,
			event: 'migration.started',
			details: `source=${args.source ?? 'imap'} ai=${isAiIndexingEnabled}`,
			occurredAt: now,
		});
		return { migrationId, status: 'importing' as const };
	},
});

/**
 * Cancel an in-flight migration. The worker's `getBackfillWork` then reports
 * inactive (import stops) and the indexer's `runIndexChunk` sees a non-indexing
 * status and exits. Already-imported mail + extracted knowledge are kept.
 */
// authz: self — cancels only the caller's own migration (resolved via by_user on the session userId)
export const cancel = authedMutation({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) throwForbidden('Not authenticated');
		const account = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_user', (q) => q.eq('userId', s.userId))
			.first();
		if (!account) return false;
		const migration = await ctx.db
			.query('mailboxMigrations')
			.withIndex('by_account', (q) => q.eq('accountId', account._id))
			.order('desc')
			.first();
		if (!migration || !isActiveStatus(migration.status)) return false;
		const now = Date.now();
		await ctx.db.patch(migration._id, {
			status: 'cancelled',
			completedAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('mailAuditLog', {
			mailboxId: account.mailboxId,
			event: 'migration.cancelled',
			occurredAt: now,
		});
		return true;
	},
});

// ============================================================
// Internal surface — the mail-sync worker (admin-key only)
// ============================================================

/**
 * Whether a migration is currently importing for this account, and which one.
 * The worker polls this to decide whether to run the historical backfill; it
 * discovers the remote folders and resumes each folder's cursor itself (via
 * `initFolderBackfill`). The `migrationId` pins every write of this run to the
 * job it belongs to, so a cancel+restart can't make an in-flight batch credit a
 * freshly-started migration.
 */
export const getBackfillWork = internalQuery({
	args: { accountId: v.id('externalMailAccounts') },
	handler: async (ctx, args) => {
		const migration = await ctx.db
			.query('mailboxMigrations')
			.withIndex('by_account', (q) => q.eq('accountId', args.accountId))
			.order('desc')
			.first();
		if (!migration || migration.status !== 'importing') {
			return { isActive: false as const, migrationId: null };
		}
		return { isActive: true as const, migrationId: migration._id };
	},
});

/**
 * Initialize a folder's backfill on first sight: snapshot its high-water UID as
 * the descending cursor, and its actual message count as the progress
 * denominator (IMAP UIDs are sparse, so the UID ceiling overstates the count).
 * Idempotent — a resume returns the persisted cursor without double-counting.
 * Returns the UID to start fetching down from, or null if the given migration is
 * no longer importing / there's no sync row.
 */
export const initFolderBackfill = internalMutation({
	args: {
		accountId: v.id('externalMailAccounts'),
		migrationId: v.id('mailboxMigrations'),
		remoteName: v.string(),
		ceilingUid: v.number(),
		messageCount: v.number(),
	},
	handler: async (ctx, args): Promise<{ startCursor: number } | null> => {
		const migration = await ctx.db.get(args.migrationId);
		if (!migration || migration.status !== 'importing') return null;

		const row = await ctx.db
			.query('externalMailFolderSync')
			.withIndex('by_account_and_remote', (q) =>
				q.eq('accountId', args.accountId).eq('remoteName', args.remoteName),
			)
			.first();
		if (!row) return null;

		// Already initialized (resume after a worker restart) — require BOTH the
		// cursor AND the total. A cancel+restart clears the row's backfill* fields
		// (start()), and a still-in-flight batch from the prior run can re-write
		// backfillCursor alone; re-initialise in that case so the new migration's
		// messagesTotal denominator isn't left stuck at 0.
		if (row.backfillCursor !== undefined && row.backfillTotal !== undefined) {
			return { startCursor: row.backfillCursor };
		}

		const ceiling = Math.max(0, args.ceilingUid);
		const total = Math.max(0, args.messageCount);
		await ctx.db.patch(row._id, {
			backfillCursor: ceiling,
			backfillTotal: total,
			backfillDone: 0,
		});
		await ctx.db.patch(migration._id, {
			messagesTotal: migration.messagesTotal + total,
			updatedAt: Date.now(),
		});
		return { startCursor: ceiling };
	},
});

/**
 * Persist one backfill batch: drop the folder cursor to `newCursor` and add the
 * batch's imported count to both the folder and the migration totals. Returns
 * whether the migration is still importing — the worker stops at this batch
 * boundary if it isn't (so Cancel takes effect promptly even mid-folder, rather
 * than only after the current — possibly huge — folder finishes).
 */
export const recordBackfillProgress = internalMutation({
	args: {
		accountId: v.id('externalMailAccounts'),
		migrationId: v.id('mailboxMigrations'),
		remoteName: v.string(),
		newCursor: v.number(),
		importedDelta: v.number(),
	},
	handler: async (ctx, args): Promise<{ stillImporting: boolean }> => {
		// Bail before touching the folder row when this batch's migration is no
		// longer importing (cancelled, or superseded by a newer start()): a fresh
		// migration may already own these sync rows, and writing here would clobber
		// its reset cursors or mis-credit its counters.
		const migration = await ctx.db.get(args.migrationId);
		if (!migration || migration.status !== 'importing') {
			return { stillImporting: false };
		}

		const row = await ctx.db
			.query('externalMailFolderSync')
			.withIndex('by_account_and_remote', (q) =>
				q.eq('accountId', args.accountId).eq('remoteName', args.remoteName),
			)
			.first();
		if (!row) return { stillImporting: false };

		await ctx.db.patch(row._id, {
			backfillCursor: Math.max(0, args.newCursor),
			backfillDone: (row.backfillDone ?? 0) + args.importedDelta,
		});
		await ctx.db.patch(migration._id, {
			messagesImported: migration.messagesImported + args.importedDelta,
			updatedAt: Date.now(),
		});
		return { stillImporting: true };
	},
});

/**
 * Worker signals "historical backfill threw and won't self-heal". Transition the
 * still-importing migration → failed with the error message, so the wizard's
 * existing 'failed → Try again' recovery surfaces instead of spinning on
 * 'importing' forever. Guarded like the other terminal transitions: a row that
 * already left the importing phase (cancelled, or superseded by a newer start())
 * is left untouched. The truncation keeps an oversized IMAP error from bloating
 * the row / the audit log.
 */
export const markImportFailed = internalMutation({
	args: {
		migrationId: v.id('mailboxMigrations'),
		errorMessage: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const migration = await ctx.db.get(args.migrationId);
		if (!migration || migration.status !== 'importing') return;
		const message = args.errorMessage?.slice(0, 500);
		const now = Date.now();
		await ctx.db.patch(migration._id, {
			status: 'failed',
			completedAt: now,
			updatedAt: now,
			lastError: message ?? migration.lastError,
		});
		await ctx.db.insert('mailAuditLog', {
			mailboxId: migration.mailboxId,
			event: 'migration.import_failed',
			details: message ? `error=${message}` : undefined,
			occurredAt: now,
		});
	},
});

/**
 * Worker signals "all folders backfilled". Transition import → indexing (and
 * kick off the knowledge sweep) when AI indexing is on and `ai.knowledge` is
 * still enabled, otherwise straight to completed.
 */
export const completeBackfillImport = internalMutation({
	args: { migrationId: v.id('mailboxMigrations') },
	handler: async (ctx, args) => {
		const migration = await ctx.db.get(args.migrationId);
		if (!migration || migration.status !== 'importing') return;

		const now = Date.now();
		const wantsIndexing =
			migration.isAiIndexingEnabled && (await isFeatureEnabled(ctx, 'ai.knowledge'));

		if (wantsIndexing) {
			await ctx.db.patch(migration._id, {
				status: 'indexing',
				importCompletedAt: now,
				updatedAt: now,
			});
			await ctx.scheduler.runAfter(0, internal.mail.migrationIndexing.runIndexChunk, {
				migrationId: migration._id,
				chunkSize: INDEX_CHUNK_SIZE,
			});
		} else {
			await ctx.db.patch(migration._id, {
				status: 'completed',
				importCompletedAt: now,
				completedAt: now,
				updatedAt: now,
			});
		}
		await ctx.db.insert('mailAuditLog', {
			mailboxId: migration.mailboxId,
			event: 'migration.import_complete',
			details: `imported=${migration.messagesImported} indexing=${wantsIndexing}`,
			occurredAt: now,
		});
	},
});
