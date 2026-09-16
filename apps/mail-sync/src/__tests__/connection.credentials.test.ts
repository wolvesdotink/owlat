/**
 * What the connect loop does when the backend hands back no credentials.
 *
 * The two outcomes must not be treated alike. A REVOKED authorization (the user
 * removed Owlat from their Google account) is terminal: the backend has already
 * written `auth_error` plus the one instruction that resolves it, so the worker
 * has to stop and leave that message in place. Anything else — a row that is
 * momentarily unreadable, a Google hiccup — is retryable and keeps the existing
 * back-off behaviour.
 *
 * The regression this locks: collapsing both into a bare `null` made the loop
 * throw a generic 'credentials unavailable', overwrite the actionable message
 * with it, and retry forever, spending a Google token request per pass.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConnectableAccount, ConvexClient, WorkerCredentialsResult } from '../convex.js';
import type { MailSyncConfig } from '../config.js';
import { AccountConnection } from '../connection.js';

const ACCOUNT: ConnectableAccount = {
	accountId: 'acct_1',
	mailboxId: 'mbx_1',
	imapHost: 'imap.gmail.com',
	imapPort: 993,
	isImapSecure: true,
	imapUsername: 'me@gmail.com',
	status: 'connected',
};

const CONFIG = { folderPollIntervalMs: 60_000 } as unknown as MailSyncConfig;

function newConnection(result: WorkerCredentialsResult) {
	const action = vi.fn(async () => result);
	const mutation = vi.fn(async () => ({}));
	const convex = {
		query: vi.fn(async () => []),
		mutation,
		action,
	} as unknown as ConvexClient;
	return { conn: new AccountConnection(ACCOUNT, convex, CONFIG), action, mutation };
}

/** Let the loop run through its awaits without letting any timer fire. */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
	// Fake timers so a retrying loop parks on its back-off sleep instead of
	// keeping the test file alive for five real seconds.
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('credentials the backend refuses to mint', () => {
	it('stops without overwriting the status when the authorization was revoked', async () => {
		const { conn, action, mutation } = newConnection({
			kind: 'unavailable',
			reason: 'auth_revoked',
		});

		await conn.start();

		// One attempt, then nothing: no second token request, no back-off loop.
		expect(action).toHaveBeenCalledTimes(1);
		// And crucially no status write — the backend's `auth_error` message
		// ("Reconnect with Google") is the one the user must see.
		expect(mutation).not.toHaveBeenCalled();
	});

	it('records an error and retries when the credentials are merely unavailable', async () => {
		const { conn, mutation } = newConnection({ kind: 'unavailable', reason: 'missing' });

		void conn.start();
		await flush();

		expect(mutation).toHaveBeenCalledTimes(1);
		const args = mutation.mock.calls[0]![1] as { status: string; lastError?: string };
		expect(args.status).toBe('error');
		expect(args.lastError).toContain('missing');

		await conn.stop();
	});

	it('reports a transient token-refresh failure as retryable, not terminal', async () => {
		const { conn, mutation } = newConnection({ kind: 'unavailable', reason: 'refresh_failed' });

		void conn.start();
		await flush();

		const args = mutation.mock.calls[0]![1] as { status: string };
		expect(args.status).toBe('error');

		await conn.stop();
	});
});
