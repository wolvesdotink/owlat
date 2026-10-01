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
 */

import { ImapFlow } from 'imapflow';
import { sleep } from '@owlat/shared';
import type { BackfillWork, ConnectableAccount, ConvexClient, IngestOutcome } from './convex.js';
import { CredentialsUnavailableError, fetchWorkerCredentials, fn } from './convex.js';
import type { MailSyncConfig } from './config.js';
import { isVirtualView, mapFolderRole, mirroredFolderPath, type FolderRole } from './folders.js';
import { imapAuth } from './auth.js';
import { imapTlsOptions } from './tls.js';
import { AUTH_REJECTION_GRACE_MS, describeConnectError, isAuthError } from './loginFailure.js';
import {
	commitIngest,
	discardStagedIngest,
	ingestMessage,
	isMessageLanded,
	stageIngest,
	type RawUploadConfig,
} from './ingest.js';
import { FORWARD_INGEST_CONCURRENCY, newMessages, runIngestPipeline } from './ingestPipeline.js';
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
import { drainRemoteOps, isAllMailFolder, RemoteOpReplayer } from './remoteOps.js';
import {
	LOCAL_PAGE,
	noPendingChanges,
	reconcile,
	type FolderView,
	type ModseqCursor,
} from './remoteState.js';
import { logger } from './logger.js';

interface Cursor {
	uidValidity: number;
	lastSeenUid: number;
	forwardIngestFailures?: Array<{ uid: number; attempts: number }>;
}

/** A synced remote folder: a system role, or (full sync) a mirrored user folder by path. */
interface SyncedFolder {
	remoteName: string;
	role?: FolderRole;
	path?: string[];
}

/** Best-first order in which a moved message's new home is picked; user folders sit after the inbox. */
const ROLE_ORDER: ReadonlyArray<FolderRole | undefined> = [
	'inbox',
	undefined,
	'archive',
	'sent',
	'drafts',
	'spam',
	'trash',
];

/** A full reconcile at least this often, as a safety net for missed changes. */
const FULL_RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Quiet period before an IDLE notification (flags, expunge, new mail) starts a cycle. */
const EVENT_CYCLE_DEBOUNCE_MS = 2000;

type CycleKind = 'drain' | 'full';

const INITIAL_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

/**
 * UIDs per `UID FETCH` in the backfill's body phase. The phase-1 range is
 * addressed as `start:end`, but phase 2 asks for a sparse list, so the command
 * grows with the number of UIDs — chunked to keep it comfortably inside the
 * IMAP line length every server accepts.
 */
const SOURCE_FETCH_CHUNK = 50;

/**
 * Least time between two INBOX forward polls that the backfill makes between
 * its batches. A re-walk of mail that is already imported moves through a
 * batch in one envelope fetch, and polling after every one of those would
 * spend a SELECT pair per batch against providers that meter commands.
 */
const BACKFILL_INBOX_POLL_MIN_MS = 10_000;

export class AccountConnection {
	private client: ImapFlow | null = null;
	private stopped = false;
	private backoffMs = INITIAL_BACKOFF_MS;
	// One reconnect loop per account, ever (see connectLoop).
	private isConnectLoopRunning = false;
	// When the current run of back-to-back login rejections began. Reset by a
	// login the provider accepts and by any failure that is not a rejection.
	private authRejectedSince: number | null = null;
	private folderTimer: ReturnType<typeof setInterval> | null = null;
	private inboxTimer: ReturnType<typeof setInterval> | null = null;
	// Set while the INBOX catch-up poll runs, so a slow one is never stacked.
	private isInboxCatchUpRunning = false;
	private folders: SyncedFolder[] = [];
	// Every path the provider's last LIST returned, mirrored or not.
	private listedPaths: string[] = [];
	// Listed paths that are views onto mail filed elsewhere (All Mail, Starred,
	// Important). Never mirrored; a folder an older worker mirrored for one is
	// retired once reconcile has moved its mail to where it really lives.
	private virtualPaths: string[] = [];
	// Folders the write-back renamed (remoteOps.ts), kept across drains.
	private readonly renamedFolders = new Map<string, string>();
	// Gmail-style "All Mail" paths: the write-back copies out of them instead of moving.
	private allMailPaths = new Set<string>();
	// ── Sync cycles (write-back + remote change sync) — one at a time ──
	private cycleRunning = false;
	private cycleRequested: CycleKind | null = null;
	private eventCycleTimer: ReturnType<typeof setTimeout> | null = null;
	private lastFullReconcileAt = 0;
	// Per-folder views of the provider (remoteState.ts). Kept across reconnects,
	// so a change made while the connection was down still shows up as a change.
	private readonly views = new Map<string, FolderView>();
	// What a reconcile cut short had noticed but not yet settled (remoteState.ts).
	private pendingRemote = noPendingChanges();
	private readonly allMailCursor: ModseqCursor = { uidValidity: null, highestModseq: null };
	private cursors = new Map<string, Cursor>();
	private polling = false;
	private backfillRunning = false;
	// Retry pacing + the strike count for the *current* importing migration
	// (backfillRetry.ts owns the policy). Held across runs, reset when a
	// different migration becomes the active one.
	private backfillRetry: BackfillRetryState = initialBackfillRetryState();
	// Batches this run has persisted — the difference between an import that is
	// advancing and one that is stuck. Read once the run ends.
	private backfillBatchesThisRun = 0;
	// When the backfill last forward-polled the INBOX (pollInboxForward).
	private lastInboxPollAt = 0;

	constructor(
		private readonly account: ConnectableAccount,
		private readonly convex: ConvexClient,
		private readonly config: MailSyncConfig
	) {}

	/** Where `ingestMessage` PUTs the raw `.eml` before referencing it. */
	private get rawUploadConfig(): RawUploadConfig {
		return { convexSiteUrl: this.config.convexSiteUrl, apiKey: this.config.apiKey };
	}

	/** True once the connection has stopped for good (see connectLoop). */
	get isStopped(): boolean {
		return this.stopped;
	}

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

	/**
	 * Connect, backing off between failures, until connected or stopped. Never
	 * runs twice at once: a second loop would double every connect attempt and
	 * status write, and each of its failures could start yet another — the
	 * reconnect storm that once took Convex down with thousands of attempts a
	 * minute.
	 */
	private async connectLoop(): Promise<void> {
		if (this.isConnectLoopRunning) return;
		this.isConnectLoopRunning = true;
		try {
			await this.connectUntilConnected();
		} finally {
			this.isConnectLoopRunning = false;
		}
	}

	private async connectUntilConnected(): Promise<void> {
		while (!this.stopped) {
			try {
				await this.connectOnce();
				return; // connected; event-driven + timer from here
			} catch (err) {
				const message = describeConnectError(err);
				// The backend refused to hand over credentials and only the user can
				// change that: the Google grant behind them was revoked, or the member
				// disconnected the account and the password was dropped with it. Either
				// way the backend has already written the status that is true, so stop
				// WITHOUT a status write — ours would overwrite the only actionable
				// message with a generic one, and on a disconnected account it would
				// put the row back into a connectable state with no credential in it.
				// Retrying would spend a token request per pass forever.
				if (err instanceof CredentialsUnavailableError && err.isTerminal) {
					logger.warn(
						{ accountId: this.account.accountId, reason: err.reason },
						'account can no longer be connected — pausing until the user reconnects it'
					);
					this.stopped = true;
					return;
				}
				if (isAuthError(err)) {
					const now = Date.now();
					this.authRejectedSince ??= now;
					if (now - this.authRejectedSince >= AUTH_REJECTION_GRACE_MS) {
						logger.warn(
							{ accountId: this.account.accountId, err },
							'login still rejected — pausing until credentials are updated'
						);
						await this.setStatus('auth_error', message);
						this.stopped = true;
						return;
					}
					// Retried on the ordinary backoff below. The status is `error`,
					// which keeps the account connectable and already shows the
					// member the reconnect form should the rejection persist.
					logger.warn(
						{ accountId: this.account.accountId, err },
						'login rejected; retrying before treating the credentials as wrong'
					);
				} else {
					// Anything else breaks the streak: the grace period measures logins
					// refused back to back, and a temporary refusal or a dropped socket
					// in between says nothing about the credentials.
					this.authRejectedSince = null;
					logger.warn({ accountId: this.account.accountId, err }, 'connect failed; backing off');
				}
				await this.setStatus('error', message);
				await sleep(this.backoffMs + Math.floor(Math.random() * 1000));
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
		this.clearInboxTimer();
		this.client = null;
		void this.connectLoop();
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
			logger: false,
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
		this.authRejectedSince = null;
		this.client = client;
		this.backoffMs = INITIAL_BACKOFF_MS;
		// Whatever left a folder while the connection was down was never reported
		// to us: every folder's first refresh compares its whole UID list.
		for (const view of this.views.values()) view.censusDue = true;

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
			const view = event?.path ? this.views.get(event.path) : undefined;
			if (view) view.censusDue = true;
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

	/**
	 * Poll the INBOX for new mail on a short timer of its own. IDLE is the fast
	 * path, but it only runs while the connection is otherwise idle: every cycle,
	 * reconcile and backfill takes the connection away from it, and a long-lived
	 * worker on a busy team inbox was seen ingesting new mail only on the
	 * five-minute folder tick for days, so every reply draft started minutes
	 * late. This bounds that at one interval whatever IDLE does. The poll waits
	 * its turn on the mailbox lock, so it slots in between a cycle's folders
	 * rather than behind the whole cycle, and costs one UID FETCH when nothing
	 * is new.
	 */
	private async catchUpInbox(): Promise<void> {
		if (this.stopped || !this.client || this.isInboxCatchUpRunning) return;
		this.isInboxCatchUpRunning = true;
		try {
			await this.pollInboxForward();
		} finally {
			this.isInboxCatchUpRunning = false;
		}
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
			this.views.clear();
			this.pendingRemote = noPendingChanges();
			return;
		}
		const accountId = this.account.accountId;
		const tracked = [...this.folders]
			.filter((f) => !this.allMailPaths.has(f.remoteName))
			.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))
			.map((f) => f.remoteName);
		const allMail = this.folders.find((f) => this.allMailPaths.has(f.remoteName))?.remoteName;
		const { full, completed } = await reconcile({
			client,
			tracked,
			allMail: allMail ?? null,
			views: this.views,
			allMailCursor: this.allMailCursor,
			isAligned: settings.isAligned,
			forceFull: Date.now() - this.lastFullReconcileAt > FULL_RECONCILE_INTERVAL_MS,
			pending: this.pendingRemote,
			listLocal: (cursor) =>
				this.convex.query(fn.listLocalMessages, {
					accountId,
					paginationOpts: { numItems: LOCAL_PAGE, cursor },
				}),
			lookupLocal: (messageIds) =>
				this.convex.query(fn.lookupLocalMessages, { accountId, messageIds }),
			apply: async (observations) => {
				await this.convex.mutation(fn.applyRemoteObservations, { accountId, observations });
			},
			markAligned: async () => {
				await this.convex.mutation(fn.markFullSyncAligned, { accountId });
			},
			isStopped: () => this.stopped || this.client !== client,
		});
		if (full) this.lastFullReconcileAt = Date.now();
		// Only after a completed pass: by then the mail of a folder the provider
		// renamed or deleted has followed it, and its empty local copy can go.
		if (completed) {
			await this.convex.mutation(fn.forgetRemoteFolders, {
				accountId,
				listed: [...new Set([...this.listedPaths, ...this.folders.map((f) => f.remoteName)])],
				retired: this.virtualPaths.filter((p) => !this.folders.some((f) => f.remoteName === p)),
			});
		}
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

	/**
	 * Map the provider's folders: the six system roles always, and with full sync
	 * every other selectable folder too, mirrored as a user folder. Runs on every
	 * full cycle, so a folder created on the provider is picked up without a
	 * reconnect (a message moved into an unknown folder would look deleted).
	 */
	private async discoverFolders(client: ImapFlow, mode: 'full' | 'incoming'): Promise<void> {
		const list = await client.list();
		this.listedPaths = list.map((e) => e.path);
		this.virtualPaths = list.filter((e) => isVirtualView(e)).map((e) => e.path);
		const seen = new Set<FolderRole>();
		const mapped: SyncedFolder[] = [];
		this.allMailPaths = new Set(
			list.filter((e) => isAllMailFolder(e.specialUse, e.path)).map((e) => e.path)
		);
		const user: SyncedFolder[] = [];
		for (const entry of list) {
			const role = mapFolderRole(entry.specialUse, entry.path);
			if (role && !seen.has(role)) {
				seen.add(role);
				mapped.push({ remoteName: entry.path, role });
				continue;
			}
			if (mode !== 'full') continue;
			const path = mirroredFolderPath(entry, client.namespace?.prefix);
			if (path) user.push({ remoteName: entry.path, path });
		}
		if (!mapped.some((m) => m.role === 'inbox')) {
			mapped.unshift({ remoteName: 'INBOX', role: 'inbox' });
		}
		this.folders = [...mapped, ...user];
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

	/**
	 * Return to INBOX so IDLE resumes there for real-time delivery, and catch up
	 * on what arrived while another folder was selected: that mail raised no
	 * 'exists' event, so without the UIDNEXT check it would wait for the next
	 * periodic poll.
	 */
	private async resumeInboxIdle(): Promise<void> {
		const client = this.client;
		if (!client || this.stopped) return;
		try {
			await client.mailboxOpen('INBOX');
		} catch {
			return; // reconnect handler will recover
		}
		const inbox = this.folders.find((f) => f.role === 'inbox');
		const cursor = inbox ? this.cursors.get(inbox.remoteName) : undefined;
		const mb = client.mailbox;
		if (!cursor || !mb || typeof mb === 'boolean') return;
		if (Number(mb.uidValidity) !== cursor.uidValidity) return; // pollAll remaps it
		if (Number(mb.uidNext) > cursor.lastSeenUid + 1) await this.pollInboxForward();
	}

	private async pollFolder(
		remoteName: string,
		role: FolderRole | undefined,
		path?: string[]
	): Promise<void> {
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
				await this.convex.mutation(fn.recordFolderMapping, {
					accountId: this.account.accountId,
					folderRole: role,
					folderPath: role ? undefined : path,
					remoteName,
					remoteUidValidity: uidValidity,
					initialLastSeenUid: initial,
				});
				this.cursors.set(remoteName, {
					uidValidity,
					lastSeenUid: initial,
					forwardIngestFailures: [],
				});
				return;
			}
			cursor.forwardIngestFailures ??= [];

			// Retry holes the high-water cursor previously moved past. A failed retry
			// stays persisted (up to three attempts), while successful ingest clears
			// it atomically in `advanceCursor`.
			for (const failure of cursor.forwardIngestFailures) {
				let landed = false;
				try {
					for await (const msg of client.fetch(
						String(failure.uid),
						{ uid: true, source: true, flags: true },
						{ uid: true }
					)) {
						if (!msg.source || Number(msg.uid) !== failure.uid) continue;
						await ingestMessage(this.convex, this.rawUploadConfig, {
							accountId: this.account.accountId,
							folderRole: role,
							remoteName,
							remoteUid: failure.uid,
							remoteUidValidity: uidValidity,
							raw: msg.source,
							flags: msg.flags ?? new Set<string>(),
							origin: 'sync',
						});
						landed = true;
					}
				} catch (err) {
					logger.warn(
						{ accountId: this.account.accountId, remoteName, uid: failure.uid, err },
						'forward-sync retry failed'
					);
				}
				if (landed) {
					cursor.forwardIngestFailures = cursor.forwardIngestFailures.filter(
						(entry) => entry.uid !== failure.uid
					);
					continue;
				}
				const state = await this.convex.mutation(fn.recordForwardIngestFailure, {
					accountId: this.account.accountId,
					remoteName,
					remoteUidValidity: uidValidity,
					uid: failure.uid,
				});
				if (!state.retry) {
					cursor.forwardIngestFailures = cursor.forwardIngestFailures.filter(
						(entry) => entry.uid !== failure.uid
					);
					logger.error(
						{
							accountId: this.account.accountId,
							remoteName,
							uid: failure.uid,
							attempts: state.attempts,
						},
						'forward-sync message reached the terminal failure limit'
					);
				} else {
					failure.attempts = state.attempts;
				}
			}

			if (uidNext <= cursor.lastSeenUid + 1) return; // nothing new

			// Uploads run FORWARD_INGEST_CONCURRENCY at a time while the ingest calls
			// commit one by one in UID order, so the cursor below is always the
			// highest UID of a committed prefix — never past a message still in
			// flight.
			const lastSeenUid = cursor.lastSeenUid;
			const failures = cursor.forwardIngestFailures;
			let maxUid = lastSeenUid;
			try {
				await runIngestPipeline(
					newMessages(
						client.fetch(
							`${lastSeenUid + 1}:*`,
							{ uid: true, source: true, flags: true },
							{ uid: true }
						),
						lastSeenUid
					),
					{
						concurrency: FORWARD_INGEST_CONCURRENCY,
						stage: (msg) =>
							stageIngest(this.rawUploadConfig, {
								accountId: this.account.accountId,
								folderRole: role,
								remoteName,
								remoteUid: msg.uid,
								remoteUidValidity: uidValidity,
								raw: msg.source,
								flags: msg.flags,
								// Forward sync: this mail is arriving now, so the server may
								// enqueue the Reply Queue + category classification for it.
								origin: 'sync',
							}),
						commit: async (msg, staged) => {
							const uid = msg.uid;
							try {
								if (!staged.ok) throw staged.error;
								await commitIngest(this.convex, staged.value);
							} catch (err) {
								// Advance past one bad message so it cannot head-of-line-block
								// newer mail, but persist the hole before committing any later
								// UID. Every hole is retried independently and becomes a
								// visible terminal-failure count after three attempts.
								logger.warn(
									{ accountId: this.account.accountId, remoteName, uid, err },
									'ingest failed; skipping message'
								);
								const state = await this.convex.mutation(fn.recordForwardIngestFailure, {
									accountId: this.account.accountId,
									remoteName,
									remoteUidValidity: uidValidity,
									uid,
								});
								if (state.retry) {
									failures.push({ uid, attempts: state.attempts });
								} else {
									logger.error(
										{
											accountId: this.account.accountId,
											remoteName,
											uid,
											attempts: state.attempts,
										},
										'forward-sync message could not enter the retry ledger'
									);
								}
							}
							// Advance only after successful ingest or a durable retry/terminal record.
							if (uid > maxUid) maxUid = uid;
						},
						isStopped: () => this.stopped,
						discard: (_msg, staged) => discardStagedIngest(this.convex, staged),
					}
				);
			} finally {
				if (maxUid > lastSeenUid) {
					this.cursors.set(remoteName, { ...cursor, uidValidity, lastSeenUid: maxUid });
				}
			}
		} finally {
			lock.release();
		}
	}

	/**
	 * Replay on the provider the moves, flag changes and deletes members made in
	 * Owlat (remoteOps.ts). Only ever called inside a cycle; failures are logged
	 * and left for the next one.
	 */
	private async drainQueue(client: ImapFlow): Promise<void> {
		const accountId = this.account.accountId;
		const byRole = new Map<FolderRole, string>();
		for (const f of this.folders) if (f.role) byRole.set(f.role, f.remoteName);
		try {
			await drainRemoteOps({
				listDue: () => this.convex.query(fn.listDueRemoteOps, { accountId }),
				settle: async (results) => {
					await this.convex.mutation(fn.settleRemoteOps, { results });
				},
				replayer: new RemoteOpReplayer(client, {
					byRole,
					allMail: this.allMailPaths,
					renamed: this.renamedFolders,
				}),
				client,
				isStopped: () => this.stopped || this.client !== client,
				onError: (op, err) =>
					logger.warn({ accountId, opId: op.opId, kind: op.kind, err }, 'remote write-back failed'),
			});
		} catch (err) {
			logger.warn({ accountId, err }, 'remote write-back drain failed');
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
			work = await this.convex.query(fn.getBackfillWork, {
				accountId: this.account.accountId,
			});
		} catch (err) {
			logger.warn({ accountId: this.account.accountId, err }, 'getBackfillWork failed');
			return;
		}
		if (!work.isActive || !work.migrationId) return;
		const migrationId = work.migrationId;
		// A fresh migration (or a different one) starts the streak AND the
		// cooldown over — the user pressed 'Try again' and expects it to start.
		// Rebased before the cooldown check for exactly that reason.
		this.backfillRetry = forMigration(this.backfillRetry, migrationId);
		// Pace the retries. Both the periodic poll and every reconnect land here,
		// and the reconnect path has no delay of its own, so without this a
		// provider that drops us repeatedly burns the whole strike budget in
		// seconds and fails an import that was minutes from finishing.
		if (!canStartBackfill(this.backfillRetry, Date.now())) return;
		// A pause the provider's daily budget forced. It lives on the migration,
		// not only in this process, so a restarted worker waits it out too.
		if (work.resumesAt !== undefined && Date.now() < work.resumesAt) return;

		this.backfillRunning = true;
		this.backfillBatchesThisRun = 0;
		logger.info({ accountId: this.account.accountId }, 'starting historical backfill');
		try {
			for (const folder of this.folders) {
				if (this.stopped || !this.client) break;
				// Let mail that arrived since the last pass land as forward sync
				// BEFORE this folder's ceiling is snapshotted — see the method note.
				await this.pollInboxForward();
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
				const decision = nextBackfillRetryState(
					this.backfillRetry,
					{ kind: 'success' },
					Date.now()
				);
				this.backfillRetry = decision.state;
				await this.convex.mutation(fn.completeBackfillImport, {
					migrationId,
				});
				logger.info({ accountId: this.account.accountId }, 'historical backfill complete');
			}
		} catch (err) {
			// A stop request (e.g. the user cancelled) shouldn't count as a failure.
			if (this.stopped) {
				logger.warn({ accountId: this.account.accountId, err }, 'backfill aborted');
			} else {
				const madeProgress = this.backfillBatchesThisRun > 0;
				const decision = nextBackfillRetryState(
					this.backfillRetry,
					{ kind: 'failure', error: err, madeProgress },
					Date.now()
				);
				this.backfillRetry = decision.state;
				logger.warn(
					{
						accountId: this.account.accountId,
						err,
						strikes: decision.state.strikes,
						batches: this.backfillBatchesThisRun,
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
						await this.convex.mutation(fn.markImportFailed, {
							migrationId,
							errorMessage: message,
						});
						logger.warn(
							{ accountId: this.account.accountId, migrationId },
							'backfill failed repeatedly; marking migration import as failed'
						);
					} catch (markErr) {
						logger.warn(
							{ accountId: this.account.accountId, err: markErr },
							'markImportFailed failed'
						);
					}
				}
			}
		} finally {
			this.backfillRunning = false;
			await this.resumeInboxIdle();
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
			const result = await this.convex.mutation(fn.pauseImportForThrottle, {
				migrationId,
				resumeAt,
				reason: describeThrottle(err).slice(0, 500),
			});
			const outcome = result.outcome;
			const context = { accountId: this.account.accountId, migrationId, outcome };
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
				{ accountId: this.account.accountId, err: pauseErr },
				'pauseImportForThrottle failed'
			);
		}
	}

	/**
	 * Forward-poll the INBOX from inside the backfill loop, so new mail is never
	 * swallowed by the historical import.
	 *
	 * While a backfill runs the client hops from folder to folder, so INBOX IDLE
	 * is effectively off and forward sync only fires on the folderPollIntervalMs
	 * timer (5 minutes by default). A mail that arrives inside that window also
	 * lands in Gmail's All Mail (mapped to `archive`), and the walk that starts
	 * from a freshly read ceiling goes newest-first — so the backfill ingests the
	 * All Mail copy FIRST with origin 'backfill'. When the INBOX poll finally
	 * runs, `ingestExternalMessage` dedupes on Message-ID and returns skipped,
	 * and the sync-origin branch (Reply Queue + category checks) never runs: the
	 * user gets no draft for a message that arrived while importing.
	 *
	 * Polling the INBOX immediately before each folder's ceiling snapshot lets
	 * the arriving copy win that race with origin 'sync'; the rate-limited poll
	 * between batches (pollInboxBetweenBatches) keeps the delay short inside a
	 * long folder, and resumeInboxIdle uses it to catch up. Safe to call with
	 * `backfillRunning` set: it takes the same per-mailbox IMAP lock as every
	 * other fetch (the backfill holds no lock between batches) and never waits on
	 * the backfill, and it doesn't touch the IDLE state — `maybeRunBackfill`
	 * already returns to INBOX in its `finally`. Failures are logged and
	 * swallowed so a bad poll can't abort the import or count as a backfill
	 * failure.
	 */
	private async pollInboxForward(): Promise<void> {
		const inbox = this.folders.find((f) => f.role === 'inbox');
		if (!inbox || this.stopped || !this.client) return;
		this.lastInboxPollAt = Date.now();
		try {
			await this.pollFolder(inbox.remoteName, inbox.role);
		} catch (err) {
			logger.warn({ accountId: this.account.accountId, err }, 'inbox forward poll failed');
		}
	}

	/**
	 * The same forward poll between two batches of one folder, so a long folder
	 * (a Gmail All Mail of 100k messages) does not hold new mail back until the
	 * folder is done. Rate-limited by BACKFILL_INBOX_POLL_MIN_MS; the poll before
	 * each folder's ceiling snapshot is not, because that one decides the race.
	 */
	private async pollInboxBetweenBatches(): Promise<void> {
		if (Date.now() - this.lastInboxPollAt < BACKFILL_INBOX_POLL_MIN_MS) return;
		await this.pollInboxForward();
	}

	/** Read a folder's high-water UID, message count, and UIDVALIDITY. */
	private async readFolderMeta(
		remoteName: string
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
		const client = this.client;
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
			const rows = await this.convex.query(fn.findKnownMessageIds, {
				accountId: this.account.accountId,
				messageIds,
			});
			return new Set(rows);
		} catch (err) {
			logger.warn(
				{ accountId: this.account.accountId, err },
				'known-message-id lookup failed; downloading the whole batch'
			);
			return new Set();
		}
	}

	private makeBackfillDeps(uidValidity: number, migrationId: string): BackfillFolderDeps {
		const accountId = this.account.accountId;
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
			batchSize: this.config.backfillBatchSize,
			initFolder: async (remoteName, ceilingUid, messageCount) =>
				await this.convex.mutation(fn.initFolderBackfill, {
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
						this.convex,
						this.rawUploadConfig,
						backfillParams(remoteName, role, uid, raw, flags)
					),
					remoteName,
					uid
				),
			stageIngest: async (remoteName, role, uid, raw, flags) => {
				const staged = await stageIngest(
					this.rawUploadConfig,
					backfillParams(remoteName, role, uid, raw, flags)
				);
				return {
					commit: async () =>
						landedOrWarn(await commitIngest(this.convex, staged), remoteName, uid),
					discard: () => discardStagedIngest(this.convex, staged),
				};
			},
			ingestConcurrency: FORWARD_INGEST_CONCURRENCY,
			reportIngestFailure: (remoteName, uid, err) => {
				// The forward-sync loop logs its skips (pollFolder below); the backfill
				// used to swallow them, which is how an ingest that threw on every
				// message still reported a completed import.
				logger.warn(
					{ accountId, remoteName, uid, err },
					'backfill ingest failed; skipping message'
				);
			},
			recordProgress: async (remoteName, newCursor, importedDelta, failedDelta) => {
				const res = await this.convex.mutation(fn.recordBackfillProgress, {
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
				this.backfillBatchesThisRun += 1;
				return res.stillImporting;
			},
			isStopped: () => this.stopped,
			betweenBatches: () => this.pollInboxBetweenBatches(),
		};
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
