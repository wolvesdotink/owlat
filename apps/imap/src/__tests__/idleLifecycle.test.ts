/**
 * IDLE through the real pump: a poll still waiting on Convex when the IDLE
 * session ends must not write anything afterwards.
 *
 * The client cannot tell a late unsolicited response from a current one. Once
 * `DONE` is acknowledged it may SELECT another mailbox, and a `* 1 EXPUNGE`
 * computed for the old one is then applied to the new one's sequence numbers.
 * The same poll outliving LOGOUT or a closed socket is work nobody receives.
 *
 * idle.test.ts covers the same fence at the module level (timeout, paging,
 * overlapping ticks); this file covers it through the pump: DONE followed by
 * another command, DONE followed by LOGOUT, and the socket closing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName, type AnyFunctionReference } from 'convex/server';
import { EventEmitter } from 'events';
import type { Socket } from 'net';
import { ImapConnection } from '../connection.js';
import type { ImapConfig } from '../config.js';
import type { ConvexClient } from '../convex.js';
import { AuthRateLimiter } from '../rateLimit.js';

vi.mock('../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * Like a real socket, `end()` only half-closes: `close` arrives later, when
 * the peer has hung up too (`hangUp`). That gap is where LOGOUT used to leave
 * an IDLE poll running.
 */
class MockSocket extends EventEmitter {
	readonly written: string[] = [];

	setEncoding(_encoding: string): void {}

	write(data: string): boolean {
		this.written.push(data);
		return true;
	}

	end(): void {}

	hangUp(): void {
		this.emit('close');
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

const INBOX = {
	_id: 'f1',
	name: 'INBOX',
	role: 'inbox',
	uidValidity: 1,
	uidNext: 3,
	highestModseq: 7,
	totalCount: 2,
	unseenCount: 0,
};
const SENT = {
	_id: 'f2',
	name: 'Sent',
	role: 'sent',
	uidValidity: 2,
	uidNext: 10,
	highestModseq: 3,
	totalCount: 9,
	unseenCount: 0,
};

interface Fixture {
	connection: ImapConnection;
	socket: MockSocket;
	query: ReturnType<typeof vi.fn>;
	/** Release the poll's held `peekFolderModseq` read. */
	releasePeek: () => void;
	/** How often IDLE has read the INBOX counters. */
	peekCalls: () => number;
}

/**
 * Log in, SELECT INBOX (UIDs 1,2) and enter IDLE. The first poll's counter
 * read is held open; once released it reports that UID 1 was expunged, which
 * the poll would announce as `* 1 EXPUNGE`.
 */
async function idleWithHeldPoll(): Promise<Fixture> {
	const socket = new MockSocket();
	let releasePeek!: () => void;
	const held = new Promise<void>((resolve) => {
		releasePeek = resolve;
	});
	let inboxUids = [1, 2];
	const query = vi.fn((fnRef: AnyFunctionReference, args: Record<string, unknown>) => {
		switch (getFunctionName(fnRef)) {
			case 'mail/imap/session:listFolders':
				return Promise.resolve([INBOX, SENT]);
			case 'mail/imap/session:selectFolder':
				return Promise.resolve({ folder: args.folderId === 'f1' ? INBOX : SENT });
			case 'mail/imap/fetch:listFolderUidsPage':
				return Promise.resolve({ uids: args.folderId === 'f1' ? inboxUids : [], nextUid: null });
			case 'mail/imap/fetch:fetchChangedEnvelopes':
				return Promise.resolve({ page: [], isDone: true, continueCursor: null });
			case 'mail/imap/session:peekFolderModseq':
				return held.then(() => {
					inboxUids = [2];
					return { highestModseq: 8, uidNext: 3, totalCount: 1, unseenCount: 0 };
				});
			default:
				return Promise.resolve(null);
		}
	});
	const convex = {
		query,
		mutation: vi.fn().mockResolvedValue(undefined),
		action: vi.fn().mockResolvedValue({
			mailboxId: 'mb1',
			appPasswordId: 'ap1',
			userId: 'u1',
			organizationId: 'org1',
		}),
	};
	const connection = new ImapConnection(
		socket as unknown as Socket,
		config,
		convex as unknown as ConvexClient,
		new AuthRateLimiter(null, config.authRateLimit),
		'10.0.0.1'
	);

	await send(socket, 'a0 LOGIN "alice@test" "good"');
	await send(socket, 'a1 SELECT INBOX');
	expect(socket.lines().at(-1)).toBe('a1 OK [READ-WRITE] SELECT completed');
	await send(socket, 'a2 IDLE');
	expect(socket.lines().at(-1)).toBe('+ idling');

	// First poll tick: the counter read is now in flight and held.
	await vi.advanceTimersByTimeAsync(5_000);
	const peekCalls = (): number =>
		query.mock.calls.filter(
			([ref]) =>
				getFunctionName(ref as AnyFunctionReference) === 'mail/imap/session:peekFolderModseq'
		).length;
	expect(peekCalls()).toBe(1);

	return { connection, socket, query, releasePeek, peekCalls };
}

/** Feed one client line and let the command's Convex reads settle. */
async function send(socket: MockSocket, line: string): Promise<void> {
	socket.receive(`${line}\r\n`);
	await vi.advanceTimersByTimeAsync(0);
}

/** Release the held read and give the abandoned poll every chance to write. */
async function releaseAndSettle(fixture: Fixture): Promise<void> {
	fixture.releasePeek();
	await vi.advanceTimersByTimeAsync(30_000);
}

describe('IDLE — a poll in flight when the pump ends the session writes nothing', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('DONE, then SELECT of another mailbox: the old mailbox’s late EXPUNGE is dropped', async () => {
		const fixture = await idleWithHeldPoll();
		const { socket } = fixture;

		await send(socket, 'DONE');
		expect(socket.lines().at(-1)).toBe('a2 OK IDLE terminated');
		await send(socket, 'a3 SELECT Sent');
		expect(socket.lines().at(-1)).toBe('a3 OK [READ-WRITE] SELECT completed');
		const afterSelect = socket.lines().length;

		await releaseAndSettle(fixture);

		// Nothing may follow the SELECT: the client now numbers messages in Sent.
		expect(socket.lines().slice(afterSelect)).toEqual([]);
		expect(socket.lines()).not.toContain('* 1 EXPUNGE');
		expect(fixture.peekCalls()).toBe(1);
	});

	it('DONE + LOGOUT: the poll stays silent before the socket finishes closing', async () => {
		const fixture = await idleWithHeldPoll();
		const { socket } = fixture;

		// RFC 2177: LOGOUT without DONE is refused, and the IDLE goes on.
		await send(socket, 'a3 LOGOUT');
		expect(socket.lines().at(-1)).toBe('a3 BAD Expected DONE');

		await send(socket, 'DONE\r\na4 LOGOUT');
		expect(socket.lines().slice(-3)).toEqual([
			'a2 OK IDLE terminated',
			'* BYE Owlat IMAP signing off',
			'a4 OK LOGOUT completed',
		]);
		const afterLogout = socket.lines().length;
		const readsAtLogout = fixture.query.mock.calls.length;

		// The peer has not hung up yet, so `close` has not fired.
		await releaseAndSettle(fixture);

		expect(socket.lines().slice(afterLogout)).toEqual([]);
		expect(fixture.query.mock.calls.length).toBe(readsAtLogout);
		socket.hangUp();
	});

	it('socket close mid-poll: the late read neither writes nor reads further', async () => {
		const fixture = await idleWithHeldPoll();
		const { socket, query } = fixture;

		socket.hangUp();
		const afterClose = socket.lines().length;
		const readsAtClose = query.mock.calls.length;

		await releaseAndSettle(fixture);

		expect(socket.lines().slice(afterClose)).toEqual([]);
		// The poll would otherwise go on to walk the folder's UID list.
		expect(query.mock.calls.length).toBe(readsAtClose);
	});
});
