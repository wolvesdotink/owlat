/**
 * A disconnected account is terminal for its connection.
 *
 * Disconnecting drops the account's stored password, so the very next
 * `getCredentialsForWorker` for a connection still in flight comes back `null`.
 * That is not a transient fault and must not be treated as one: the old
 * behaviour reported `error` and slept out an exponential backoff, and `error`
 * is a CONNECTABLE status — so the reconcile loop kept the connection alive, the
 * status write raced the teardown, and the account could end up wedged as
 * live-but-passwordless, which nothing in the product could then repair.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConnectableAccount, ConvexClient } from '../convex.js';
import type { MailSyncConfig } from '../config.js';

vi.mock('../logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// A connect attempt must never be reached in these tests; if one is, the
// constructor throwing is the loudest possible failure.
vi.mock('imapflow', () => ({
	ImapFlow: class {
		constructor() {
			throw new Error('the connection should never be attempted without credentials');
		}
	},
}));

import { AccountConnection } from '../connection.js';

const CONFIG: MailSyncConfig = {
	port: 3200,
	listenAddress: '0.0.0.0',
	convexUrl: 'https://example.convex.cloud',
	convexAdminKey: 'admin-key',
	apiKey: 'api-key',
	reconcileIntervalMs: 30_000,
	folderPollIntervalMs: 300_000,
};

const ACCOUNT: ConnectableAccount = {
	accountId: 'acc_1',
	mailboxId: 'mbx_1',
	imapHost: 'imap.example.com',
	imapPort: 993,
	isImapSecure: true,
	imapUsername: 'me@example.com',
	status: 'connected',
};

/**
 * Convex stub: the credential action answers with the terminal `disconnected`
 * reason (what the backend returns once the teardown has dropped the envelope),
 * and every mutation is recorded.
 */
function mockConvex() {
	const action = vi.fn(async () => ({ kind: 'unavailable', reason: 'disconnected' }));
	const mutation = vi.fn(async () => undefined);
	const query = vi.fn(async () => []);
	return {
		client: { action, mutation, query } as unknown as ConvexClient,
		action,
		mutation,
	};
}

beforeEach(() => {
	vi.useRealTimers();
});

describe('a connection whose account lost its credentials', () => {
	it('stops instead of backing off, and asks for credentials exactly once', async () => {
		const { client, action } = mockConvex();
		const connection = new AccountConnection(ACCOUNT, client, CONFIG);

		// Resolves rather than hanging: no backoff sleep, no retry loop. A retry
		// would make this exceed the timeout many times over (the first backoff
		// alone is 5s).
		await connection.start();

		expect(action).toHaveBeenCalledTimes(1);
	}, 2000);

	it('writes no status back — the teardown already said what is true', async () => {
		const { client, mutation } = mockConvex();
		const connection = new AccountConnection(ACCOUNT, client, CONFIG);

		await connection.start();

		const statusWrites = mutation.mock.calls.filter(([reference]) =>
			JSON.stringify(reference).includes('setSyncStatus')
		);
		expect(statusWrites).toEqual([]);
	}, 2000);

	it('stays stopped once the manager tears it down', async () => {
		const { client, action } = mockConvex();
		const connection = new AccountConnection(ACCOUNT, client, CONFIG);

		await connection.start();
		await connection.stop();

		expect(action).toHaveBeenCalledTimes(1);
	}, 2000);
});
