/**
 * A migration's historical backfill for one account connection: when it may
 * run, the walk over every mapped folder (backfill.ts walks one), the retry
 * pacing and throttle pauses (backfillRetry.ts owns the policy), and the
 * bandwidth-aware IMAP fetch the walk uses.
 *
 * The connection (connection.ts) owns the IMAP client, the folder list and the
 * INBOX forward poll; the runner reaches them through {@link BackfillHost}.
 */

import type { ImapFlow } from 'imapflow';
import type { BackfillWork, ConvexClient, IngestOutcome } from './convex.js';
import { fn } from './convex.js';
import type { MailSyncConfig } from './config.js';
import type { FolderRole } from './folders.js';
import {
	commitIngest,
	discardStagedIngest,
	ingestMessage,
	isMessageLanded,
	stageIngest,
	type RawUploadConfig,
} from './ingest.js';
import { FORWARD_INGEST_CONCURRENCY } from './ingestPipeline.js';
import {
	backfillFolder,
	type BackfillFetchedMessage,
	type BackfillFolderDeps,
} from './backfill.js';
import {
	canStartBackfill,
	describeThrottle,
	forMigration,
	initialBackfillRetryState,
	nextBackfillRetryState,
	type BackfillRetryState,
} from './backfillRetry.js';
import type { SyncedFolder } from './remoteSync.js';
import { logger } from './logger.js';

/**
 * UIDs per `UID FETCH` in the backfill's body phase. The phase-1 range is
 * addressed as `start:end`, but phase 2 asks for a sparse list, so the command
 * grows with the number of UIDs — chunked to keep it comfortably inside the
 * IMAP line length every server accepts.
 */
const SOURCE_FETCH_CHUNK = 50;

/** A folder's high-water UID, message count, and UIDVALIDITY. */
export interface FolderMeta {
	ceilingUid: number;
	messageCount: number;
	uidValidity: number;
}

/** What the runner reads from, and asks of, the connection it runs on. */
export interface BackfillHost {
	readonly accountId: string;
	readonly convex: ConvexClient;
	readonly config: MailSyncConfig;
	readonly rawUploadConfig: RawUploadConfig;
	client(): ImapFlow | null;
	folders(): readonly SyncedFolder[];
	isStopped(): boolean;
	readFolderMeta(remoteName: string): Promise<FolderMeta | null>;
	/**
	 * Forward-poll the INBOX. Called before each folder's ceiling snapshot, so
	 * mail that arrived meanwhile lands as forward sync (origin 'sync') before
	 * the walk can import its All Mail copy as backfill.
	 */
	pollInboxForward(): Promise<void>;
	/** The same poll between two batches of one folder, rate-limited. */
	pollInboxBetweenBatches(): Promise<void>;
	/** Return the client to INBOX so IDLE resumes there. */
	resumeInboxIdle(): Promise<void>;
}

export class BackfillRunner {
	private running = false;
	// Retry pacing + the strike count for the *current* importing migration
	// (backfillRetry.ts owns the policy). Held across runs, reset when a
	// different migration becomes the active one.
	private retry: BackfillRetryState = initialBackfillRetryState();
	// Batches this run has persisted — the difference between an import that is
	// advancing and one that is stuck. Read once the run ends.
	private batchesThisRun = 0;

	constructor(private readonly host: BackfillHost) {}

	/**
	 * If a migration is importing for this account, walk every mapped folder's
	 * history (newest→oldest) and signal completion. Guarded so only one backfill
	 * runs at a time; yields the IMAP connection back to INBOX/IDLE when done.
	 */
	async maybeRun(): Promise<void> {
		const host = this.host;
		const accountId = host.accountId;
		if (this.running || host.isStopped() || !host.client()) return;

		let work: BackfillWork;
		try {
			work = await host.convex.query(fn.getBackfillWork, { accountId });
		} catch (err) {
			logger.warn({ accountId, err }, 'getBackfillWork failed');
			return;
		}
		if (!work.isActive || !work.migrationId) return;
		const migrationId = work.migrationId;
		// A fresh migration (or a different one) starts the streak AND the
		// cooldown over — the user pressed 'Try again' and expects it to start.
		// Rebased before the cooldown check for exactly that reason.
		this.retry = forMigration(this.retry, migrationId);
		// Pace the retries. Both the periodic poll and every reconnect land here,
		// and the reconnect path has no delay of its own, so without this a
		// provider that drops us repeatedly burns the whole strike budget in
		// seconds and fails an import that was minutes from finishing.
		if (!canStartBackfill(this.retry, Date.now())) return;
		// A pause the provider's daily budget forced. It lives on the migration,
		// not only in this process, so a restarted worker waits it out too.
		if (work.resumesAt !== undefined && Date.now() < work.resumesAt) return;

		this.running = true;
		this.batchesThisRun = 0;
		logger.info({ accountId }, 'starting historical backfill');
		try {
			for (const folder of host.folders()) {
				if (host.isStopped() || !host.client()) break;
				// Let mail that arrived since the last pass land as forward sync
				// BEFORE this folder's ceiling is snapshotted — see pollInboxForward.
				await host.pollInboxForward();
				const meta = await host.readFolderMeta(folder.remoteName);
				if (!meta) continue;
				await backfillFolder(this.makeBackfillDeps(meta.uidValidity, migrationId), {
					remoteName: folder.remoteName,
					role: folder.role,
					ceilingUid: meta.ceilingUid,
					messageCount: meta.messageCount,
				});
			}
			if (!host.isStopped()) {
				// A clean pass clears the streak (covers transient blips that healed).
				const decision = nextBackfillRetryState(this.retry, { kind: 'success' }, Date.now());
				this.retry = decision.state;
				await host.convex.mutation(fn.completeBackfillImport, {
					migrationId,
				});
				logger.info({ accountId }, 'historical backfill complete');
			}
		} catch (err) {
			// A stop request (e.g. the user cancelled) shouldn't count as a failure.
			if (host.isStopped()) {
				logger.warn({ accountId, err }, 'backfill aborted');
			} else {
				const madeProgress = this.batchesThisRun > 0;
				const decision = nextBackfillRetryState(
					this.retry,
					{ kind: 'failure', error: err, madeProgress },
					Date.now()
				);
				this.retry = decision.state;
				logger.warn(
					{
						accountId,
						err,
						strikes: decision.state.strikes,
						batches: this.batchesThisRun,
						retryInMs: Math.max(0, decision.state.retryNotBefore - Date.now()),
					},
					'backfill failed'
				);
				if (decision.shouldPause && decision.resumeAt !== undefined) {
					await this.pauseThrottledImport(migrationId, decision.resumeAt, err);
				}
				// Only a run that stored nothing accrues a strike, and the retries
				// are paced, so this is reached after a sustained failure rather
				// than after a handful of reconnects.
				if (decision.shouldMarkFailed) {
					const message = err instanceof Error ? err.message : String(err);
					try {
						await host.convex.mutation(fn.markImportFailed, {
							migrationId,
							errorMessage: message,
						});
						logger.warn(
							{ accountId, migrationId },
							'backfill failed repeatedly; marking migration import as failed'
						);
					} catch (markErr) {
						logger.warn({ accountId, err: markErr }, 'markImportFailed failed');
					}
				}
			}
		} finally {
			this.running = false;
			await host.resumeInboxIdle();
		}
	}

	/**
	 * The provider's budget is spent and the throttled ladder with it: record a
	 * pause on the migration so the user sees "resuming at …" instead of a
	 * failure, and the walk picks itself up once the window has reset. This
	 * process already holds off until `resumeAt` (the retry state), so a failed
	 * write only loses the label, never the wait.
	 */
	private async pauseThrottledImport(
		migrationId: string,
		resumeAt: number,
		err: unknown
	): Promise<void> {
		try {
			const result = await this.host.convex.mutation(fn.pauseImportForThrottle, {
				migrationId,
				resumeAt,
				reason: describeThrottle(err).slice(0, 500),
			});
			const outcome = result.outcome;
			const context = { accountId: this.host.accountId, migrationId, outcome };
			if (outcome === 'paused') {
				logger.warn(
					{ ...context, resumeAt: new Date(resumeAt).toISOString() },
					'provider budget spent; backfill paused until it resets'
				);
			} else if (outcome === 'failed') {
				logger.warn(context, 'throttle pause cap reached; migration failed');
			} else {
				logger.info(context, 'throttle pause ignored; migration no longer importing');
			}
		} catch (pauseErr) {
			logger.warn(
				{ accountId: this.host.accountId, err: pauseErr },
				'pauseImportForThrottle failed'
			);
		}
	}

	/**
	 * Fetch one descending backfill range, paying the provider's bandwidth ONLY
	 * for messages the mailbox does not already have.
	 *
	 * This used to be a single `UID FETCH <range> (BODY.PEEK[])`, which pulled
	 * every message in the range at full size and let Convex decide, after the
	 * upload, that it was a `duplicate`. That is fine on an unmetered server and
	 * fatal on a metered one: a Gmail Sent folder of 21 GiB sits behind a daily
	 * IMAP bandwidth cap, so an import that restarts near the top spends the
	 * whole day's budget re-downloading the 12 GiB it already has, is cut off
	 * with `* BYE [OVERQUOTA] Account exceeded command or bandwidth limits.`,
	 * and never reaches the mail it is actually missing. Restarting it does the
	 * identical thing the next day. The import cannot converge.
	 *
	 * So the range is fetched twice, cheap first:
	 *
	 *  1. envelopes only — a few hundred bytes a message — for the UIDs, flags
	 *     and Message-IDs;
	 *  2. `BODY.PEEK[]` for just the UIDs whose Message-ID the mailbox does not
	 *     already hold.
	 *
	 * A message without a Message-ID header cannot be recognised, so it is
	 * downloaded — the ingest path's own dedup stays the backstop. If the
	 * lookup itself fails the batch degrades to downloading everything, which is
	 * exactly the old behaviour: a slow import beats a stalled one.
	 */
	private async fetchBackfillBatch(
		remoteName: string,
		start: number,
		end: number
	): Promise<BackfillFetchedMessage[]> {
		const client = this.host.client();
		if (!client) return [];
		const lock = await client.getMailboxLock(remoteName);
		try {
			// ── Phase 1: envelopes ──────────────────────────────────────────
			const listed: Array<{ uid: number; flags: Set<string>; messageId: string | null }> = [];
			for await (const msg of client.fetch(
				`${start}:${end}`,
				{ uid: true, flags: true, envelope: true },
				{ uid: true }
			)) {
				listed.push({
					uid: Number(msg.uid),
					flags: msg.flags ?? new Set<string>(),
					messageId: msg.envelope?.messageId ?? null,
				});
			}
			if (listed.length === 0) return [];

			const known = await this.knownMessageIds(listed);

			// ── Phase 2: bodies, for the unknown ones only ──────────────────
			const out: BackfillFetchedMessage[] = [];
			// Index into `out` per UID awaiting a body. A UID the server listed in
			// phase 1 but does not return in phase 2 keeps its `source: null` entry
			// and so still counts against the folder's denominator, exactly as a
			// single-phase fetch that returned no source did.
			const pending = new Map<number, number>();
			for (const msg of listed) {
				if (msg.messageId !== null && known.has(msg.messageId)) {
					out.push({ uid: msg.uid, source: null, flags: msg.flags, alreadyPresent: true });
					continue;
				}
				pending.set(msg.uid, out.length);
				out.push({ uid: msg.uid, source: null, flags: msg.flags });
			}

			const uids = [...pending.keys()];
			for (let i = 0; i < uids.length; i += SOURCE_FETCH_CHUNK) {
				const chunk = uids.slice(i, i + SOURCE_FETCH_CHUNK);
				for await (const msg of client.fetch(
					chunk.join(','),
					{ uid: true, source: true, flags: true },
					{ uid: true }
				)) {
					const at = pending.get(Number(msg.uid));
					if (at === undefined) continue; // outside this chunk — ignore
					const slot = out[at];
					if (!slot) continue;
					slot.source = msg.source ?? null;
					if (msg.flags) slot.flags = msg.flags;
				}
			}
			return out;
		} finally {
			lock.release();
		}
	}

	/**
	 * The subset of a listed batch's Message-IDs the mailbox already holds.
	 * Empty on any lookup failure — the caller then downloads the batch whole,
	 * which is what it did before this check existed.
	 */
	private async knownMessageIds(
		listed: ReadonlyArray<{ messageId: string | null }>
	): Promise<Set<string>> {
		const messageIds = listed
			.map((m) => m.messageId)
			.filter((id): id is string => id !== null && id.length > 0);
		if (messageIds.length === 0) return new Set();
		try {
			const rows = await this.host.convex.query(fn.findKnownMessageIds, {
				accountId: this.host.accountId,
				messageIds,
			});
			return new Set(rows);
		} catch (err) {
			logger.warn(
				{ accountId: this.host.accountId, err },
				'known-message-id lookup failed; downloading the whole batch'
			);
			return new Set();
		}
	}

	/** Wire the real IMAP fetch + Convex backfill mutations into a folder's deps. */
	makeBackfillDeps(uidValidity: number, migrationId: string): BackfillFolderDeps {
		const { accountId, convex, rawUploadConfig } = this.host;
		const backfillParams = (
			remoteName: string,
			role: FolderRole | undefined,
			uid: number,
			raw: Buffer,
			flags: Set<string>
		) => ({
			accountId,
			folderRole: role,
			remoteName,
			remoteUid: uid,
			remoteUidValidity: uidValidity,
			raw,
			flags,
			// Historical import: never enqueue background LLM work for it.
			origin: 'backfill' as const,
		});
		const landedOrWarn = (outcome: IngestOutcome, remoteName: string, uid: number): boolean => {
			const landed = isMessageLanded(outcome);
			if (!landed && 'skipped' in outcome) {
				// Stored nothing and did not throw — the shape that used to be
				// indistinguishable from a successful import.
				logger.warn(
					{ accountId, remoteName, uid, reason: outcome.skipped },
					'backfill ingest stored nothing'
				);
			}
			return landed;
		};
		return {
			batchSize: this.host.config.backfillBatchSize,
			initFolder: async (remoteName, ceilingUid, messageCount) =>
				await convex.mutation(fn.initFolderBackfill, {
					accountId,
					migrationId,
					remoteName,
					ceilingUid,
					messageCount,
				}),
			fetchBatch: (remoteName, start, end) => this.fetchBackfillBatch(remoteName, start, end),
			ingest: async (remoteName, role, uid, raw, flags) =>
				landedOrWarn(
					await ingestMessage(
						convex,
						rawUploadConfig,
						backfillParams(remoteName, role, uid, raw, flags)
					),
					remoteName,
					uid
				),
			stageIngest: async (remoteName, role, uid, raw, flags) => {
				const staged = await stageIngest(
					rawUploadConfig,
					backfillParams(remoteName, role, uid, raw, flags)
				);
				return {
					commit: async () => landedOrWarn(await commitIngest(convex, staged), remoteName, uid),
					discard: () => discardStagedIngest(convex, staged),
				};
			},
			ingestConcurrency: FORWARD_INGEST_CONCURRENCY,
			reportIngestFailure: (remoteName, uid, err) => {
				// The forward-sync loop logs its skips (forwardSync.ts); the backfill
				// used to swallow them, which is how an ingest that threw on every
				// message still reported a completed import.
				logger.warn(
					{ accountId, remoteName, uid, err },
					'backfill ingest failed; skipping message'
				);
			},
			recordProgress: async (remoteName, newCursor, importedDelta, failedDelta) => {
				const res = await convex.mutation(fn.recordBackfillProgress, {
					accountId,
					migrationId,
					remoteName,
					newCursor,
					importedDelta,
					failedDelta,
				});
				// Counted only once the write landed: every persisted batch is
				// forward motion — the cursor dropped, so the next run resumes
				// further along. That is what separates an import that is
				// converging from one that is stuck (backfillRetry.ts).
				this.batchesThisRun += 1;
				return res.stillImporting;
			},
			isStopped: () => this.host.isStopped(),
			betweenBatches: () => this.host.pollInboxBetweenBatches(),
		};
	}
}
