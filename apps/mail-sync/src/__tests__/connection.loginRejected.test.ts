/**
 * What the connect loop does when the provider refuses the login.
 *
 * ImapFlow reports every NO to LOGIN as `authenticationFailed` with the message
 * 'Command failed'. The loop used to park the account `auth_error` on the first
 * one, and `auth_error` is not connectable: a shared team inbox whose provider
 * answered one reconnect with a temporary refusal stopped receiving mail until
 * someone re-entered a password that still worked. These tests lock in that a
 * rejection is retried until it has persisted, that a refusal the server calls
 * temporary never parks the account, and that a failed attempt cannot start a
 * second reconnect loop.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConnectableAccount, ConvexClient } from '../convex.js';
import type { MailSyncConfig } from '../config.js';

vi.mock('../logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const imap = vi.hoisted(() => ({
	clients: [] as Array<{ closeCalls: number }>,
	connectError: null as (() => Error) | null,
}));

// ImapFlow's shape on a refused login: connect() rejects, and close() emits
// 'close' exactly once.
vi.mock('imapflow', async () => {
	const { EventEmitter: Emitter } = await import('node:events');
	return {
		ImapFlow: class extends Emitter {
			closeCalls = 0;
			private isClosed = false;
			constructor() {
				super();
				imap.clients.push(this);
			}
			async connect(): Promise<void> {
				const err = imap.connectError!();
				// A socket error closes the client itself; a refused LOGIN leaves the
				// socket open for the caller to deal with.
				if (!('authenticationFailed' in err)) setImmediate(() => this.close());
				throw err;
			}
			close(): void {
				this.closeCalls += 1;
				if (this.isClosed) return;
				this.isClosed = true;
				this.emit('close');
			}
		},
	};
});

import { AccountConnection } from '../connection.js';
import { AUTH_REJECTION_GRACE_MS } from '../loginFailure.js';

const ACCOUNT: ConnectableAccount = {
	accountId: 'acct_1',
	mailboxId: 'mbx_1',
	imapHost: 'imap.gmail.com',
	imapPort: 993,
	isImapSecure: true,
	imapUsername: 'support@example.com',
	status: 'connected',
};

const CONFIG = { folderPollIntervalMs: 300_000, inboxPollIntervalMs: 60_000 } as MailSyncConfig;

/** ImapFlow's error for a tagged NO to LOGIN. */
function loginRefused(code: string, text: string): () => Error {
	return () =>
		Object.assign(new Error('Command failed'), {
			authenticationFailed: true,
			responseStatus: 'NO',
			serverResponseCode: code,
			responseText: text,
		});
}

function newConnection() {
	const mutation = vi.fn(async (_ref: unknown, _args: unknown) => ({}));
	const convex = {
		query: vi.fn(async () => []),
		mutation,
		action: vi.fn(async () => ({
			kind: 'credentials',
			credentials: {
				imapHost: ACCOUNT.imapHost,
				imapPort: ACCOUNT.imapPort,
				isImapSecure: true,
				imapUsername: ACCOUNT.imapUsername,
				imapPassword: 'app-password',
			},
		})),
	} as unknown as ConvexClient;
	const statuses = () =>
		mutation.mock.calls.map(([, args]) => args as { status: string; lastError?: string });
	return { conn: new AccountConnection(ACCOUNT, convex, CONFIG), statuses };
}

beforeEach(() => {
	vi.useFakeTimers();
	imap.clients.length = 0;
});

afterEach(() => {
	vi.useRealTimers();
});

describe('a login the provider refuses', () => {
	it('is retried rather than parking the account on the first refusal', async () => {
		imap.connectError = loginRefused('AUTHENTICATIONFAILED', 'Invalid credentials (Failure)');
		const { conn, statuses } = newConnection();

		void conn.start();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(imap.clients.length).toBeGreaterThan(1);
		expect(statuses().map((s) => s.status)).not.toContain('auth_error');
		expect(statuses()[0]?.status).toBe('error');
		expect(conn.isStopped).toBe(false);

		await conn.stop();
	});

	it('parks the account once the refusal has lasted the grace period', async () => {
		imap.connectError = loginRefused('AUTHENTICATIONFAILED', 'Invalid credentials (Failure)');
		const { conn, statuses } = newConnection();

		void conn.start();
		await vi.advanceTimersByTimeAsync(AUTH_REJECTION_GRACE_MS + 6 * 60_000);

		expect(statuses().at(-1)?.status).toBe('auth_error');
		expect(conn.isStopped).toBe(true);
		// Parked for good: no further attempts.
		const attempts = imap.clients.length;
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(imap.clients.length).toBe(attempts);
	});

	it('never parks the account on a refusal the server calls temporary', async () => {
		imap.connectError = loginRefused('UNAVAILABLE', 'Temporary System Problem. Try again later.');
		const { conn, statuses } = newConnection();

		void conn.start();
		await vi.advanceTimersByTimeAsync(2 * AUTH_REJECTION_GRACE_MS);

		expect(statuses().map((s) => s.status)).not.toContain('auth_error');
		expect(conn.isStopped).toBe(false);

		await conn.stop();
	});

	it("records the server's reply, not just ImapFlow's 'Command failed'", async () => {
		imap.connectError = loginRefused('ALERT', 'Too many simultaneous connections. (Failure)');
		const { conn, statuses } = newConnection();

		void conn.start();
		await vi.advanceTimersByTimeAsync(0);

		expect(statuses()[0]?.lastError).toBe(
			'Command failed: [ALERT] Too many simultaneous connections. (Failure)'
		);

		await conn.stop();
	});

	it('closes the client whose login was refused', async () => {
		imap.connectError = loginRefused('UNAVAILABLE', 'Temporary System Problem.');
		const { conn } = newConnection();

		void conn.start();
		await vi.advanceTimersByTimeAsync(0);

		expect(imap.clients).toHaveLength(1);
		expect(imap.clients[0]!.closeCalls).toBe(1);

		await conn.stop();
	});
});

describe('a connect that fails', () => {
	it('starts no second reconnect loop when the failed client closes', async () => {
		imap.connectError = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
		const { conn } = newConnection();

		void conn.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(imap.clients).toHaveLength(1);

		// The first backoff is 5-6 s: one loop makes one more attempt in that
		// window. A close that started a loop of its own would double that, and
		// double it again on every failure after.
		await vi.advanceTimersByTimeAsync(6_500);
		expect(imap.clients).toHaveLength(2);

		await conn.stop();
	});
});
