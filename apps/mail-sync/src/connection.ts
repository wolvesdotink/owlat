/**
 * One persistent IMAP connection per external account.
 *
 * INBOX is watched in near-real-time via IMAP IDLE (the 'exists' event triggers
 * an immediate fetch). All mapped system folders are also polled on a timer so
 * nothing is missed if IDLE drops. v1 only syncs NEW mail going forward — on
 * first sight of a folder (or a UIDVALIDITY change) we record the current
 * high-water UID and skip historical backfill.
 *
 * Reconnect uses exponential backoff with jitter. A login the provider keeps
 * rejecting for AUTH_REJECTION_GRACE_MS is terminal: we mark the account
 * `auth_error` and stop until the user re-enters credentials (the reconcile
 * loop then restarts us). A single rejection is not — providers refuse logins
 * for passing reasons too (loginFailure.ts). So is the backend refusing to mint
 * credentials because the OAuth grant was revoked — there it has already
 * written `auth_error` and the reconnect instruction, so we stop and leave the
 * message alone.
 *
 * This class owns the session, its timers and the cycle scheduling; the work
 * lives in siblings: reconnectLoop.ts (backoff), forwardSync.ts (new mail),
 * remoteSync.ts (write-back + remote changes) and backfillRunner.ts (a
 * migration's historical import).
 */

import { ImapFlow } from 'imapflow';
import type { ConnectableAccount, ConvexClient } from './convex.js';
import { CredentialsUnavailableError, fetchWorkerCredentials, fn } from './convex.js';
import type { MailSyncConfig } from './config.js';
import type { FolderRole } from './folders.js';
import { imapAuth } from './auth.js';
import { imapTlsOptions } from './tls.js';
import type { RawUploadConfig } from './ingest.js';
import { ReconnectLoop } from './reconnectLoop.js';
import { InboxPoller, pollFolderForward, type FolderCursor } from './forwardSync.js';
import {
	listSyncedFolders,
	RemoteSync,
	type FolderListing,
	type SyncedFolder,
} from './remoteSync.js';
import { BackfillRunner, type FolderMeta } from './backfillRunner.js';
import { logger } from './logger.js';

/** Quiet period before an IDLE notification (flags, expunge, new mail) starts a cycle. */
const EVENT_CYCLE_DEBOUNCE_MS = 2000;

type CycleKind = 'drain' | 'full';

export class AccountConnection {
	private client: ImapFlow | null = null;
	private stopped = false;
	private readonly reconnect: ReconnectLoop;
	private folderTimer: ReturnType<typeof setInterval> | null = null;
	private inboxTimer: ReturnType<typeof setInterval> | null = null;
	private readonly inboxPoll: InboxPoller;
	private folders: SyncedFolder[] = [];
	// Every path the provider's last LIST returned, mirrored or not.
	private listedPaths: string[] = [];
	// Listed paths that are views onto mail filed elsewhere (All Mail, Starred,
	// Important). Never mirrored; a folder an older worker mirrored for one is
	// retired once reconcile has moved its mail to where it really lives.
	private virtualPaths: string[] = [];
	// Gmail-style "All Mail" paths: the write-back copies out of them instead of moving.
	private allMailPaths = new Set<string>();
	// ── Sync cycles (write-back + remote change sync) — one at a time ──
	private cycleRunning = false;
	private cycleRequested: CycleKind | null = null;
	private eventCycleTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly remote: RemoteSync;
	private cursors = new Map<string, FolderCursor>();
	private polling = false;
	private readonly backfill: BackfillRunner;

	constructor(
		private readonly account: ConnectableAccount,
		private readonly convex: ConvexClient,
		private readonly config: MailSyncConfig
	) {
		this.reconnect = new ReconnectLoop({
			accountId: account.accountId,
			isStopped: () => this.stopped,
			halt: () => {
				this.stopped = true;
			},
			connectOnce: () => this.connectOnce(),
			setStatus: (status, lastError) => this.setStatus(status, lastError),
		});
		this.remote = new RemoteSync(account.accountId, convex);
		this.inboxPoll = new InboxPoller({
			accountId: account.accountId,
			client: () => this.client,
			inbox: () => this.folders.find((f) => f.role === 'inbox'),
			cursor: (remoteName) => this.cursors.get(remoteName),
			isStopped: () => this.stopped,
			pollFolder: (remoteName, role) => this.pollFolder(remoteName, role),
		});
		this.backfill = new BackfillRunner({
			accountId: account.accountId,
			convex,
			config,
			rawUploadConfig: this.rawUploadConfig,
			client: () => this.client,
			folders: () => this.folders,
			isStopped: () => this.stopped,
			readFolderMeta: (remoteName) => this.readFolderMeta(remoteName),
			pollInboxForward: () => this.pollInboxForward(),
			pollInboxBetweenBatches: () => this.pollInboxBetweenBatches(),
			resumeInboxIdle: () => this.resumeInboxIdle(),
		});
	}

	/** Where `ingestMessage` PUTs the raw `.eml` before referencing it. */
	private get rawUploadConfig(): RawUploadConfig {
		return { convexSiteUrl: this.config.convexSiteUrl, apiKey: this.config.apiKey };
	}

	/** The provider's folders as the last discovery saw them. */
	private get listing(): FolderListing {
		return {
			folders: this.folders,
			listedPaths: this.listedPaths,
			virtualPaths: this.virtualPaths,
			allMailPaths: this.allMailPaths,
		};
	}

	/** True once the connection has stopped for good (see reconnectLoop.ts). */
	get isStopped(): boolean {
		return this.stopped;
	}

	async start(): Promise<void> {
		this.stopped = false;
		await this.reconnect.run();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.folderTimer) {
			clearInterval(this.folderTimer);
			this.folderTimer = null;
		}
		this.clearInboxTimer();
		if (this.eventCycleTimer) {
			clearTimeout(this.eventCycleTimer);
			this.eventCycleTimer = null;
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

	private scheduleReconnect(): void {
		if (this.stopped) return;
		if (this.folderTimer) {
			clearInterval(this.folderTimer);
			this.folderTimer = null;
		}
		this.clearInboxTimer();
		this.client = null;
		void this.reconnect.run();
	}

	private async connectOnce(): Promise<void> {
		const fetched = await fetchWorkerCredentials(this.convex, this.account.accountId);
		if (fetched.kind !== 'credentials') throw new CredentialsUnavailableError(fetched.reason);
		const creds = fetched.credentials;

		const client = new ImapFlow({
			host: creds.imapHost,
			port: creds.imapPort,
			// Force a STARTTLS-before-auth upgrade for any non-loopback host so
			// the mailbox password + mail never cross the network in the clear,
			// matching the send path (send.ts). Plain `secure: false` would let
			// imapflow fall back to plaintext if STARTTLS isn't advertised.
			...imapTlsOptions(creds.imapHost, creds.isImapSecure),
			auth: imapAuth({
				user: creds.imapUsername,
				pass: creds.imapPassword,
				accessToken: creds.imapAccessToken,
			}),
			// Logs nothing; keeps the error of a refused MOVE, COPY, STORE or EXPUNGE.
			logger: this.remote.refusals.logger,
			emitLogs: false,
		});
		client.on('error', (err) => {
			logger.warn({ accountId: this.account.accountId, err }, 'imap client error');
		});
		client.on('close', () => {
			// Only the live connection reconnects. A client that never finished
			// connecting is closed by the loop that is already backing off, and
			// letting its close start another loop is how one failure became two.
			if (this.stopped || this.client !== client) return;
			logger.info({ accountId: this.account.accountId }, 'imap connection closed; reconnecting');
			this.scheduleReconnect();
		});

		try {
			await this.openSession(client);
		} catch (err) {
			// ImapFlow leaves the socket open when LOGIN is refused; a provider
			// that caps simultaneous connections counts every one left behind.
			if (this.client === client) this.client = null;
			client.close();
			throw err;
		}
	}

	/** Log in on a fresh client and bring it to IDLE on INBOX with the timers armed. */
	private async openSession(client: ImapFlow): Promise<void> {
		await client.connect();
		this.reconnect.markConnected();
		this.client = client;
		this.remote.markAllCensusDue();

		await this.loadCursors();
		await this.discoverFolders(client, (await this.syncMode())?.mode ?? 'incoming');

		// Real-time INBOX: open it so imapflow IDLEs and emits 'exists'.
		await client.mailboxOpen('INBOX');
		client.on('exists', () => {
			void this.pollFolder('INBOX', 'inbox').catch((err) =>
				logger.warn({ accountId: this.account.accountId, err }, 'inbox poll (exists) failed')
			);
			this.scheduleEventCycle();
		});
		// Read, starred or removed on the provider while INBOX is open.
		client.on('flags', () => this.scheduleEventCycle());
		client.on('expunge', (event: { path?: string } | undefined) => {
			// Something left that folder (INBOX, or one a cycle has open): its next
			// refresh takes a census. The other folders stay on the cheap path
			// unless their message counts disagree with their views.
			if (event?.path) this.remote.markCensusDue(event.path);
			this.scheduleEventCycle();
		});

		await this.setStatus('connected');

		await this.pollAll();
		// A close during setup found the reconnect loop still busy with this
		// attempt and started nothing; failing it is what retries. Nothing below
		// awaits, so a later close finds the loop free.
		if (this.client !== client) throw new Error('IMAP connection closed during setup');
		// Changes made on either side while the connection was down, then a
		// migration's historical backfill if one is queued — in the background, so
		// it never blocks IDLE / forward polling.
		void this.runCycle('full').then(() => this.maybeRunBackfill());
		this.folderTimer = setInterval(() => {
			void this.runCycle('full')
				// Re-check for a migration started after connect.
				.then(() => this.maybeRunBackfill())
				.catch((err) =>
					logger.warn({ accountId: this.account.accountId, err }, 'periodic poll failed')
				);
		}, this.config.folderPollIntervalMs);
		this.inboxTimer = setInterval(() => void this.catchUpInbox(), this.config.inboxPollIntervalMs);
	}

	private clearInboxTimer(): void {
		if (this.inboxTimer) {
			clearInterval(this.inboxTimer);
			this.inboxTimer = null;
		}
	}

	/** The INBOX's own short-timer poll (forwardSync.ts InboxPoller). */
	private async catchUpInbox(): Promise<void> {
		await this.inboxPoll.catchUp();
	}

	/** The account's sync mode, read fresh each cycle; null when it cannot be read. */
	private async syncMode(): Promise<{ mode: 'full' | 'incoming'; isAligned: boolean } | null> {
		try {
			return await this.convex.query(fn.getSyncSettings, { accountId: this.account.accountId });
		} catch (err) {
			logger.warn({ accountId: this.account.accountId, err }, 'getSyncSettings failed');
			return null;
		}
	}

	/** Debounced cycle after an IDLE notification, so a burst of them runs one cycle. */
	private scheduleEventCycle(): void {
		if (this.stopped || this.eventCycleTimer) return;
		this.eventCycleTimer = setTimeout(() => {
			this.eventCycleTimer = null;
			void this.runCycle('full');
		}, EVENT_CYCLE_DEBOUNCE_MS);
	}

	/**
	 * The backend queued write-backs (server.ts `/remote-ops`) or changed the
	 * sync mode: replay the queue now.
	 */
	requestRemoteOps(): void {
		void this.runCycle('drain');
	}

	/**
	 * One sync cycle, never two at once — a reconcile working from views read
	 * before a write-back landed would undo it. A request that arrives mid-cycle
	 * runs another afterwards ('full' wins over 'drain').
	 *
	 *   drain — replay the write-back queue (remoteOps.ts).
	 *   full  — that, then rediscover folders, forward-poll new mail and, with
	 *           full sync, mirror the provider's changes (remoteState.ts).
	 */
	private async runCycle(kind: CycleKind): Promise<void> {
		if (this.cycleRunning) {
			if (this.cycleRequested !== 'full') this.cycleRequested = kind;
			return;
		}
		this.cycleRunning = true;
		let next: CycleKind | null = kind;
		try {
			while (next && !this.stopped && this.client) {
				this.cycleRequested = null;
				await this.cycleOnce(next);
				next = this.cycleRequested;
			}
		} catch (err) {
			logger.warn({ accountId: this.account.accountId, err }, 'sync cycle failed');
		} finally {
			this.cycleRunning = false;
			await this.resumeInboxIdle();
		}
	}

	private async cycleOnce(kind: CycleKind): Promise<void> {
		const client = this.client;
		if (!client) return;
		await this.drainQueue(client);
		if (kind === 'drain') return;
		const settings = await this.syncMode();
		if (!settings) return;
		await this.discoverFolders(client, settings.mode);
		await this.pollAll();
		if (settings.mode !== 'full') {
			this.remote.forgetViews();
			return;
		}
		await this.remote.reconcile(
			client,
			this.listing,
			settings.isAligned,
			() => this.stopped || this.client !== client
		);
	}

	/** Replay the write-back queue on the provider (remoteSync.ts). */
	private async drainQueue(client: ImapFlow): Promise<void> {
		await this.remote.drainQueue(
			client,
			this.listing,
			() => this.stopped || this.client !== client
		);
	}

	private async loadCursors(): Promise<void> {
		const rows = await this.convex.query(fn.getSyncState, {
			accountId: this.account.accountId,
		});
		this.cursors.clear();
		for (const r of rows) {
			this.cursors.set(r.remoteName, {
				uidValidity: r.remoteUidValidity,
				lastSeenUid: r.lastSeenUid,
				forwardIngestFailures: r.forwardIngestFailures ?? [],
			});
		}
	}

	/** Rediscover the provider's folders (remoteSync.ts listSyncedFolders). */
	private async discoverFolders(client: ImapFlow, mode: 'full' | 'incoming'): Promise<void> {
		const listing = listSyncedFolders(await client.list(), mode, client.namespace?.prefix);
		this.folders = listing.folders;
		this.listedPaths = listing.listedPaths;
		this.virtualPaths = listing.virtualPaths;
		this.allMailPaths = listing.allMailPaths;
	}

	private async pollAll(): Promise<void> {
		if (this.polling || this.stopped || !this.client) return;
		this.polling = true;
		try {
			for (const f of this.folders) {
				if (this.stopped) break;
				await this.pollFolder(f.remoteName, f.role, f.path);
			}
			await this.setStatus('connected', undefined, true);
		} finally {
			this.polling = false;
			await this.resumeInboxIdle();
		}
	}

	/** Back to INBOX for IDLE, catching up on what arrived meanwhile (forwardSync.ts). */
	private async resumeInboxIdle(): Promise<void> {
		await this.inboxPoll.resumeIdle();
	}

	private async pollFolder(
		remoteName: string,
		role: FolderRole | undefined,
		path?: string[]
	): Promise<void> {
		const client = this.client;
		if (!client) return;
		await pollFolderForward(
			{
				client,
				convex: this.convex,
				accountId: this.account.accountId,
				rawUploadConfig: this.rawUploadConfig,
				cursors: this.cursors,
				isStopped: () => this.stopped,
			},
			remoteName,
			role,
			path
		);
	}

	/** A migration's historical backfill, if one is importing (backfillRunner.ts). */
	private async maybeRunBackfill(): Promise<void> {
		await this.backfill.maybeRun();
	}

	/** Forward-poll the INBOX ahead of a backfill folder (forwardSync.ts InboxPoller). */
	private async pollInboxForward(): Promise<void> {
		await this.inboxPoll.pollForward();
	}

	/** The same poll between two backfill batches, rate-limited. */
	private async pollInboxBetweenBatches(): Promise<void> {
		await this.inboxPoll.pollBetweenBatches();
	}

	/** Read a folder's high-water UID, message count, and UIDVALIDITY. */
	private async readFolderMeta(remoteName: string): Promise<FolderMeta | null> {
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

	private async setStatus(
		status: 'pending' | 'connected' | 'auth_error' | 'error' | 'disconnected',
		lastError?: string,
		markSynced?: boolean
	): Promise<void> {
		try {
			await this.convex.mutation(fn.setSyncStatus, {
				accountId: this.account.accountId,
				status,
				lastError,
				markSynced,
			});
		} catch (err) {
			logger.warn({ accountId: this.account.accountId, err }, 'setSyncStatus failed');
		}
	}
}
