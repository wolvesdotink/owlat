/**
 * Forward sync of one folder: ingest the mail that arrived past the folder's
 * high-water UID, and retry the holes an earlier poll moved past.
 *
 * v1 only syncs NEW mail going forward — on first sight of a folder (or a
 * UIDVALIDITY change) the current high-water UID is recorded and historical
 * mail is left to a migration's backfill (backfill.ts).
 */

import type { ImapFlow } from 'imapflow';
import type { ConvexClient } from './convex.js';
import { fn } from './convex.js';
import type { FolderRole } from './folders.js';
import {
	commitIngest,
	discardStagedIngest,
	ingestMessage,
	stageIngest,
	type RawUploadConfig,
} from './ingest.js';
import { FORWARD_INGEST_CONCURRENCY, newMessages, runIngestPipeline } from './ingestPipeline.js';
import { logger } from './logger.js';

/** A folder's forward-sync position, as persisted by `getSyncState`. */
export interface FolderCursor {
	uidValidity: number;
	lastSeenUid: number;
	forwardIngestFailures?: Array<{ uid: number; attempts: number }>;
}

export interface ForwardSyncDeps {
	client: ImapFlow;
	convex: ConvexClient;
	accountId: string;
	rawUploadConfig: RawUploadConfig;
	/** The connection's cursors, updated in place as mail lands. */
	cursors: Map<string, FolderCursor>;
	isStopped: () => boolean;
}

export async function pollFolderForward(
	deps: ForwardSyncDeps,
	remoteName: string,
	role: FolderRole | undefined,
	path?: string[]
): Promise<void> {
	const { client, convex, accountId, rawUploadConfig, cursors } = deps;
	const lock = await client.getMailboxLock(remoteName);
	try {
		const mb = client.mailbox;
		if (!mb || typeof mb === 'boolean') return;
		const uidValidity = Number(mb.uidValidity);
		const uidNext = Number(mb.uidNext);
		let cursor = cursors.get(remoteName);

		// First sight or UIDVALIDITY rotation → record the mapping + set the
		// high-water mark so v1 only syncs NEW mail going forward.
		if (!cursor || cursor.uidValidity !== uidValidity) {
			const initial = Math.max(0, uidNext - 1);
			await convex.mutation(fn.recordFolderMapping, {
				accountId,
				folderRole: role,
				folderPath: role ? undefined : path,
				remoteName,
				remoteUidValidity: uidValidity,
				initialLastSeenUid: initial,
			});
			cursors.set(remoteName, {
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
					await ingestMessage(convex, rawUploadConfig, {
						accountId,
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
				logger.warn({ accountId, remoteName, uid: failure.uid, err }, 'forward-sync retry failed');
			}
			if (landed) {
				cursor.forwardIngestFailures = cursor.forwardIngestFailures.filter(
					(entry) => entry.uid !== failure.uid
				);
				continue;
			}
			const state = await convex.mutation(fn.recordForwardIngestFailure, {
				accountId,
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
						accountId,
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
						stageIngest(rawUploadConfig, {
							accountId,
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
							await commitIngest(convex, staged.value);
						} catch (err) {
							// Advance past one bad message so it cannot head-of-line-block
							// newer mail, but persist the hole before committing any later
							// UID. Every hole is retried independently and becomes a
							// visible terminal-failure count after three attempts.
							logger.warn({ accountId, remoteName, uid, err }, 'ingest failed; skipping message');
							const state = await convex.mutation(fn.recordForwardIngestFailure, {
								accountId,
								remoteName,
								remoteUidValidity: uidValidity,
								uid,
							});
							if (state.retry) {
								failures.push({ uid, attempts: state.attempts });
							} else {
								logger.error(
									{
										accountId,
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
					isStopped: deps.isStopped,
					discard: (_msg, staged) => discardStagedIngest(convex, staged),
				}
			);
		} finally {
			if (maxUid > lastSeenUid) {
				cursors.set(remoteName, { ...cursor, uidValidity, lastSeenUid: maxUid });
			}
		}
	} finally {
		lock.release();
	}
}

/**
 * Least time between two INBOX forward polls that the backfill makes between
 * its batches. A re-walk of mail that is already imported moves through a
 * batch in one envelope fetch, and polling after every one of those would
 * spend a SELECT pair per batch against providers that meter commands.
 */
const BACKFILL_INBOX_POLL_MIN_MS = 10_000;

/** What the INBOX poller reads from, and asks of, the connection (connection.ts). */
export interface InboxPollHost {
	readonly accountId: string;
	client(): ImapFlow | null;
	inbox(): { remoteName: string; role?: FolderRole } | undefined;
	cursor(remoteName: string): FolderCursor | undefined;
	isStopped(): boolean;
	pollFolder(remoteName: string, role: FolderRole | undefined): Promise<void>;
}

/**
 * Keeps new INBOX mail flowing while IDLE is not: between cycles, behind a
 * backfill, and on the connection's own short timer.
 */
export class InboxPoller {
	// Set while the INBOX catch-up poll runs, so a slow one is never stacked.
	private isCatchUpRunning = false;
	// When the INBOX was last forward-polled (pollForward).
	private lastPollAt = 0;

	constructor(private readonly host: InboxPollHost) {}

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
	async catchUp(): Promise<void> {
		if (this.host.isStopped() || !this.host.client() || this.isCatchUpRunning) return;
		this.isCatchUpRunning = true;
		try {
			await this.pollForward();
		} finally {
			this.isCatchUpRunning = false;
		}
	}

	/**
	 * Return to INBOX so IDLE resumes there for real-time delivery, and catch up
	 * on what arrived while another folder was selected: that mail raised no
	 * 'exists' event, so without the UIDNEXT check it would wait for the next
	 * periodic poll.
	 */
	async resumeIdle(): Promise<void> {
		const client = this.host.client();
		if (!client || this.host.isStopped()) return;
		try {
			await client.mailboxOpen('INBOX');
		} catch {
			return; // reconnect handler will recover
		}
		const inbox = this.host.inbox();
		const cursor = inbox ? this.host.cursor(inbox.remoteName) : undefined;
		const mb = client.mailbox;
		if (!cursor || !mb || typeof mb === 'boolean') return;
		if (Number(mb.uidValidity) !== cursor.uidValidity) return; // pollAll remaps it
		if (Number(mb.uidNext) > cursor.lastSeenUid + 1) await this.pollForward();
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
	 * between batches (pollBetweenBatches) keeps the delay short inside a
	 * long folder, and resumeIdle uses it to catch up. Safe to call while the
	 * backfill runs: it takes the same per-mailbox IMAP lock as every
	 * other fetch (the backfill holds no lock between batches) and never waits on
	 * the backfill, and it doesn't touch the IDLE state — the backfill runner
	 * already returns to INBOX in its `finally`. Failures are logged and
	 * swallowed so a bad poll can't abort the import or count as a backfill
	 * failure.
	 */
	async pollForward(): Promise<void> {
		const inbox = this.host.inbox();
		if (!inbox || this.host.isStopped() || !this.host.client()) return;
		this.lastPollAt = Date.now();
		try {
			await this.host.pollFolder(inbox.remoteName, inbox.role);
		} catch (err) {
			logger.warn({ accountId: this.host.accountId, err }, 'inbox forward poll failed');
		}
	}

	/**
	 * The same forward poll between two batches of one folder, so a long folder
	 * (a Gmail All Mail of 100k messages) does not hold new mail back until the
	 * folder is done. Rate-limited by BACKFILL_INBOX_POLL_MIN_MS; the poll before
	 * each folder's ceiling snapshot is not, because that one decides the race.
	 */
	async pollBetweenBatches(): Promise<void> {
		if (Date.now() - this.lastPollAt < BACKFILL_INBOX_POLL_MIN_MS) return;
		await this.pollForward();
	}
}
