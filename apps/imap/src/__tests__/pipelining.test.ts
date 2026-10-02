/**
 * Commands a client pipelines in one segment, through the real pump.
 *
 * RFC 3501 §5.5 lets a client send its next command before the previous one
 * has completed, and requires the server to run them in order whenever the
 * result could depend on it. Only `concurrent` commands (FETCH without an
 * implicit \Seen, NOOP, STATUS, ...) overlap; any other command waits for
 * every running one, and every later one waits for it. So a FETCH sent right
 * after a SELECT reads the folder the SELECT opened, and an EXPUNGE sent right
 * after a STORE sees its flag.
 *
 * Also covered here: the only line IDLE accepts is DONE (RFC 2177), and
 * nothing a client sends after LOGOUT is dispatched.
 *
 * Every Convex read and write resolves a few milliseconds later (fake
 * timers), so a command dispatched too early overtakes the one before it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { EventEmitter } from 'events';
import type { Socket } from 'net';
import { ImapConnection } from '../connection.js';
import type { ImapConfig } from '../config.js';
import type { ConvexClient } from '../convex.js';
import { AuthRateLimiter } from '../rateLimit.js';

// convex/server declares this type but does not export it.
type AnyFunctionReference = Parameters<typeof getFunctionName>[0];

vi.mock('../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** `end()` only half-closes, like a real socket; `close` never fires here. */
class MockSocket extends EventEmitter {
	readonly written: string[] = [];
	ended = false;
	paused = false;

	write(data: string): boolean {
		this.written.push(data);
		return true;
	}

	end(): void {
		this.ended = true;
	}

	pause(): this {
		this.paused = true;
		return this;
	}

	resume(): this {
		this.paused = false;
		return this;
	}

	receive(data: string): void {
		this.emit('data', data);
	}

	lines(): string[] {
		return this.written.join('').split('\r\n').filter(Boolean);
	}
}

const config: ImapConfig = {
	port: 993,
	listenAddress: '0.0.0.0',
	tls: null,
	greetingHost: 'imap.test',
	convexUrl: 'https://example.convex.cloud',
	convexAdminKey: 'test-admin-key',
	redisUrl: null,
	maxConnectionsPerIp: 20,
	maxClients: 500,
	idleTimeoutMs: 30 * 60 * 1000,
	authRateLimit: { failuresPerWindow: 5, windowMs: 60_000, tarpitMs: 900_000 },
};

/** Every backend call answers after this many (fake) milliseconds. */
const LATENCY_MS = 3;

interface Message {
	readonly uid: number;
	deleted: boolean;
	modseq: number;
}

interface Folder {
	readonly _id: string;
	readonly name: string;
	readonly role?: string;
	readonly uidValidity: number;
	messages: Message[];
	modseq: number;
}

function messageId(folder: Folder, uid: number): string {
	return `${folder._id}:${uid}`;
}

/**
 * A two-folder mailbox behind a Convex stub that implements just enough of
 * each function for LOGIN, SELECT, FETCH (flags), STORE and EXPUNGE.
 */
function makeBackend() {
	const folders: Folder[] = [
		{
			_id: 'f-inbox',
			name: 'INBOX',
			role: 'inbox',
			uidValidity: 1,
			messages: [1, 2].map((uid) => ({ uid, deleted: false, modseq: 1 })),
			modseq: 1,
		},
		{
			_id: 'f-archive',
			name: 'Archive',
			role: 'archive',
			uidValidity: 2,
			messages: [5, 6, 7].map((uid) => ({ uid, deleted: false, modseq: 1 })),
			modseq: 1,
		},
	];
	const byId = (id: unknown): Folder => folders.find((f) => f._id === id)!;
	const counters = (f: Folder) => ({
		_id: f._id,
		name: f.name,
		role: f.role,
		uidValidity: f.uidValidity,
		uidNext: Math.max(0, ...f.messages.map((m) => m.uid)) + 1,
		highestModseq: f.modseq,
		totalCount: f.messages.length,
		unseenCount: 0,
	});
	const inWindow = (m: Message, args: Record<string, unknown>): boolean =>
		m.uid >= (args['uidLow'] as number) && m.uid <= (args['uidHigh'] as number);
	const envelope = (m: Message) => ({
		_id: `m${m.uid}`,
		uid: m.uid,
		modseq: m.modseq,
		rawSize: 10,
		rfc822MessageId: `<${m.uid}@example.com>`,
		fromAddress: 'sender@example.com',
		toAddresses: [],
		ccAddresses: [],
		bccAddresses: [],
		subject: 's',
		internalDate: 0,
		flagSeen: false,
		flagFlagged: false,
		flagAnswered: false,
		flagDraft: false,
		flagDeleted: m.deleted,
		customFlags: [],
	});

	/** Functions a test wants to answer slowly, e.g. to keep a FETCH running. */
	const slow = new Set<string>();
	const answer = <T>(compute: () => T, name = ''): Promise<T> =>
		new Promise((resolve) =>
			setTimeout(() => resolve(compute()), slow.has(name) ? 10 * LATENCY_MS : LATENCY_MS)
		);

	const query = vi.fn((ref: AnyFunctionReference, args: Record<string, unknown>) =>
		answer(() => {
			switch (getFunctionName(ref)) {
				case 'mail/imap/session:listFolders':
					return folders.map(counters);
				case 'mail/imap/session:selectFolder':
					return { folder: counters(byId(args['folderId'])) };
				case 'mail/imap/session:peekFolderModseq':
					return counters(byId(args['folderId']));
				case 'mail/imap/fetch:listFolderUidsPage':
					return {
						uids: byId(args['folderId'])
							.messages.map((m) => m.uid)
							.filter((uid) => uid > ((args['afterUid'] as number | undefined) ?? 0)),
						nextUid: null,
					};
				case 'mail/imap/fetch:fetchEnvelopes':
					return {
						rows: byId(args['folderId'])
							.messages.filter((m) => inWindow(m, args))
							.map(envelope),
						nextUid: null,
					};
				case 'mail/imap/fetch:resolveMessageIdsByUid': {
					const folder = byId(args['folderId']);
					return {
						rows: folder.messages
							.filter((m) => inWindow(m, args))
							.map((m) => ({ _id: messageId(folder, m.uid), uid: m.uid, modseq: m.modseq })),
						nextUid: null,
					};
				}
				default:
					return null;
			}
		}, getFunctionName(ref))
	);

	const mutation = vi.fn((ref: AnyFunctionReference, args: Record<string, unknown>) =>
		answer(() => {
			switch (getFunctionName(ref)) {
				case 'mail/imap/flags:storeFlags': {
					const ids = args['messageIds'] as string[];
					const updated = [];
					for (const folder of folders) {
						for (const m of folder.messages) {
							if (!ids.includes(messageId(folder, m.uid))) continue;
							if ((args['flags'] as string[]).includes('\\Deleted'))
								m.deleted = args['mode'] !== 'remove';
							folder.modseq += 1;
							m.modseq = folder.modseq;
							updated.push({
								messageId: messageId(folder, m.uid),
								uid: m.uid,
								modseq: m.modseq,
								flags: m.deleted ? ['\\Deleted'] : [],
							});
						}
					}
					return { updated, unchanged: [] };
				}
				case 'mail/imap/move:expungeFolder': {
					const folder = byId(args['folderId']);
					const sequenceNumbers: number[] = [];
					const uids: number[] = [];
					for (const [i, m] of folder.messages.entries()) {
						if (m.deleted) {
							sequenceNumbers.push(i + 1);
							uids.push(m.uid);
						}
					}
					folder.messages = folder.messages.filter((m) => !m.deleted);
					folder.modseq += 1;
					return { sequenceNumbers, uids, modseq: folder.modseq, done: true };
				}
				default:
					return undefined;
			}
		})
	);

	const action = vi.fn(() =>
		answer(() => ({ mailboxId: 'mb1', appPasswordId: 'ap1', userId: 'u1', organizationId: 'o1' }))
	);

	const calls = (name: string): Array<Record<string, unknown>> =>
		[...query.mock.calls, ...mutation.mock.calls]
			.filter(([ref]) => getFunctionName(ref as AnyFunctionReference) === name)
			.map(([, args]) => args as Record<string, unknown>);

	return { folders, convex: { query, mutation, action }, calls, slow };
}

function connect() {
	const socket = new MockSocket();
	const backend = makeBackend();
	const connection = new ImapConnection(
		socket as unknown as Socket,
		config,
		backend.convex as unknown as ConvexClient,
		new AuthRateLimiter(null, config.authRateLimit),
		'10.0.0.1'
	);
	return { connection, socket, ...backend };
}

/** Send one segment (one or more CRLF-terminated lines) and let it all run. */
async function sendSegment(socket: MockSocket, ...lines: string[]): Promise<void> {
	socket.receive(lines.map((l) => `${l}\r\n`).join(''));
	await vi.advanceTimersByTimeAsync(100);
}

/** The lines written since `mark` (a previous `socket.lines().length`). */
function since(socket: MockSocket, mark: number): string[] {
	return socket.lines().slice(mark);
}

async function loggedIn() {
	const conn = connect();
	await sendSegment(conn.socket, 'a0 LOGIN "alice@example.com" "pw"');
	expect(conn.socket.lines().at(-1)).toBe('a0 OK LOGIN completed');
	return conn;
}

describe('pipelined commands run in order (RFC 3501 §5.5)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('SELECT + FETCH with no folder selected: FETCH reads the folder SELECT opened', async () => {
		const { socket } = await loggedIn();
		const mark = socket.lines().length;

		await sendSegment(socket, 'a1 SELECT Archive', 'a2 FETCH 1:* (UID)');

		const out = since(socket, mark);
		expect(out).not.toContain('a2 BAD No mailbox selected');
		expect(out.filter((l) => / FETCH \(/.test(l))).toEqual([
			'* 1 FETCH (UID 5)',
			'* 2 FETCH (UID 6)',
			'* 3 FETCH (UID 7)',
		]);
		// Tagged completions come back in the order the commands were sent.
		expect(out.filter((l) => /^a\d /.test(l))).toEqual([
			'a1 OK [READ-WRITE] SELECT completed',
			'a2 OK FETCH completed',
		]);
		expect(out.indexOf('a1 OK [READ-WRITE] SELECT completed')).toBeLessThan(
			out.indexOf('* 1 FETCH (UID 5)')
		);
	});

	it('SELECT + FETCH with INBOX already selected: FETCH reads Archive, not INBOX', async () => {
		const { socket } = await loggedIn();
		await sendSegment(socket, 'a1 SELECT INBOX');
		const mark = socket.lines().length;

		await sendSegment(socket, 'a2 SELECT Archive', 'a3 FETCH 1:* (UID)');

		const out = since(socket, mark);
		expect(out.filter((l) => / FETCH \(/.test(l))).toEqual([
			'* 1 FETCH (UID 5)',
			'* 2 FETCH (UID 6)',
			'* 3 FETCH (UID 7)',
		]);
		expect(out.filter((l) => /^a\d /.test(l))).toEqual([
			'a2 OK [READ-WRITE] SELECT completed',
			'a3 OK FETCH completed',
		]);
	});

	it('SELECT + STORE \\Deleted + EXPUNGE with INBOX selected: only Archive is expunged', async () => {
		const { socket, folders, calls } = await loggedIn();
		await sendSegment(socket, 'a1 SELECT INBOX');

		await sendSegment(
			socket,
			'a2 SELECT Archive',
			'a3 STORE 1:* +FLAGS.SILENT (\\Deleted)',
			'a4 EXPUNGE'
		);

		const [inbox, archive] = folders;
		expect(inbox!.messages.map((m) => m.uid)).toEqual([1, 2]);
		expect(archive!.messages).toEqual([]);
		expect(calls('mail/imap/move:expungeFolder').map((a) => a['folderId'])).toEqual(['f-archive']);
		expect(socket.lines().slice(-4)).toEqual([
			'* 3 EXPUNGE',
			'* 2 EXPUNGE',
			'* 1 EXPUNGE',
			'a4 OK EXPUNGE completed',
		]);
	});

	it('STORE \\Deleted + EXPUNGE: EXPUNGE removes the message STORE just flagged', async () => {
		const { socket, folders } = await loggedIn();
		await sendSegment(socket, 'a1 SELECT INBOX');
		const mark = socket.lines().length;

		await sendSegment(socket, 'a2 STORE 1 +FLAGS (\\Deleted)', 'a3 EXPUNGE');

		expect(folders[0]!.messages.map((m) => m.uid)).toEqual([2]);
		expect(since(socket, mark)).toEqual([
			'* 1 FETCH (UID 1 MODSEQ (2) FLAGS (\\Deleted))',
			'a2 OK STORE completed',
			'* 1 EXPUNGE',
			'a3 OK EXPUNGE completed',
		]);
	});

	it('LOGIN + SELECT: SELECT runs once LOGIN has authenticated', async () => {
		const { socket } = connect();
		const mark = socket.lines().length;

		await sendSegment(socket, 'a0 LOGIN "alice@example.com" "pw"', 'a1 SELECT INBOX');

		const out = since(socket, mark);
		expect(out).not.toContain('a1 BAD Not authenticated');
		expect(out.filter((l) => /^a\d /.test(l))).toEqual([
			'a0 OK LOGIN completed',
			'a1 OK [READ-WRITE] SELECT completed',
		]);
	});

	it('AUTHENTICATE + response + SELECT: the SELECT is not taken as a second SASL response', async () => {
		const { socket, convex } = connect();
		const response = Buffer.from('\0alice@example.com\0pw', 'utf-8').toString('base64');
		const mark = socket.lines().length;

		await sendSegment(socket, 'a0 AUTHENTICATE PLAIN', response, 'a1 SELECT INBOX');

		expect(convex.action).toHaveBeenCalledTimes(1);
		const out = since(socket, mark);
		expect(out.filter((l) => /^a\d /.test(l))).toEqual([
			'a0 OK AUTHENTICATE completed',
			'a1 OK [READ-WRITE] SELECT completed',
		]);
	});

	it('SELECT behind a running FETCH waits for it, so the FETCH answers for the old folder first', async () => {
		const { socket, slow } = await loggedIn();
		await sendSegment(socket, 'a1 SELECT INBOX');
		slow.add('mail/imap/fetch:fetchEnvelopes');
		const mark = socket.lines().length;

		await sendSegment(socket, 'a2 FETCH 1:* (UID)', 'a3 SELECT Archive');

		const out = since(socket, mark);
		expect(out.slice(0, 3)).toEqual([
			'* 1 FETCH (UID 1)',
			'* 2 FETCH (UID 2)',
			'a2 OK FETCH completed',
		]);
		expect(out.at(-1)).toBe('a3 OK [READ-WRITE] SELECT completed');
	});

	it('read-only commands pipelined behind a FETCH start at once', async () => {
		const { socket, calls } = await loggedIn();
		await sendSegment(socket, 'a1 SELECT INBOX');
		const fetches = calls('mail/imap/fetch:fetchEnvelopes').length;

		socket.receive('a2 FETCH 1 (UID)\r\na3 FETCH 2 (UID)\r\na4 STATUS Archive (MESSAGES)\r\n');
		expect(socket.paused).toBe(false);
		// Both FETCHes read before either backend call (LATENCY_MS) answers.
		await vi.advanceTimersByTimeAsync(1);
		expect(calls('mail/imap/fetch:fetchEnvelopes').length - fetches).toBe(2);
		await vi.advanceTimersByTimeAsync(100);

		// They ran side by side, so they may complete in any order.
		expect(
			socket
				.lines()
				.filter((l) => /^a[234] /.test(l))
				.sort()
		).toEqual(['a2 OK FETCH completed', 'a3 OK FETCH completed', 'a4 OK STATUS completed']);
	});

	it('stops reading the socket while a line is held, and resumes once it is dispatched', async () => {
		const { socket } = await loggedIn();

		socket.receive('a1 SELECT Archive\r\na2 NOOP\r\n');
		expect(socket.paused).toBe(true);
		expect(socket.lines()).not.toContain('a2 OK NOOP completed');

		await vi.advanceTimersByTimeAsync(100);
		expect(socket.paused).toBe(false);
		expect(socket.lines().slice(-2)).toEqual([
			'a1 OK [READ-WRITE] SELECT completed',
			'a2 OK NOOP completed',
		]);
	});
});

describe('IDLE accepts only DONE (RFC 2177)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	async function idling() {
		const conn = await loggedIn();
		await sendSegment(conn.socket, 'a1 SELECT INBOX');
		await sendSegment(conn.socket, 'a2 IDLE');
		expect(conn.socket.lines().at(-1)).toBe('+ idling');
		return conn;
	}

	it('a command sent without DONE gets BAD; IDLE keeps running on the same folder', async () => {
		const { socket, calls } = await idling();
		const selectsBefore = calls('mail/imap/session:selectFolder').length;

		await sendSegment(socket, 'a3 SELECT Archive');

		expect(socket.lines().at(-1)).toBe('a3 BAD Expected DONE');
		expect(calls('mail/imap/session:selectFolder').length).toBe(selectsBefore);

		// The IDLE poll still watches INBOX.
		await vi.advanceTimersByTimeAsync(5_000);
		const peeks = calls('mail/imap/session:peekFolderModseq');
		expect(peeks.length).toBeGreaterThan(0);
		expect(peeks.every((a) => a['folderId'] === 'f-inbox')).toBe(true);

		// DONE ends it, and the connection is still on INBOX.
		await sendSegment(socket, 'DONE');
		expect(socket.lines().at(-1)).toBe('a2 OK IDLE terminated');
		const mark = socket.lines().length;
		await sendSegment(socket, 'a4 FETCH 1:* (UID)');
		expect(since(socket, mark)).toEqual([
			'* 1 FETCH (UID 1)',
			'* 2 FETCH (UID 2)',
			'a4 OK FETCH completed',
		]);
	});

	it('a second IDLE without DONE gets BAD and starts no second poll loop', async () => {
		const { socket, calls } = await idling();

		await sendSegment(socket, 'a3 IDLE');
		expect(socket.lines().at(-1)).toBe('a3 BAD Expected DONE');
		expect(socket.lines().filter((l) => l === '+ idling')).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(5_000);
		expect(calls('mail/imap/session:peekFolderModseq')).toHaveLength(1);
	});

	it('an untagged line gets an untagged BAD, and a blank line is ignored', async () => {
		const { socket } = await idling();

		await sendSegment(socket, 'NONSENSE');
		expect(socket.lines().at(-1)).toBe('* BAD Expected DONE');
		const mark = socket.lines().length;
		await sendSegment(socket, '');
		expect(since(socket, mark)).toEqual([]);
	});

	it('DONE + a command in one segment: the command runs after IDLE has ended', async () => {
		const { socket } = await idling();
		const mark = socket.lines().length;

		await sendSegment(socket, 'DONE', 'a3 SELECT Archive', 'a4 FETCH 1 (UID)');

		const out = since(socket, mark);
		expect(out.filter((l) => /^a\d /.test(l))).toEqual([
			'a2 OK IDLE terminated',
			'a3 OK [READ-WRITE] SELECT completed',
			'a4 OK FETCH completed',
		]);
		expect(out).toContain('* 1 FETCH (UID 5)');
	});
});

describe('nothing is dispatched after LOGOUT', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('lines behind LOGOUT in the same segment are dropped, and no IDLE poll starts', async () => {
		const { socket, convex } = await loggedIn();
		await sendSegment(socket, 'a1 SELECT INBOX');
		const reads = convex.query.mock.calls.length;
		const mark = socket.lines().length;

		await sendSegment(socket, 'a2 LOGOUT', 'a3 IDLE', 'a4 FETCH 1:* (UID)');
		await vi.advanceTimersByTimeAsync(60_000);

		expect(since(socket, mark)).toEqual(['* BYE Owlat IMAP signing off', 'a2 OK LOGOUT completed']);
		expect(socket.ended).toBe(true);
		expect(convex.query.mock.calls.length).toBe(reads);
	});

	it('data the half-closed socket receives after LOGOUT is ignored', async () => {
		const { socket, convex } = await loggedIn();
		await sendSegment(socket, 'a1 SELECT INBOX');
		await sendSegment(socket, 'a2 LOGOUT');
		const reads = convex.query.mock.calls.length;
		const mark = socket.lines().length;

		await sendSegment(socket, 'a3 IDLE');
		await sendSegment(socket, 'a4 NOOP');
		await vi.advanceTimersByTimeAsync(60_000);

		expect(since(socket, mark)).toEqual([]);
		expect(convex.query.mock.calls.length).toBe(reads);
	});

	it('LOGOUT pipelined behind a running command waits for it', async () => {
		const { socket } = await loggedIn();
		const mark = socket.lines().length;

		await sendSegment(socket, 'a1 SELECT INBOX', 'a2 LOGOUT');

		expect(since(socket, mark).filter((l) => /^a\d /.test(l) || l.startsWith('* BYE'))).toEqual([
			'a1 OK [READ-WRITE] SELECT completed',
			'* BYE Owlat IMAP signing off',
			'a2 OK LOGOUT completed',
		]);
		// The socket was paused behind SELECT; it must flow again to see the
		// client's FIN and close.
		expect(socket.paused).toBe(false);
	});
});
