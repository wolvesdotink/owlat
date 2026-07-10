/**
 * One persistent IMAP connection per external account.
 *
 * INBOX is watched in near-real-time via IMAP IDLE (the 'exists' event triggers
 * an immediate fetch). All mapped system folders are also polled on a timer so
 * nothing is missed if IDLE drops. v1 only syncs NEW mail going forward — on
 * first sight of a folder (or a UIDVALIDITY change) we record the current
 * high-water UID and skip historical backfill.
 *
 * Reconnect uses exponential backoff with jitter. An authentication failure is
 * terminal: we mark the account `auth_error` and stop until the user re-enters
 * credentials (the reconcile loop then restarts us).
 */

import { ImapFlow } from 'imapflow';
import type {
	BackfillWork,
	ConnectableAccount,
	ConvexClient,
	FolderCursor,
	WorkerCredentials,
} from './convex.js';
import { fn } from './convex.js';
import type { MailSyncConfig } from './config.js';
import { mapFolderRole, type FolderRole } from './folders.js';
import { imapTlsOptions } from './tls.js';
import { ingestMessage } from './ingest.js';
import {
	backfillFolder,
	type BackfillFetchedMessage,
	type BackfillFolderDeps,
} from './backfill.js';
import { logger } from './logger.js';

interface Cursor {
	uidValidity: number;
	lastSeenUid: number;
}

const INITIAL_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

// How many *consecutive* backfill runs may throw before we give up and surface
// the wizard's 'failed → Try again' step. Transient drops self-heal: the poll
// loop re-invokes maybeRunBackfill() each pass and resumes from the persisted
// descending cursor, so a one-off network blip clears within a pass or two. Only
// a deterministically re-throwing import (oversized-mailbox crash, the worker
// can't reach the server, …) keeps failing across passes — that's the genuinely
// stuck case the user otherwise sits on 'importing' forever.
const MAX_BACKFILL_FAILURES = 5;

function isAuthError(err: unknown): boolean {
	const e = err as { authenticationFailed?: boolean; responseStatus?: string } | null;
	if (e?.authenticationFailed) return true;
	const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
	return (
		msg.includes('authentication failed') ||
		msg.includes('authenticationfailed') ||
		msg.includes('invalid credentials') ||
		msg.includes('login failed') ||
		msg.includes('[alert] invalid')
	);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AccountConnection {
	private client: ImapFlow | null = null;
	private stopped = false;
	private backoffMs = INITIAL_BACKOFF_MS;
	private folderTimer: ReturnType<typeof setInterval> | null = null;
	private folders: Array<{ remoteName: string; role: FolderRole }> = [];
	private cursors = new Map<string, Cursor>();
	private polling = false;
	private backfillRunning = false;
	// Consecutive throwing backfill runs for the *current* importing migration.
	// Reset on a clean run (or a different migration) so only a sustained,
	// deterministic failure escalates to markImportFailed.
	private backfillFailures = 0;
	private backfillFailureMigrationId: string | null = null;

	constructor(
		private readonly account: ConnectableAccount,
		private readonly convex: ConvexClient,
		private readonly config: MailSyncConfig,
	) {}

	async start(): Promise<void> {
		this.stopped = false;
		await this.connectLoop();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.folderTimer) {
			clearInterval(this.folderTimer);
			this.folderTimer = null;
		}
		const client = this.client;
		this.client = null;
		if (client) {
			try {
				await client.logout();
			} catch {
				/* already gone */
			}
		}
	}

	private async connectLoop(): Promise<void> {
		while (!this.stopped) {
			try {
				await this.connectOnce();
				return; // connected; event-driven + timer from here
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (isAuthError(err)) {
					logger.warn(
						{ accountId: this.account.accountId },
						'auth error — pausing until credentials are updated',
					);
					await this.setStatus('auth_error', message);
					this.stopped = true;
					return;
				}
				logger.warn({ accountId: this.account.accountId, err }, 'connect failed; backing off');
				await this.setStatus('error', message);
				await delay(this.backoffMs + Math.floor(Math.random() * 1000));
				this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
			}
		}
	}

	private scheduleReconnect(): void {
		if (this.stopped) return;
		if (this.folderTimer) {
			clearInterval(this.folderTimer);
			this.folderTimer = null;
		}
		this.client = null;
		void this.connectLoop();
	}

	private async connectOnce(): Promise<void> {
		const creds = (await this.convex.action(fn.getCredentialsForWorker as never, {
			accountId: this.account.accountId,
		} as never)) as WorkerCredentials | null;
		if (!creds) throw new Error('credentials unavailable');

		const client = new ImapFlow({
			host: creds.imapHost,
			port: creds.imapPort,
			// Force a STARTTLS-before-auth upgrade for any non-loopback host so
			// the mailbox password + mail never cross the network in the clear,
			// matching the send path (send.ts). Plain `secure: false` would let
			// imapflow fall back to plaintext if STARTTLS isn't advertised.
			...imapTlsOptions(creds.imapHost, creds.isImapSecure),
			auth: { user: creds.imapUsername, pass: creds.imapPassword },
			logger: false,
			emitLogs: false,
		});
		client.on('error', (err) => {
			logger.warn({ accountId: this.account.accountId, err }, 'imap client error');
		});
		client.on('close', () => {
			if (!this.stopped) {
				logger.info({ accountId: this.account.accountId }, 'imap connection closed; reconnecting');
				this.scheduleReconnect();
			}
		});

		await client.connect();
		this.client = client;
		this.backoffMs = INITIAL_BACKOFF_MS;

		await this.loadCursors();
		await this.discoverFolders(client);

		// Real-time INBOX: open it so imapflow IDLEs and emits 'exists'.
		await client.mailboxOpen('INBOX');
		client.on('exists', () => {
			void this.pollFolder('INBOX', 'inbox').catch((err) =>
				logger.warn({ accountId: this.account.accountId, err }, 'inbox poll (exists) failed'),
			);
		});

		await this.setStatus('connected');

		await this.pollAll();
		// A migration may be queued already; run its historical backfill in the
		// background so it never blocks IDLE / forward polling.
		void this.maybeRunBackfill();
		this.folderTimer = setInterval(() => {
			void this.pollAll()
				// Re-check for a migration started after connect.
				.then(() => this.maybeRunBackfill())
				.catch((err) =>
					logger.warn({ accountId: this.account.accountId, err }, 'periodic poll failed'),
				);
		}, this.config.folderPollIntervalMs);
	}

	private async loadCursors(): Promise<void> {
		const rows = (await this.convex.query(fn.getSyncState as never, {
			accountId: this.account.accountId,
		} as never)) as FolderCursor[];
		this.cursors.clear();
		for (const r of rows) {
			this.cursors.set(r.remoteName, { uidValidity: r.remoteUidValidity, lastSeenUid: r.lastSeenUid });
		}
	}

	private async discoverFolders(client: ImapFlow): Promise<void> {
		const list = await client.list();
		const seen = new Set<FolderRole>();
		const mapped: Array<{ remoteName: string; role: FolderRole }> = [];
		for (const entry of list) {
			const role = mapFolderRole(entry.specialUse, entry.path);
			if (!role || seen.has(role)) continue;
			seen.add(role);
			mapped.push({ remoteName: entry.path, role });
		}
		if (!mapped.some((m) => m.role === 'inbox')) {
			mapped.unshift({ remoteName: 'INBOX', role: 'inbox' });
		}
		this.folders = mapped;
	}

	private async pollAll(): Promise<void> {
		if (this.polling || this.stopped || !this.client) return;
		this.polling = true;
		try {
			for (const f of this.folders) {
				if (this.stopped) break;
				await this.pollFolder(f.remoteName, f.role);
			}
			await this.setStatus('connected', undefined, true);
		} finally {
			this.polling = false;
			await this.resumeInboxIdle();
		}
	}

	/** Return to INBOX so IDLE resumes there for real-time delivery. */
	private async resumeInboxIdle(): Promise<void> {
		if (this.client && !this.stopped) {
			try {
				await this.client.mailboxOpen('INBOX');
			} catch {
				/* reconnect handler will recover */
			}
		}
	}

	private async pollFolder(remoteName: string, role: FolderRole): Promise<void> {
		const client = this.client;
		if (!client) return;
		const lock = await client.getMailboxLock(remoteName);
		try {
			const mb = client.mailbox;
			if (!mb || typeof mb === 'boolean') return;
			const uidValidity = Number(mb.uidValidity);
			const uidNext = Number(mb.uidNext);
			let cursor = this.cursors.get(remoteName);

			// First sight or UIDVALIDITY rotation → record the mapping + set the
			// high-water mark so v1 only syncs NEW mail going forward.
			if (!cursor || cursor.uidValidity !== uidValidity) {
				const initial = Math.max(0, uidNext - 1);
				await this.convex.mutation(fn.recordFolderMapping as never, {
					accountId: this.account.accountId,
					folderRole: role,
					remoteName,
					remoteUidValidity: uidValidity,
					initialLastSeenUid: initial,
				} as never);
				this.cursors.set(remoteName, { uidValidity, lastSeenUid: initial });
				return;
			}

			if (uidNext <= cursor.lastSeenUid + 1) return; // nothing new

			let maxUid = cursor.lastSeenUid;
			for await (const msg of client.fetch(
				`${cursor.lastSeenUid + 1}:*`,
				{ uid: true, source: true, flags: true },
				{ uid: true },
			)) {
				if (this.stopped) break;
				const uid = Number(msg.uid);
				if (!msg.source || uid <= cursor.lastSeenUid) continue;
				try {
					await ingestMessage(this.convex, {
						accountId: this.account.accountId,
						folderRole: role,
						remoteName,
						remoteUid: uid,
						remoteUidValidity: uidValidity,
						raw: msg.source,
						flags: msg.flags ?? new Set<string>(),
					});
				} catch (err) {
					// Skip one bad message (e.g. oversized) and advance past it so it
					// doesn't head-of-line-block newer mail in this folder. The message
					// is NOT synced: it's retried on reconnect only if no later message
					// in this batch advanced the persisted cursor past it — otherwise the
					// skip is effectively permanent. The message still exists on the
					// upstream IMAP server regardless; this only affects the local copy.
					logger.warn(
						{ accountId: this.account.accountId, remoteName, uid, err },
						'ingest failed; skipping message',
					);
				}
				// Advance even on failure so the cursor never sticks on one message.
				if (uid > maxUid) maxUid = uid;
			}
			if (maxUid > cursor.lastSeenUid) {
				this.cursors.set(remoteName, { uidValidity, lastSeenUid: maxUid });
			}
		} finally {
			lock.release();
		}
	}

	/**
	 * If a migration is importing for this account, walk every mapped folder's
	 * history (newest→oldest) and signal completion. Guarded so only one backfill
	 * runs at a time; yields the IMAP connection back to INBOX/IDLE when done.
	 */
	private async maybeRunBackfill(): Promise<void> {
		if (this.backfillRunning || this.stopped || !this.client) return;

		let work: BackfillWork;
		try {
			work = (await this.convex.query(fn.getBackfillWork as never, {
				accountId: this.account.accountId,
			} as never)) as BackfillWork;
		} catch (err) {
			logger.warn({ accountId: this.account.accountId, err }, 'getBackfillWork failed');
			return;
		}
		if (!work.isActive || !work.migrationId) return;
		const migrationId = work.migrationId;
		// A fresh migration (or a different one) starts the failure streak over.
		if (this.backfillFailureMigrationId !== migrationId) {
			this.backfillFailureMigrationId = migrationId;
			this.backfillFailures = 0;
		}

		this.backfillRunning = true;
		logger.info({ accountId: this.account.accountId }, 'starting historical backfill');
		try {
			for (const folder of this.folders) {
				if (this.stopped || !this.client) break;
				const meta = await this.readFolderMeta(folder.remoteName);
				if (!meta) continue;
				await backfillFolder(this.makeBackfillDeps(meta.uidValidity, migrationId), {
					remoteName: folder.remoteName,
					role: folder.role,
					ceilingUid: meta.ceilingUid,
					messageCount: meta.messageCount,
				});
			}
			if (!this.stopped) {
				// A clean pass clears the streak (covers transient blips that healed).
				this.backfillFailures = 0;
				await this.convex.mutation(fn.completeBackfillImport as never, {
					migrationId,
				} as never);
				logger.info({ accountId: this.account.accountId }, 'historical backfill complete');
			}
		} catch (err) {
			// A stop request (e.g. the user cancelled) shouldn't count as a failure.
			if (this.stopped) {
				logger.warn({ accountId: this.account.accountId, err }, 'backfill aborted');
			} else {
				this.backfillFailures += 1;
				logger.warn(
					{ accountId: this.account.accountId, err, failures: this.backfillFailures },
					'backfill failed',
				);
				// Transient drops self-heal on the next poll pass; only a sustained,
				// deterministic failure surfaces the wizard's 'failed → Try again'.
				if (this.backfillFailures >= MAX_BACKFILL_FAILURES) {
					const message = err instanceof Error ? err.message : String(err);
					try {
						await this.convex.mutation(fn.markImportFailed as never, {
							migrationId,
							errorMessage: message,
						} as never);
						logger.warn(
							{ accountId: this.account.accountId, migrationId },
							'backfill failed repeatedly; marking migration import as failed',
						);
					} catch (markErr) {
						logger.warn(
							{ accountId: this.account.accountId, err: markErr },
							'markImportFailed failed',
						);
					}
				}
			}
		} finally {
			this.backfillRunning = false;
			await this.resumeInboxIdle();
		}
	}

	/** Read a folder's high-water UID, message count, and UIDVALIDITY. */
	private async readFolderMeta(
		remoteName: string,
	): Promise<{ ceilingUid: number; messageCount: number; uidValidity: number } | null> {
		const client = this.client;
		if (!client) return null;
		const lock = await client.getMailboxLock(remoteName);
		try {
			const mb = client.mailbox;
			if (!mb || typeof mb === 'boolean') return null;
			return {
				ceilingUid: Math.max(0, Number(mb.uidNext) - 1),
				messageCount: Number(mb.exists),
				uidValidity: Number(mb.uidValidity),
			};
		} finally {
			lock.release();
		}
	}

	/** Wire the real IMAP fetch + Convex backfill mutations into a folder's deps. */
	private makeBackfillDeps(uidValidity: number, migrationId: string): BackfillFolderDeps {
		const accountId = this.account.accountId;
		return {
			batchSize: this.config.backfillBatchSize,
			initFolder: async (remoteName, ceilingUid, messageCount) =>
				(await this.convex.mutation(fn.initFolderBackfill as never, {
					accountId,
					migrationId,
					remoteName,
					ceilingUid,
					messageCount,
				} as never)) as { startCursor: number } | null,
			fetchBatch: async (remoteName, start, end) => {
				const client = this.client;
				if (!client) return [];
				const lock = await client.getMailboxLock(remoteName);
				try {
					const out: BackfillFetchedMessage[] = [];
					for await (const msg of client.fetch(
						`${start}:${end}`,
						{ uid: true, source: true, flags: true },
						{ uid: true },
					)) {
						out.push({
							uid: Number(msg.uid),
							source: msg.source ?? null,
							flags: msg.flags ?? new Set<string>(),
						});
					}
					return out;
				} finally {
					lock.release();
				}
			},
			ingest: async (remoteName, role, uid, raw, flags) =>
				ingestMessage(this.convex, {
					accountId,
					folderRole: role,
					remoteName,
					remoteUid: uid,
					remoteUidValidity: uidValidity,
					raw,
					flags,
				}),
			recordProgress: async (remoteName, newCursor, importedDelta) => {
				const res = (await this.convex.mutation(fn.recordBackfillProgress as never, {
					accountId,
					migrationId,
					remoteName,
					newCursor,
					importedDelta,
				} as never)) as { stillImporting: boolean };
				return res.stillImporting;
			},
			isStopped: () => this.stopped,
		};
	}

	private async setStatus(
		status: 'pending' | 'connected' | 'auth_error' | 'error' | 'disconnected',
		lastError?: string,
		markSynced?: boolean,
	): Promise<void> {
		try {
			await this.convex.mutation(fn.setSyncStatus as never, {
				accountId: this.account.accountId,
				status,
				lastError,
				markSynced,
			} as never);
		} catch (err) {
			logger.warn({ accountId: this.account.accountId, err }, 'setSyncStatus failed');
		}
	}
}
