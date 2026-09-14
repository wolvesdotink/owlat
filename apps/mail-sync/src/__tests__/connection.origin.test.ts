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

beforeEach(() => ingest.ingestMessage.mockClear());

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
