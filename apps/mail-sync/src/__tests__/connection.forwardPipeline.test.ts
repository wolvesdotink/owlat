/**
 * Forward sync ingests through the pipeline (plan 3.6): the raw uploads of a
 * folder's new mail overlap, the ingest calls commit in UID order, and the
 * in-memory cursor lands on the highest UID of the committed prefix even when
 * the poll dies halfway.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFunctionName, type AnyFunctionReference } from 'convex/server';
import type { ConnectableAccount, ConvexClient } from '../convex.js';
import type { MailSyncConfig } from '../config.js';

const ingest = vi.hoisted(() => ({
	ingestMessage: vi.fn(async (..._args: unknown[]) => ({ messageId: 'msg_1' })),
	isMessageLanded: vi.fn(() => true),
	stageIngest: vi.fn(async (_config: unknown, params: { remoteUid: number }) => ({ params })),
	commitIngest: vi.fn(async (_convex: unknown, _staged: { params: { remoteUid: number } }) => ({
		messageId: 'msg_1',
	})),
	discardStagedIngest: vi.fn(
		async (_convex: unknown, _staged: { params: { remoteUid: number } }) => undefined
	),
}));
vi.mock('../ingest.js', () => ingest);

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../logger.js', () => ({ logger: log }));

const { AccountConnection } = await import('../connection.js');
const { FORWARD_INGEST_CONCURRENCY } = await import('../ingestPipeline.js');

const ACCOUNT: ConnectableAccount = {
	accountId: 'acct_1',
	mailboxId: 'mbx_1',
	imapHost: 'imap.example.com',
	imapPort: 993,
	isImapSecure: true,
	imapUsername: 'me@owlat.test',
	status: 'connected',
};

const RAW = Buffer.from('From: a@owlat.test\r\nSubject: hi\r\n\r\nbody\r\n');

type Internals = {
	client: unknown;
	cursors: Map<string, { uidValidity: number; lastSeenUid: number }>;
	pollFolder(remoteName: string, role: string): Promise<void>;
};

function connection(uids: number[], mutation = vi.fn(async () => ({}))) {
	const convex = {
		query: vi.fn(async () => []),
		mutation,
		action: vi.fn(async () => ({})),
	} as unknown as ConvexClient;
	const conn = new AccountConnection(ACCOUNT, convex, {} as MailSyncConfig) as unknown as Internals;
	conn.client = {
		mailbox: { uidValidity: 7, uidNext: Math.max(...uids) + 1 },
		getMailboxLock: async () => ({ release: () => {} }),
		async *fetch() {
			for (const uid of uids) yield { uid, source: RAW, flags: new Set<string>() };
		},
	};
	conn.cursors.set('INBOX', { uidValidity: 7, lastSeenUid: 41 });
	return conn;
}

const committedUids = () => ingest.commitIngest.mock.calls.map((call) => call[1].params.remoteUid);

beforeEach(() => {
	ingest.stageIngest.mockClear();
	ingest.commitIngest.mockClear();
	ingest.discardStagedIngest.mockClear();
	ingest.stageIngest.mockImplementation(async (_config, params) => ({ params }));
	ingest.commitIngest.mockImplementation(async () => ({ messageId: 'msg_1' }));
});

describe('forward sync pipeline', () => {
	it('starts the next uploads before the first message commits', async () => {
		expect(FORWARD_INGEST_CONCURRENCY).toBe(4);
		const releases: Array<() => void> = [];
		ingest.stageIngest.mockImplementation(async (_config, params) => {
			await new Promise<void>((resolve) => releases.push(resolve));
			return { params };
		});
		const conn = connection([42, 43, 44, 45, 46]);

		const poll = conn.pollFolder('INBOX', 'inbox');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(ingest.stageIngest).toHaveBeenCalledTimes(4);
		expect(ingest.commitIngest).not.toHaveBeenCalled();

		// Finish the uploads last-first; the commits still go in UID order.
		while (ingest.commitIngest.mock.calls.length < 5) {
			for (const release of releases.splice(0).reverse()) release();
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		await poll;

		expect(committedUids()).toEqual([42, 43, 44, 45, 46]);
		expect(conn.cursors.get('INBOX')?.lastSeenUid).toBe(46);
	});

	it('keeps the cursor on the committed prefix when a poll dies midway', async () => {
		// UID 44 fails to ingest AND its failure cannot be recorded, so the poll
		// throws there. 42 and 43 are in; 44 and 45 are not.
		ingest.commitIngest.mockImplementation(async (_convex, staged) => {
			if (staged.params.remoteUid === 44) throw new Error('ingest failed');
			return { messageId: 'msg_1' };
		});
		const mutation = vi.fn(async (fnRef: AnyFunctionReference) => {
			if (getFunctionName(fnRef).includes('recordForwardIngestFailure')) {
				throw new Error('convex unreachable');
			}
			return {};
		});
		const conn = connection([42, 43, 44, 45], mutation);

		await expect(conn.pollFolder('INBOX', 'inbox')).rejects.toThrow('convex unreachable');

		expect(committedUids()).toEqual([42, 43, 44]);
		expect(conn.cursors.get('INBOX')?.lastSeenUid).toBe(43);
		// 45 was uploaded and will be fetched again by the next poll: its upload
		// is freed rather than left behind. 44 reached the server and is not.
		expect(ingest.discardStagedIngest.mock.calls.map((call) => call[1].params.remoteUid)).toEqual([
			45,
		]);
	});
});
