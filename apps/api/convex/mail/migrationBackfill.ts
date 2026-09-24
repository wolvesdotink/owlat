/**
 * Mailbox-migration BACKFILL surface — the mail-sync worker's half.
 *
 * Admin-key-only internal functions, scope-agnostic (they key off the account
 * alone, so a personal and a team-inbox import drive the identical path). The
 * worker discovers the remote folders itself and calls these to learn whether an
 * import is live (`getBackfillWork`), to snapshot a folder's cursor
 * (`initFolderBackfill`), to persist each descending batch
 * (`recordBackfillProgress`), to hold the walk while the provider's budget
 * resets (`pauseImportForThrottle`), and to end the phase —
 * `completeBackfillImport` on a clean walk, `markImportFailed` when the walk
 * itself will not self-heal.
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
import { canonicalMessageId } from '../lib/messageId';

// Chunk size for the post-import knowledge sweep (paced inside runIndexChunk).
const INDEX_CHUNK_SIZE = 25;

/** Upper bound on one `findKnownMessageIds` call — one backfill batch's worth. */
const MAX_KNOWN_MESSAGE_ID_LOOKUP = 500;

/**
 * Consecutive throttle pauses, with not one batch recorded between them, after
 * which the import is failed after all. Each pause waits out a full daily
 * window, so this is three days of a provider refusing every fetch — no longer
 * a budget that resets, and not something more waiting will fix.
 */
export const MAX_THROTTLE_PAUSES = 3;

/**
 * The furthest ahead a pause may be set. The worker asks for one daily window;
 * this only stops a skewed clock or a bad caller from parking an import for a
 * week.
 */
const MAX_THROTTLE_PAUSE_MS = 48 * 60 * 60_000;

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
		resumesAt: undefined,
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
		return {
			isActive: true as const,
			migrationId: migration._id,
			// A throttle pause survives a worker restart only if the worker is told.
			...(migration.resumesAt !== undefined ? { resumesAt: migration.resumesAt } : {}),
		};
	},
});

/**
 * Which of these Message-IDs the account's mailbox already holds.
 *
 * The walk's bandwidth valve. `ingestExternalMessage` dedupes on Message-ID,
 * but it can only do so AFTER the worker has downloaded the whole message and
 * uploaded its raw bytes — so re-walking a folder costs the provider's full
 * bandwidth for mail that is already imported and will be thrown away on
 * arrival. On a metered provider that is fatal rather than merely wasteful: a
 * 21 GiB Gmail Sent folder behind a daily IMAP bandwidth cap spends the whole
 * budget re-fetching the first 12 GiB it already has, is cut off with
 * `* BYE [OVERQUOTA]`, and never reaches the mail it is missing — no matter how
 * many times the import is restarted.
 *
 * So the worker asks first, with envelopes it fetched for a few hundred bytes a
 * message, and downloads bodies only for the ones this returns as unknown.
 *
 * Canonicalisation MUST match the writers' (`lib/messageId.ts`) or a message
 * would look unknown here and duplicate on ingest. Returns the caller's own
 * strings, so it never has to canonicalise anything itself.
 */
export const findKnownMessageIds = internalQuery({
	args: {
		accountId: v.id('externalMailAccounts'),
		/** Raw Message-ID headers, as the remote server reported them. */
		messageIds: v.array(v.string()),
	},
	handler: async (ctx, args): Promise<string[]> => {
		const account = await ctx.db.get(args.accountId);
		if (!account) return [];

		// One batch of the descending walk. Bounded so a malformed caller cannot
		// turn a single query into an unbounded index scan.
		const ids = args.messageIds.slice(0, MAX_KNOWN_MESSAGE_ID_LOOKUP);
		const known: string[] = [];
		for (const raw of ids) {
			const canonical = canonicalMessageId(raw);
			const hit = await ctx.db
				.query('mailMessages')
				.withIndex('by_rfc822_message_id', (q) => q.eq('rfc822MessageId', canonical))
				.filter((q) => q.eq(q.field('mailboxId'), account.mailboxId))
				.first();
			if (hit) known.push(raw);
		}
		return known;
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
		/** Messages in this batch it walked past without storing. Required so an
		 * older worker cannot report failed ingests as successful imports during a
		 * rolling deploy; the resumable cursor makes a brief loud failure safe. */
		failedDelta: v.number(),
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

		const failedDelta = args.failedDelta;
		await ctx.db.patch(row._id, {
			backfillCursor: Math.max(0, args.newCursor),
			// The folder's own counter tracks the WALK, so it reaches the folder's
			// message count and the per-folder progress still completes.
			backfillDone: (row.backfillDone ?? 0) + args.importedDelta + failedDelta,
		});
		await ctx.db.patch(migration._id, {
			messagesImported: migration.messagesImported + args.importedDelta,
			messagesFailed: (migration.messagesFailed ?? 0) + failedDelta,
			// The walk is moving again, so any throttle pause is over and its
			// no-progress streak with it.
			resumesAt: undefined,
			throttlePauses: undefined,
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
 * Worker signals "the provider's budget is spent" — its throttled retry ladder
 * ran out against a provider still answering `[OVERQUOTA]` / "exceeded command
 * or bandwidth limits". That is a schedule, not a failure: a mailbox larger
 * than one day's budget used to end every day on a red "import stopped" card
 * the user had to restart by hand. Instead the migration stays `importing`
 * with `resumesAt` set, the wizard says when it picks up again, and the worker
 * resumes it on its own.
 *
 * Only a provider that lets NOTHING through for {@link MAX_THROTTLE_PAUSES}
 * windows in a row fails the import — `recordBackfillProgress` clears the count
 * the moment a batch lands, so a large import that inches forward a day at a
 * time is never failed by this.
 */
export const pauseImportForThrottle = internalMutation({
	args: {
		migrationId: v.id('mailboxMigrations'),
		/** Epoch ms the worker will run the walk again. */
		resumeAt: v.number(),
		/** The provider's own words, for the audit log. */
		reason: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<{ outcome: 'paused' | 'failed' | 'ignored' }> => {
		const migration = await ctx.db.get(args.migrationId);
		if (!migration || migration.status !== 'importing') return { outcome: 'ignored' };

		const now = Date.now();
		const reason = args.reason?.slice(0, 500);
		const pauses = (migration.throttlePauses ?? 0) + 1;
		if (pauses > MAX_THROTTLE_PAUSES) {
			await failMigration(
				ctx,
				migration,
				`Your mail provider has refused every download for ${MAX_THROTTLE_PAUSES} days in a row, so the import stopped where it got to.${reason ? ` (${reason})` : ''}`
			);
			return { outcome: 'failed' };
		}

		const resumesAt = Math.min(Math.max(args.resumeAt, now), now + MAX_THROTTLE_PAUSE_MS);
		await ctx.db.patch(migration._id, {
			resumesAt,
			throttlePauses: pauses,
			updatedAt: now,
		});
		await ctx.db.insert('mailAuditLog', {
			mailboxId: migration.mailboxId,
			event: 'migration.import_paused',
			details: `resumesAt=${new Date(resumesAt).toISOString()} pause=${pauses}${reason ? ` reason=${reason}` : ''}`,
			occurredAt: now,
		});
		return { outcome: 'paused' };
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
