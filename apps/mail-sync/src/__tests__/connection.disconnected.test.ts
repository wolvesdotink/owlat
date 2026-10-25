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
import type * as Shared from '@owlat/shared';

vi.mock('../logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The reconnect backoff is the shared `sleep`. Reaching it at all is the
// regression, so it rejects: `start()` then fails at once, rather than
// sleeping out a backoff the test would have to wait for.
const { backoff } = vi.hoisted(() => ({
	backoff: vi.fn(async (ms: number): Promise<void> => {
		throw new Error(`the connect loop backed off for ${ms}ms`);
	}),
}));
vi.mock('@owlat/shared', async (importOriginal) => ({
	...(await importOriginal<typeof Shared>()),
	sleep: backoff,
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
	convexSiteUrl: 'https://example.convex.cloud/http',
	convexAdminKey: 'admin-key',
	apiKey: 'api-key',
	reconcileIntervalMs: 30_000,
	folderPollIntervalMs: 300_000,
	inboxPollIntervalMs: 60_000,
	backfillBatchSize: 200,
	allowedFetchOrigins: ['https://example.convex.cloud'],
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
	const mutation = vi.fn(async (_ref: unknown, _args: unknown) => undefined);
	const query = vi.fn(async () => []);
	return {
		client: { action, mutation, query } as unknown as ConvexClient,
		action,
		mutation,
	};
}

beforeEach(() => {
	backoff.mockClear();
});

describe('a connection whose account lost its credentials', () => {
	it('stops instead of backing off, and asks for credentials exactly once', async () => {
		const { client, action } = mockConvex();
		const connection = new AccountConnection(ACCOUNT, client, CONFIG);

		await connection.start();

		expect(connection.isStopped).toBe(true);
		expect(backoff).not.toHaveBeenCalled();
		expect(action).toHaveBeenCalledTimes(1);
	});

	it('writes no status back — the teardown already said what is true', async () => {
		const { client, mutation } = mockConvex();
		const connection = new AccountConnection(ACCOUNT, client, CONFIG);

		await connection.start();

		const statusWrites = mutation.mock.calls.filter(([reference]) =>
			JSON.stringify(reference).includes('setSyncStatus')
		);
		expect(statusWrites).toEqual([]);
	});

	it('stays stopped once the manager tears it down', async () => {
		const { client, action } = mockConvex();
		const connection = new AccountConnection(ACCOUNT, client, CONFIG);

		await connection.start();
		await connection.stop();

		expect(connection.isStopped).toBe(true);
		expect(backoff).not.toHaveBeenCalled();
		expect(action).toHaveBeenCalledTimes(1);
	});
});
