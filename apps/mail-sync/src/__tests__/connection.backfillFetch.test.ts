/**
 * The backfill's bandwidth valve: a range is listed by envelope first, and only
 * the messages the mailbox does NOT already hold have their bodies downloaded.
 *
 * This is not a micro-optimisation. `ingestExternalMessage` dedupes on
 * Message-ID, but only after the worker has pulled the whole message off the
 * provider — so a re-walk pays full bandwidth for mail that is already
 * imported. Behind Gmail's daily IMAP cap that is terminal: a 21 GiB Sent
 * folder spends the day's budget re-fetching the 12 GiB it already has, gets
 * `* BYE [OVERQUOTA]`, and never reaches the mail it is missing — every time it
 * is restarted. So "did it actually skip the download?" is the property under
 * test, not "did it return the right rows".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConnectableAccount, ConvexClient } from '../convex.js';
import type { MailSyncConfig } from '../config.js';
import type { BackfillFolderDeps } from '../backfill.js';

const ingest = vi.hoisted(() => ({
	ingestMessage: vi.fn(async () => ({ messageId: 'msg_1' })),
	isMessageLanded: vi.fn(() => true),
}));
vi.mock('../ingest.js', () => ({
	ingestMessage: ingest.ingestMessage,
	isMessageLanded: ingest.isMessageLanded,
}));

const { AccountConnection } = await import('../connection.js');
const { fn } = await import('../convex.js');

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

interface FakeMessage {
	uid: number;
	messageId: string | null;
	/** Absent ⇒ the server lists it in phase 1 but returns no body in phase 2. */
	source?: Buffer;
}

interface FetchCall {
	range: string;
	wantsEnvelope: boolean;
	wantsSource: boolean;
}

/** ImapFlow stand-in that answers an envelope fetch and a source fetch apart. */
function fakeClient(messages: FakeMessage[]) {
	const calls: FetchCall[] = [];
	return {
		calls,
		getMailboxLock: async () => ({ release: () => {} }),
		async *fetch(range: string, query: Record<string, unknown>) {
			calls.push({
				range,
				wantsEnvelope: query.envelope === true,
				wantsSource: query.source === true,
			});
			if (query.envelope === true) {
				for (const m of messages) {
					yield {
						uid: m.uid,
						flags: new Set<string>(['\\Seen']),
						envelope: m.messageId === null ? {} : { messageId: m.messageId },
					};
				}
				return;
			}
			const wanted = new Set(range.split(',').map((n) => Number(n)));
			for (const m of messages) {
				if (wanted.has(m.uid) && m.source) {
					yield { uid: m.uid, source: m.source, flags: new Set<string>(['\\Seen']) };
				}
			}
		},
	};
}

type ConnectionInternals = {
	client: unknown;
	makeBackfillDeps(uidValidity: number, migrationId: string): BackfillFolderDeps;
};

/** `known` is what `findKnownMessageIds` answers; `throws` makes it fail. */
function newConnection(opts: { known?: string[]; throws?: boolean }) {
	const query = vi.fn(async (ref: unknown) => {
		if (ref === fn.findKnownMessageIds) {
			if (opts.throws) throw new Error('convex unreachable');
			return opts.known ?? [];
		}
		return [];
	});
	const convex = {
		query,
		mutation: vi.fn(async () => ({})),
		action: vi.fn(async () => ({})),
	} as unknown as ConvexClient;
	const conn = new AccountConnection(ACCOUNT, convex, CONFIG) as unknown as ConnectionInternals;
	return { conn, query };
}

const RAW = (uid: number) => Buffer.from(`From: a@example.com\r\nSubject: ${uid}\r\n\r\nbody\r\n`);

beforeEach(() => {
	ingest.ingestMessage.mockClear();
});

describe('backfill fetchBatch — envelope first, bodies only for unknown mail', () => {
	it('does not download a message the mailbox already holds', async () => {
		const client = fakeClient([
			{ uid: 10, messageId: '<already@example.com>', source: RAW(10) },
			{ uid: 11, messageId: '<fresh@example.com>', source: RAW(11) },
		]);
		const { conn, query } = newConnection({ known: ['<already@example.com>'] });
		conn.client = client;

		const out = await conn.makeBackfillDeps(1, 'mig_1').fetchBatch('INBOX', 10, 11);

		// Phase 1 listed the whole range by envelope; phase 2 asked for UID 11 alone.
		expect(client.calls[0]).toMatchObject({ range: '10:11', wantsEnvelope: true });
		expect(client.calls[1]).toMatchObject({ range: '11', wantsSource: true });
		expect(client.calls).toHaveLength(2);

		expect(query).toHaveBeenCalledWith(fn.findKnownMessageIds, {
			accountId: 'acct_1',
			messageIds: ['<already@example.com>', '<fresh@example.com>'],
		});

		const held = out.find((m) => m.uid === 10);
		expect(held).toMatchObject({ alreadyPresent: true, source: null });
		expect(out.find((m) => m.uid === 11)?.source).toEqual(RAW(11));
	});

	it('downloads a message with no Message-ID header — it cannot be recognised', async () => {
		const client = fakeClient([{ uid: 4, messageId: null, source: RAW(4) }]);
		const { conn, query } = newConnection({ known: [] });
		conn.client = client;

		const out = await conn.makeBackfillDeps(1, 'mig_1').fetchBatch('INBOX', 4, 4);

		// Nothing to look up, so the lookup is skipped entirely.
		expect(query).not.toHaveBeenCalled();
		expect(client.calls[1]).toMatchObject({ range: '4', wantsSource: true });
		expect(out[0]?.alreadyPresent).toBeUndefined();
		expect(out[0]?.source).toEqual(RAW(4));
	});

	it('falls back to downloading the whole batch when the lookup fails', async () => {
		const client = fakeClient([
			{ uid: 10, messageId: '<a@example.com>', source: RAW(10) },
			{ uid: 11, messageId: '<b@example.com>', source: RAW(11) },
		]);
		const { conn } = newConnection({ throws: true });
		conn.client = client;

		const out = await conn.makeBackfillDeps(1, 'mig_1').fetchBatch('INBOX', 10, 11);

		expect(client.calls[1]).toMatchObject({ range: '10,11', wantsSource: true });
		expect(out.every((m) => m.alreadyPresent === undefined)).toBe(true);
		expect(out.every((m) => m.source !== null)).toBe(true);
	});

	it('keeps a listed message the body fetch never returned, so it still counts', async () => {
		// The "server listed it but returned no source" case the walk charges to
		// the folder's denominator as a failure — it must survive the two phases.
		const client = fakeClient([
			{ uid: 10, messageId: '<gone@example.com>' }, // no source
			{ uid: 11, messageId: '<here@example.com>', source: RAW(11) },
		]);
		const { conn } = newConnection({ known: [] });
		conn.client = client;

		const out = await conn.makeBackfillDeps(1, 'mig_1').fetchBatch('INBOX', 10, 11);

		expect(out).toHaveLength(2);
		expect(out.find((m) => m.uid === 10)).toMatchObject({ source: null });
		expect(out.find((m) => m.uid === 10)?.alreadyPresent).toBeUndefined();
	});

	it('chunks the body fetch so one batch cannot overrun the IMAP line length', async () => {
		const many = Array.from({ length: 120 }, (_, i) => ({
			uid: i + 1,
			messageId: `<m${i + 1}@example.com>`,
			source: RAW(i + 1),
		}));
		const client = fakeClient(many);
		const { conn } = newConnection({ known: [] });
		conn.client = client;

		await conn.makeBackfillDeps(1, 'mig_1').fetchBatch('INBOX', 1, 120);

		const sourceCalls = client.calls.filter((c) => c.wantsSource);
		expect(sourceCalls).toHaveLength(3); // 50 + 50 + 20
		expect(sourceCalls.every((c) => c.range.split(',').length <= 50)).toBe(true);
	});
});
