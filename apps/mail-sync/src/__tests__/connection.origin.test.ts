/**
 * Call-site lock for the ingest `origin` flag (the forward-sync-only rule).
 *
 * `origin` is what tells the Convex side whether a message is arriving NOW or
 * being imported from history: `mail/external/delivery.ts` enqueues the Reply
 * Queue + category classification for `'sync'` inbox mail and nothing else. The
 * flag is only ever correct if the two call sites in connection.ts pass the
 * right literal, so both are exercised here against a mocked `ingestMessage`:
 * the forward poll loop and the backfill dependency handed to `backfillFolder`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConnectableAccount, ConvexClient } from '../convex.js';
import type { MailSyncConfig } from '../config.js';
import type { BackfillFolderDeps } from '../backfill.js';

const ingest = vi.hoisted(() => ({ ingestMessage: vi.fn(async () => {}) }));
vi.mock('../ingest.js', () => ({ ingestMessage: ingest.ingestMessage }));

// The folder walk itself is covered by backfill.test.ts; stubbing it here keeps
// the backfill-loop test about ORDER (forward poll vs. ceiling snapshot).
const backfill = vi.hoisted(() => ({ backfillFolder: vi.fn(async () => {}) }));
vi.mock('../backfill.js', () => ({ backfillFolder: backfill.backfillFolder }));

const { AccountConnection } = await import('../connection.js');

const ACCOUNT: ConnectableAccount = {
	accountId: 'acct_1',
	mailboxId: 'mbx_1',
	imapHost: 'imap.example.com',
	imapPort: 993,
	isImapSecure: true,
	imapUsername: 'me@example.com',
	status: 'connected',
};

const CONFIG = { backfillBatchSize: 50 } as unknown as MailSyncConfig;

const RAW = Buffer.from('From: a@example.com\r\nSubject: hi\r\n\r\nbody\r\n');

/** Minimal ImapFlow stand-in: one open folder holding a single new UID. */
function fakeClient(opts: { uidValidity: number; uidNext: number }) {
	return {
		mailbox: { uidValidity: opts.uidValidity, uidNext: opts.uidNext },
		getMailboxLock: async () => ({ release: () => {} }),
		async *fetch() {
			yield { uid: opts.uidNext - 1, source: RAW, flags: new Set<string>(['\\Seen']) };
		},
	};
}

/** Reach into the private members the two call sites live behind. */
type ConnectionInternals = {
	client: unknown;
	cursors: Map<string, { uidValidity: number; lastSeenUid: number }>;
	pollFolder(remoteName: string, role: string): Promise<void>;
	makeBackfillDeps(uidValidity: number, migrationId: string): BackfillFolderDeps;
};

function newConnection(): ConnectionInternals {
	const convex = {
		query: vi.fn(async () => []),
		mutation: vi.fn(async () => ({})),
		action: vi.fn(async () => ({})),
	} as unknown as ConvexClient;
	return new AccountConnection(ACCOUNT, convex, CONFIG) as unknown as ConnectionInternals;
}

beforeEach(() => {
	ingest.ingestMessage.mockClear();
	backfill.backfillFolder.mockClear();
});

describe('ingest origin at the connection call sites', () => {
	it("tags the forward poll loop's fetch as 'sync'", async () => {
		const conn = newConnection();
		conn.client = fakeClient({ uidValidity: 7, uidNext: 43 });
		// A known cursor with the same UIDVALIDITY, so the poll takes the
		// incremental-fetch arm instead of the first-sight mapping arm.
		conn.cursors.set('INBOX', { uidValidity: 7, lastSeenUid: 41 });

		await conn.pollFolder('INBOX', 'inbox');

		expect(ingest.ingestMessage).toHaveBeenCalledTimes(1);
		const params = ingest.ingestMessage.mock.calls[0]![1] as Record<string, unknown>;
		expect(params.origin).toBe('sync');
		expect(params.remoteUid).toBe(42);
		expect(params.folderRole).toBe('inbox');
	});

	it("tags the backfill dependency's ingest as 'backfill'", async () => {
		const conn = newConnection();
		const deps = conn.makeBackfillDeps(7, 'mig_1');

		await deps.ingest('INBOX', 'inbox', 17, RAW, new Set<string>());

		expect(ingest.ingestMessage).toHaveBeenCalledTimes(1);
		const params = ingest.ingestMessage.mock.calls[0]![1] as Record<string, unknown>;
		expect(params.origin).toBe('backfill');
		expect(params.remoteUid).toBe(17);
	});
});

/**
 * A folder-hopping backfill turns INBOX IDLE off, so without an explicit poll a
 * mail that arrives mid-import is first seen by the backfill's newest-first walk
 * over Gmail's All Mail — ingested as 'backfill', which makes the later INBOX
 * poll a Message-ID dup and costs the user their draft. maybeRunBackfill()
 * therefore forward-polls the INBOX before snapshotting each folder's ceiling.
 */
describe('forward INBOX poll inside the backfill loop', () => {
	/** Ordered trace of what the fake IMAP client + the ingest seam saw. */
	type Trace = string[];

	type BackfillInternals = ConnectionInternals & {
		folders: Array<{ remoteName: string; role: string }>;
		readFolderMeta(
			remoteName: string
		): Promise<{ ceilingUid: number; messageCount: number; uidValidity: number } | null>;
		maybeRunBackfill(): Promise<void>;
	};

	/** Two mapped folders, INBOX holding exactly one unseen UID (42). */
	function fakeBackfillClient(trace: Trace) {
		const boxes: Record<string, { uidValidity: number; uidNext: number; exists: number }> = {
			INBOX: { uidValidity: 7, uidNext: 43, exists: 10 },
			'[Gmail]/All Mail': { uidValidity: 7, uidNext: 900, exists: 500 },
		};
		let open = 'INBOX';
		return {
			get mailbox() {
				return boxes[open];
			},
			getMailboxLock: async (remoteName: string) => {
				open = remoteName;
				trace.push(`lock:${remoteName}`);
				return { release: () => {} };
			},
			mailboxOpen: async (remoteName: string) => {
				open = remoteName;
			},
			async *fetch() {
				if (open !== 'INBOX') return;
				yield { uid: 42, source: RAW, flags: new Set<string>() };
			},
		};
	}

	function backfillConnection(trace: Trace): BackfillInternals {
		const convex = {
			query: vi.fn(async (ref: string) =>
				ref.includes('getBackfillWork') ? { isActive: true, migrationId: 'mig_1' } : ([] as unknown)
			),
			mutation: vi.fn(async () => ({})),
			action: vi.fn(async () => ({})),
		} as unknown as ConvexClient;
		const conn = new AccountConnection(ACCOUNT, convex, CONFIG) as unknown as BackfillInternals;
		conn.client = fakeBackfillClient(trace);
		conn.folders = [
			{ remoteName: 'INBOX', role: 'inbox' },
			{ remoteName: '[Gmail]/All Mail', role: 'archive' },
		];
		// Known cursor ⇒ the poll takes the incremental-fetch arm, not first sight.
		conn.cursors.set('INBOX', { uidValidity: 7, lastSeenUid: 41 });
		// Trace the ceiling snapshot without replacing it: the real implementation
		// still runs, bound before the instance property shadows the prototype.
		const readFolderMeta = conn.readFolderMeta.bind(conn);
		conn.readFolderMeta = async (remoteName: string) => {
			trace.push(`ceiling:${remoteName}`);
			return await readFolderMeta(remoteName);
		};
		return conn;
	}

	it('polls the INBOX before every folder ceiling snapshot', async () => {
		const trace: Trace = [];
		const conn = backfillConnection(trace);

		await conn.maybeRunBackfill();

		const ceilings = trace.filter((e) => e.startsWith('ceiling:'));
		expect(ceilings).toEqual(['ceiling:INBOX', 'ceiling:[Gmail]/All Mail']);
		// Each snapshot is immediately preceded by an INBOX fetch attempt.
		for (const ceiling of ceilings) {
			expect(trace[trace.indexOf(ceiling) - 1]).toBe('lock:INBOX');
		}
	});

	it("lets the mail arriving mid-import through as 'sync' before the backfill claims it", async () => {
		const trace: Trace = [];
		const conn = backfillConnection(trace);

		await conn.maybeRunBackfill();

		// Exactly one ingest: the forward poll's, tagged 'sync' — and it happened
		// before the first folder's walk could reach the same message.
		expect(ingest.ingestMessage).toHaveBeenCalledTimes(1);
		const params = ingest.ingestMessage.mock.calls[0]![1] as Record<string, unknown>;
		expect(params.origin).toBe('sync');
		expect(params.folderRole).toBe('inbox');
		expect(params.remoteUid).toBe(42);
		expect(backfill.backfillFolder).toHaveBeenCalledTimes(2);
		expect(ingest.ingestMessage.mock.invocationCallOrder[0]!).toBeLessThan(
			backfill.backfillFolder.mock.invocationCallOrder[0]!
		);
	});
});
