/**
 * The Convex deployment the mail-sync worker talks to during the kill test:
 * the HTTP function API (`/api/query|mutation|action`) for the endpoints the
 * worker calls on connect and during a historical backfill, and the raw-upload
 * HTTP action under `/http`.
 *
 * It mirrors the server rules a crash can expose, and nothing more:
 *   - `ingestExternalRaw` dedups on Message-ID within the mailbox (as
 *     `mail/external/delivery.ts` does), so a re-ingest after a restart is a
 *     `duplicate`, never a second row;
 *   - `initFolderBackfill` resumes from a stored cursor and
 *     `recordBackfillProgress` is the only thing that moves it (as
 *     `mail/migrationBackfill.ts` does), so a batch interrupted before its
 *     progress write is walked again.
 *
 * A hold rule commits one ingest and then never answers it: the worker dies
 * holding a message the server already stored, inside a batch whose cursor has
 * not advanced. That is the worst case for both duplicates and losses.
 */

import type { EventLog } from './events';

export const ACCOUNT_ID = 'kill_account';
const MAILBOX_ID = 'kill_mailbox';
const MIGRATION_ID = 'kill_migration';

export interface ImapAccountFixture {
	readonly host: string;
	readonly port: number;
	readonly username: string;
	readonly password: string;
}

interface SyncRow {
	remoteUidValidity: number;
	lastSeenUid: number;
	folderId: string;
	backfillCursor?: number;
	backfillTotal?: number;
}

export interface StoredMessage {
	readonly messageId: string;
	readonly remoteUid: number;
	readonly origin: string | undefined;
}

export interface IngestCall {
	readonly messageId: string;
	readonly remoteUid: number;
	readonly outcome: 'stored' | 'duplicate';
	readonly held: boolean;
}

type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown;

/** What a stalled request resolves to: the stub never answers it. */
const NEVER = new Promise<never>(() => {});

export class ConvexStub {
	readonly stored = new Map<string, StoredMessage>();
	readonly ingestCalls: IngestCall[] = [];
	readonly progress: Array<{
		remoteName: string;
		newCursor: number;
		imported: number;
		failed: number;
	}> = [];
	migrationStatus: 'idle' | 'importing' | 'finalizing' | 'failed' = 'idle';
	private readonly rows = new Map<string, SyncRow>();
	private readonly staged = new Set<string>();
	private holdUids = new Set<number>();
	private uploads = 0;
	private readonly handlers: Record<string, Handler>;

	constructor(
		private readonly events: EventLog,
		private readonly imap: ImapAccountFixture
	) {
		this.handlers = {
			'mail/external/accounts:listConnectableAccounts': () => [
				{
					accountId: ACCOUNT_ID,
					mailboxId: MAILBOX_ID,
					imapHost: imap.host,
					imapPort: imap.port,
					isImapSecure: false,
					imapUsername: imap.username,
					status: 'connected',
				},
			],
			'mail/external/accountsActions:getCredentialsForWorker': () => ({
				kind: 'credentials',
				credentials: {
					imapHost: imap.host,
					imapPort: imap.port,
					isImapSecure: false,
					smtpHost: imap.host,
					smtpPort: 587,
					isSmtpSecure: false,
					imapUsername: imap.username,
					smtpUsername: imap.username,
					imapPassword: imap.password,
					smtpPassword: imap.password,
				},
			}),
			'mail/external/accounts:setSyncStatus': () => null,
			'mail/external/remoteState:getSyncSettings': () => ({ mode: 'incoming', isAligned: false }),
			'mail/external/remoteOps:listDueRemoteOps': () => [],
			'mail/external/remoteOps:settleRemoteOps': () => null,
			'mail/external/remoteFolderRename:listQueuedFolderRenames': () => ({
				page: [],
				isDone: true,
				continueCursor: '',
			}),
			'analytics/seedProbePoller:listSeedProbeWork': () => ({
				items: [],
				cursor: null,
				isDone: true,
			}),
			'mail/external/delivery:getSyncState': () =>
				[...this.rows].map(([remoteName, row]) => ({
					remoteName,
					remoteUidValidity: row.remoteUidValidity,
					lastSeenUid: row.lastSeenUid,
					folderId: row.folderId,
					forwardIngestFailures: [],
					forwardIngestFailureCount: 0,
				})),
			'mail/external/delivery:recordFolderMapping': (args) => {
				this.rows.set(String(args['remoteName']), {
					remoteUidValidity: Number(args['remoteUidValidity']),
					lastSeenUid: Number(args['initialLastSeenUid']),
					folderId: `kill_folder_${this.rows.size + 1}`,
				});
				return null;
			},
			'mail/external/delivery:recordForwardIngestFailure': () => ({ retry: false, attempts: 1 }),
			'mail/external/delivery:discardStagedRaw': (args) => {
				this.staged.delete(String(args['rawStorageId']));
				return null;
			},
			'mail/external/delivery:ingestExternalRaw': (args) => this.ingest(args),
			'mail/migrationBackfill:getBackfillWork': () =>
				this.migrationStatus === 'importing'
					? { isActive: true, migrationId: MIGRATION_ID }
					: { isActive: false, migrationId: null },
			'mail/migrationBackfill:initFolderBackfill': (args) => {
				const row = this.rows.get(String(args['remoteName']));
				if (this.migrationStatus !== 'importing' || !row) return null;
				if (row.backfillCursor !== undefined && row.backfillTotal !== undefined) {
					return { startCursor: row.backfillCursor };
				}
				row.backfillCursor = Math.max(0, Number(args['ceilingUid']));
				row.backfillTotal = Math.max(0, Number(args['messageCount']));
				return { startCursor: row.backfillCursor };
			},
			'mail/migrationBackfill:findKnownMessageIds': (args) =>
				(args['messageIds'] as string[]).filter((id) => this.stored.has(id)),
			'mail/migrationBackfill:recordBackfillProgress': (args) => {
				if (this.migrationStatus !== 'importing') return { stillImporting: false };
				const remoteName = String(args['remoteName']);
				const row = this.rows.get(remoteName);
				if (row) row.backfillCursor = Number(args['newCursor']);
				const entry = {
					remoteName,
					newCursor: Number(args['newCursor']),
					imported: Number(args['importedDelta']),
					failed: Number(args['failedDelta']),
				};
				this.progress.push(entry);
				this.events.emit(`convex.progress:${remoteName}:${entry.newCursor}`, entry);
				return { stillImporting: true };
			},
			'mail/migrationBackfill:completeBackfillImport': () => {
				this.migrationStatus = 'finalizing';
				this.events.emit('convex.backfill.complete');
				return null;
			},
			'mail/migrationBackfill:markImportFailed': (args) => {
				this.migrationStatus = 'failed';
				this.events.emit('convex.backfill.failed', args);
				return null;
			},
			'mail/migrationBackfill:pauseImportForThrottle': () => ({ outcome: 'ignored' }),
		};
	}

	/** Start a migration import: the worker's next connect or periodic pass picks it up. */
	startImport(holdUids: readonly number[]): void {
		this.holdUids = new Set(holdUids);
		this.migrationStatus = 'importing';
	}

	cursorOf(remoteName: string): number | undefined {
		return this.rows.get(remoteName)?.backfillCursor;
	}

	/** Answer one Convex HTTP function call; `null` when the path is not a function call. */
	async call(path: string, body: unknown): Promise<unknown> {
		const request = body as { path?: string; args?: Args[] };
		const name = String(request.path ?? '').replace(/\.js(?=:)/, '');
		const handler = this.handlers[name];
		if (!handler) {
			this.events.emit(`convex.unknown:${name}`, { path });
			return { status: 'error', errorMessage: `Could not find public function for '${name}'` };
		}
		const value = await handler(request.args?.[0] ?? {});
		return { status: 'success', value, logLines: [] };
	}

	/** The raw `.eml` upload HTTP action. */
	upload(size: number): { storageId: string; size: number } {
		const storageId = `kill_storage_${++this.uploads}`;
		this.staged.add(storageId);
		return { storageId, size };
	}

	private ingest(args: Args): unknown {
		const messageId = String(args['messageId']);
		const remoteUid = Number(args['remoteUid']);
		this.staged.delete(String(args['rawStorageId']));
		const duplicate = this.stored.has(messageId);
		if (!duplicate) {
			this.stored.set(messageId, {
				messageId,
				remoteUid,
				origin: args['origin'] as string | undefined,
			});
		}
		const held = this.holdUids.delete(remoteUid);
		this.ingestCalls.push({
			messageId,
			remoteUid,
			outcome: duplicate ? 'duplicate' : 'stored',
			held,
		});
		this.events.emit(`convex.ingest:${remoteUid}`, { messageId, duplicate });
		if (held) {
			this.events.emit(`convex.ingest.held:${remoteUid}`, { messageId });
			return NEVER;
		}
		return duplicate ? { skipped: 'duplicate' } : { messageId: `kill_message_${this.stored.size}` };
	}
}
