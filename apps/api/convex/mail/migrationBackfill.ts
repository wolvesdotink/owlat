/**
 * Mailbox-migration BACKFILL surface — the mail-sync worker's half.
 *
 * Admin-key-only internal functions, scope-agnostic (they key off the account
 * alone, so a personal and a team-inbox import drive the identical path). The
 * worker discovers the remote folders itself and calls these to learn whether an
 * import is live (`getBackfillWork`), to snapshot a folder's cursor
 * (`initFolderBackfill`), to persist each descending batch
 * (`recordBackfillProgress`), and to end the phase — `completeBackfillImport`
 * on a clean walk, `markImportFailed` when the walk itself will not self-heal.
 *
 * The user-facing half (start / getStatus / cancel) and the scope-agnostic core
 * both live in `mail/migration.ts`; the phase AFTER this one — the knowledge
 * sweep and the `indexing → completed` transitions — lives in
 * `mail/migrationIndexing.ts`.
 *
 * Split out of `mail/migration.ts` under CONVENTIONS.md's ~500-LOC ceiling.
 */

import { v } from 'convex/values';
import { internalQuery, internalMutation } from '../_generated/server';
import type { MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { isFeatureEnabled } from '../lib/featureFlags';
import { markOnboardingStep } from '../auth/userOnboarding';
import { latestMigrationRow } from './migration';
import { scheduleVoiceProfileRefresh } from './ai/voiceProfile';

// Chunk size for the post-import knowledge sweep (paced inside runIndexChunk).
const INDEX_CHUNK_SIZE = 25;

/**
 * Move a still-importing migration to `failed` with the reason, and record it.
 * Shared by the worker's explicit "the import threw" signal and by the
 * completion path's refusal to call a walk that stored nothing an import.
 */
async function failMigration(
	ctx: MutationCtx,
	migration: Doc<'mailboxMigrations'>,
	message: string | undefined
): Promise<void> {
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
}

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
		const migration = await latestMigrationRow(ctx, args.accountId);
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
				q.eq('accountId', args.accountId).eq('remoteName', args.remoteName)
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
		/** Messages in this batch the worker STORED. */
		importedDelta: v.number(),
		/** Messages in this batch it walked past without storing. Optional so a
		 * worker container still on the previous release — the gap between
		 * `docker compose up` replacing the image and the functions deploying —
		 * keeps making progress instead of failing every batch on arg validation. */
		failedDelta: v.optional(v.number()),
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
				q.eq('accountId', args.accountId).eq('remoteName', args.remoteName)
			)
			.first();
		if (!row) return { stillImporting: false };

		const failedDelta = args.failedDelta ?? 0;
		await ctx.db.patch(row._id, {
			backfillCursor: Math.max(0, args.newCursor),
			// The folder's own counter tracks the WALK, so it reaches the folder's
			// message count and the per-folder progress still completes.
			backfillDone: (row.backfillDone ?? 0) + args.importedDelta + failedDelta,
		});
		await ctx.db.patch(migration._id, {
			messagesImported: migration.messagesImported + args.importedDelta,
			messagesFailed: (migration.messagesFailed ?? 0) + failedDelta,
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
		await failMigration(ctx, migration, args.errorMessage?.slice(0, 500));
	},
});

/**
 * Worker signals "all folders backfilled". Transition import → indexing (and
 * kick off the knowledge sweep) when AI indexing is on and `ai.knowledge` is
 * still enabled, otherwise straight to completed.
 *
 * A walk that reached the end of every folder without STORING anything is not a
 * completed import, however cleanly it finished — that is the shape a broken
 * ingest takes, and it used to render as "100%, N messages imported" over an
 * empty mailbox. It fails here instead, so the wizard's existing
 * 'failed → Try again' step is what the user sees.
 */
export const completeBackfillImport = internalMutation({
	args: { migrationId: v.id('mailboxMigrations') },
	handler: async (ctx, args) => {
		const migration = await ctx.db.get(args.migrationId);
		if (!migration || migration.status !== 'importing') return;

		const now = Date.now();
		const messagesFailed = migration.messagesFailed ?? 0;
		if (migration.messagesImported === 0 && messagesFailed > 0) {
			await failMigration(
				ctx,
				migration,
				`Walked ${messagesFailed} message(s) without storing any of them.`
			);
			return;
		}

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
		if (messagesFailed > 0) {
			// Some mail landed and some did not. The import is genuinely done, so it
			// is not a failure — but the row must not read as if nothing was lost.
			await ctx.db.patch(migration._id, {
				lastError: `${messagesFailed} message(s) could not be stored and stayed on the server.`,
			});
		}
		await ctx.db.insert('mailAuditLog', {
			mailboxId: migration.mailboxId,
			event: 'migration.import_complete',
			details: `imported=${migration.messagesImported} failed=${messagesFailed} indexing=${wantsIndexing}`,
			occurredAt: now,
		});
		// A `shared` migration imports a TEAM inbox — org infrastructure, not the
		// admin's own mailbox setup — so it never touches anyone's checklist.
		if (migration.scope !== 'shared') {
			await markOnboardingStep(ctx, migration.userId, 'importDone');
		}
		// The import just dropped the mailbox's whole Sent history in at once, which
		// is exactly the corpus the writing-voice profile samples. Refresh it in the
		// background now (no-op when personalization is off for this mailbox) so the
		// first draft after the import doesn't pay the derivation latency.
		await scheduleVoiceProfileRefresh(ctx, migration.mailboxId);
	},
});
