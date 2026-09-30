/**
 * New mail keeps arriving while a historical import runs (plan 1.19).
 *
 * The backfill keeps some other folder selected for as long as that folder
 * takes, so INBOX IDLE is off and nothing but an explicit poll brings new mail
 * in. Two seams close that gap: the walk forward-polls the INBOX between its
 * batches (rate-limited), and re-selecting the INBOX afterwards compares
 * UIDNEXT with the cursor, because mail that arrived while another folder was
 * selected raised no 'exists' event.
 *
 * The folder walk is the real `backfillFolder`; only IMAP, Convex and the
 * ingest seam are faked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getFunctionName, type AnyFunctionReference } from 'convex/server';
import type { ConnectableAccount, ConvexClient } from '../convex.js';
import type { MailSyncConfig } from '../config.js';

const ingest = vi.hoisted(() => {
	const ingestMessage = vi.fn(async (..._args: unknown[]) => ({ messageId: 'msg_1' }));
	return {
		ingestMessage,
		isMessageLanded: vi.fn(() => true),
		// The staged path lands in `ingestMessage` too, so every ingest — staged
		// or not — shows up in one call log, in commit order.
		stageIngest: vi.fn(async (_config: unknown, params: unknown) => ({ params })),
		commitIngest: vi.fn(async (convex: unknown, staged: { params: unknown }) =>
			ingestMessage(convex, undefined, staged.params)
		),
	};
});
vi.mock('../ingest.js', () => ({
	ingestMessage: ingest.ingestMessage,
	isMessageLanded: ingest.isMessageLanded,
	stageIngest: ingest.stageIngest,
	commitIngest: ingest.commitIngest,
}));

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../logger.js', () => ({ logger: log }));

const { AccountConnection } = await import('../connection.js');

const ACCOUNT: ConnectableAccount = {
	accountId: 'acct_1',
	mailboxId: 'mbx_1',
	imapHost: 'imap.example.com',
	imapPort: 993,
	isImapSecure: true,
	imapUsername: 'team@owlat.test',
	status: 'connected',
};

// One UID per batch, so a three-message folder is walked in three batches.
const CONFIG = { backfillBatchSize: 1 } as unknown as MailSyncConfig;

const ALL_MAIL = '[Gmail]/All Mail';
const RAW = Buffer.from('From: a@owlat.test\r\nSubject: hi\r\n\r\nbody\r\n');
const START = Date.UTC(2026, 8, 29, 9, 0);

type Box = { uidValidity: number; uidNext: number; exists: number };

/**
 * ImapFlow stand-in with an INBOX (cursor at 42, nothing new) and a
 * three-message All Mail. `onAllMailBatch` runs as each All Mail batch is
 * listed — where a test lets time pass or new mail arrive.
 */
function fakeImap(onAllMailBatch: (batch: number) => void) {
	const boxes: Record<string, Box> = {
		INBOX: { uidValidity: 7, uidNext: 43, exists: 42 },
		[ALL_MAIL]: { uidValidity: 9, uidNext: 4, exists: 3 },
	};
	const inbox = new Map<number, Buffer>();
	let open = 'INBOX';
	let batches = 0;
	return {
		get mailbox() {
			return boxes[open];
		},
		getMailboxLock: async (remoteName: string) => {
			open = remoteName;
			return { release: () => {} };
		},
		mailboxOpen: async (remoteName: string) => {
			open = remoteName;
			return boxes[remoteName];
		},
		async *fetch(range: string, query: Record<string, unknown>) {
			if (open === 'INBOX') {
				const from = Number(range.split(':')[0]);
				for (const [uid, source] of inbox) {
					if (uid >= from) yield { uid, source, flags: new Set<string>() };
				}
				return;
			}
			if (query.envelope === true) {
				onAllMailBatch(++batches);
				const [start, end] = range.split(':').map(Number) as [number, number];
				for (let uid = end; uid >= start; uid--) {
					yield {
						uid,
						flags: new Set<string>(),
						envelope: { messageId: `<am-${uid}@owlat.test>` },
					};
				}
				return;
			}
			for (const uid of range.split(',').map(Number)) {
				yield { uid, source: RAW, flags: new Set<string>() };
			}
		},
		/** A new message lands in the INBOX — no 'exists' event, as with IDLE off. */
		deliver(uid: number) {
			inbox.set(uid, RAW);
			boxes.INBOX!.uidNext = uid + 1;
			boxes.INBOX!.exists += 1;
		},
		setInboxUidValidity(uidValidity: number) {
			boxes.INBOX!.uidValidity = uidValidity;
		},
	};
}

type Internals = {
	client: unknown;
	folders: Array<{ remoteName: string; role: string }>;
	cursors: Map<
		string,
		{
			uidValidity: number;
			lastSeenUid: number;
			forwardIngestFailures?: Array<{ uid: number; attempts: number }>;
		}
	>;
	pollFolder(remoteName: string, role: string): Promise<void>;
	maybeRunBackfill(): Promise<void>;
	resumeInboxIdle(): Promise<void>;
	catchUpInbox(): Promise<void>;
};

function connection(imap: ReturnType<typeof fakeImap>) {
	const convex = {
		query: vi.fn(async (fnRef: AnyFunctionReference) =>
			getFunctionName(fnRef).includes('getBackfillWork')
				? { isActive: true, migrationId: 'mig_1' }
				: ([] as unknown)
		),
		mutation: vi.fn(async (fnRef: AnyFunctionReference, args: Record<string, unknown>) => {
			const name = getFunctionName(fnRef);
			// Only All Mail is walked; the INBOX folder has no sync row to import.
			if (name.includes('initFolderBackfill')) {
				return args.remoteName === ALL_MAIL ? { startCursor: 3 } : null;
			}
			if (name.includes('recordBackfillProgress')) return { stillImporting: true };
			return {};
		}),
		action: vi.fn(async () => ({})),
	} as unknown as ConvexClient;
	const conn = new AccountConnection(ACCOUNT, convex, CONFIG) as unknown as Internals;
	conn.client = imap;
	conn.folders = [
		{ remoteName: 'INBOX', role: 'inbox' },
		{ remoteName: ALL_MAIL, role: 'archive' },
	];
	conn.cursors.set('INBOX', { uidValidity: 7, lastSeenUid: 42, forwardIngestFailures: [] });
	const pollFolder = conn.pollFolder.bind(conn);
	const polls: string[] = [];
	conn.pollFolder = async (remoteName: string, role: string) => {
		polls.push(remoteName);
		return await pollFolder(remoteName, role);
	};
	return { conn, polls };
}

/** `folder:uid:origin` for every ingest, in call order. */
function ingested(): string[] {
	return ingest.ingestMessage.mock.calls.map((call) => {
		const p = (call as unknown[])[2] as { remoteName: string; remoteUid: number; origin: string };
		return `${p.remoteName}:${p.remoteUid}:${p.origin}`;
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(START);
	ingest.ingestMessage.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('INBOX polls between backfill batches', () => {
	it('brings mail that arrives mid-folder in before the folder is finished', async () => {
		const imap = fakeImap((batch) => {
			// Each batch takes longer than the poll spacing.
			vi.setSystemTime(Date.now() + 11_000);
			if (batch === 1) imap.deliver(43);
		});
		const { conn } = connection(imap);

		await conn.maybeRunBackfill();

		expect(ingested()).toEqual([
			`${ALL_MAIL}:3:backfill`,
			'INBOX:43:sync',
			`${ALL_MAIL}:2:backfill`,
			`${ALL_MAIL}:1:backfill`,
		]);
	});

	it('waits out the poll spacing when batches are quick', async () => {
		const imap = fakeImap((batch) => {
			if (batch === 1) imap.deliver(43);
		});
		const { conn, polls } = connection(imap);

		await conn.maybeRunBackfill();

		// Only the unthrottled poll before each folder's ceiling snapshot and the
		// catch-up on the way back to INBOX — none between the quick batches.
		expect(polls).toEqual(['INBOX', 'INBOX', 'INBOX']);
		// The mail is not lost: returning to the INBOX sees UIDNEXT moved.
		expect(ingested().at(-1)).toBe('INBOX:43:sync');
	});
});

describe('returning to the INBOX', () => {
	it('polls when UIDNEXT moved past the cursor while another folder was selected', async () => {
		const imap = fakeImap(() => {});
		const { conn, polls } = connection(imap);
		imap.deliver(43);
		imap.deliver(44);
		await imap.mailboxOpen(ALL_MAIL);

		await conn.resumeInboxIdle();

		expect(polls).toEqual(['INBOX']);
		expect(ingested()).toEqual(['INBOX:43:sync', 'INBOX:44:sync']);
		expect(conn.cursors.get('INBOX')?.lastSeenUid).toBe(44);
	});

	it('does not poll when nothing new arrived', async () => {
		const imap = fakeImap(() => {});
		const { conn, polls } = connection(imap);

		await conn.resumeInboxIdle();

		expect(polls).toEqual([]);
	});

	it('leaves a UIDVALIDITY change to the periodic poll', async () => {
		const imap = fakeImap(() => {});
		const { conn, polls } = connection(imap);
		imap.deliver(43);
		imap.setInboxUidValidity(8);

		await conn.resumeInboxIdle();

		expect(polls).toEqual([]);
	});
});

// IDLE only runs while the connection has nothing else to do. A long-lived
// worker on a busy team inbox ingested new mail only on the five-minute folder
// tick for days; the catch-up timer bounds that whatever IDLE does.
describe('INBOX catch-up timer', () => {
	it('brings in mail that raised no IDLE event', async () => {
		const imap = fakeImap(() => {});
		const { conn, polls } = connection(imap);
		await imap.mailboxOpen(ALL_MAIL);
		imap.deliver(43);

		await conn.catchUpInbox();

		expect(polls).toEqual(['INBOX']);
		expect(ingested()).toEqual(['INBOX:43:sync']);
	});

	it('never stacks a second poll on one still running', async () => {
		const imap = fakeImap(() => {});
		const { conn, polls } = connection(imap);
		imap.deliver(43);

		await Promise.all([conn.catchUpInbox(), conn.catchUpInbox()]);

		expect(polls).toEqual(['INBOX']);
		expect(ingested()).toEqual(['INBOX:43:sync']);
	});
});
