import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ConnectableAccount, ConvexClient } from '../convex.js';
import type { MailSyncConfig } from '../config.js';

/**
 * Capture every AccountConnection the manager constructs so tests can assert on
 * start()/stop() per account. The real connection.js pulls in imapflow + does
 * IMAP I/O, so we replace it wholesale with a recording stub.
 */
const { instances, resetInstances } = vi.hoisted(() => {
	const instances: Array<{
		account: { accountId: string };
		start: ReturnType<typeof import('vitest').vi.fn>;
		stop: ReturnType<typeof import('vitest').vi.fn>;
	}> = [];
	return {
		instances,
		resetInstances: () => {
			instances.length = 0;
		},
	};
});

vi.mock('../connection.js', () => {
	class AccountConnection {
		start = vi.fn().mockResolvedValue(undefined);
		stop = vi.fn().mockResolvedValue(undefined);
		constructor(public account: { accountId: string }) {
			instances.push(this as never);
		}
	}
	return { AccountConnection };
});

// Silence pino so the test output stays clean (and so the loop's warn paths run
// without spamming the reporter).
vi.mock('../logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { AccountManager } from '../accountManager.js';

const CONFIG: MailSyncConfig = {
	port: 3200,
	listenAddress: '0.0.0.0',
	convexUrl: 'https://example.convex.cloud',
	convexAdminKey: 'admin-key',
	apiKey: 'api-key',
	reconcileIntervalMs: 30_000,
	folderPollIntervalMs: 300_000,
};

function account(id: string): ConnectableAccount {
	return {
		accountId: id,
		mailboxId: `mbx_${id}`,
		imapHost: 'imap.example.com',
		imapPort: 993,
		isImapSecure: true,
		imapUsername: `${id}@example.com`,
		status: 'pending',
	};
}

/**
 * Mock Convex client whose `query` returns whatever the current `queue` head
 * dictates. Each entry is either a list of accounts or an Error to throw, so a
 * test can script successive reconcile ticks.
 */
function mockConvex(scripted: Array<ConnectableAccount[] | Error>) {
	let i = 0;
	const query = vi.fn(async () => {
		const step = i < scripted.length ? scripted[i] : scripted[scripted.length - 1];
		i += 1;
		if (step instanceof Error) throw step;
		return step as ConnectableAccount[];
	});
	return { client: { query } as unknown as ConvexClient, query };
}

/** Find the (single) constructed connection stub for an account id. */
function connFor(id: string) {
	return instances.find((c) => c.account.accountId === id);
}

beforeEach(() => {
	resetInstances();
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('AccountManager.reconcile', () => {
	it('opens a connection for a newly-connectable account', async () => {
		const { client } = mockConvex([[account('a')]]);
		const mgr = new AccountManager(client, CONFIG);

		// start() runs reconcile() once before arming the interval.
		await mgr.start();
		await mgr.stop();

		const a = connFor('a');
		expect(a).toBeDefined();
		expect(a?.start).toHaveBeenCalledTimes(1);
	});

	it('only opens one connection across repeated reconciles for the same account', async () => {
		const { client } = mockConvex([[account('a')], [account('a')]]);
		const mgr = new AccountManager(client, CONFIG);

		await mgr.start(); // tick 1
		// Drive a second reconcile via the armed interval.
		vi.useFakeTimers();
		await mgr['reconcile'](); // direct second tick (same as the timer would do)

		expect(instances.filter((c) => c.account.accountId === 'a')).toHaveLength(1);
		expect(connFor('a')?.start).toHaveBeenCalledTimes(1);

		vi.useRealTimers();
		await mgr.stop();
	});

	it('stops and forgets a connection that is no longer connectable', async () => {
		// Tick 1 returns [a]; tick 2 returns [] (account removed/disconnected).
		const { client } = mockConvex([[account('a')], []]);
		const mgr = new AccountManager(client, CONFIG);

		await mgr.start(); // tick 1: opens a
		const a = connFor('a');
		expect(a?.start).toHaveBeenCalledTimes(1);

		await mgr['reconcile'](); // tick 2: a is gone

		expect(a?.stop).toHaveBeenCalledTimes(1);
		// A subsequent reappearance must build a fresh connection, proving the
		// old one was dropped from the in-memory map.
		await mgr.stop();
	});

	it('reconnects a previously-disconnected account when it reappears', async () => {
		// connectable → removed → connectable again
		const { client } = mockConvex([[account('a')], [], [account('a')]]);
		const mgr = new AccountManager(client, CONFIG);

		await mgr.start(); // tick 1: open
		const first = connFor('a');
		await mgr['reconcile'](); // tick 2: stop + forget
		expect(first?.stop).toHaveBeenCalledTimes(1);

		await mgr['reconcile'](); // tick 3: reopen with a brand-new connection

		const all = instances.filter((c) => c.account.accountId === 'a');
		expect(all).toHaveLength(2);
		expect(all[1]).not.toBe(first);
		expect(all[1]?.start).toHaveBeenCalledTimes(1);

		await mgr.stop();
	});

	it('swallows a failing listConnectableAccounts query without opening connections', async () => {
		const { client, query } = mockConvex([new Error('convex unreachable')]);
		const mgr = new AccountManager(client, CONFIG);

		// reconcile() must not reject even though the query throws.
		await expect(mgr.start()).resolves.toBeUndefined();

		expect(query).toHaveBeenCalledTimes(1);
		expect(instances).toHaveLength(0);

		await mgr.stop();
	});

	it('keeps an existing connection alive across a transient query failure', async () => {
		// tick 1: [a] opens; tick 2: query throws (transient) → no teardown.
		const { client } = mockConvex([[account('a')], new Error('blip')]);
		const mgr = new AccountManager(client, CONFIG);

		await mgr.start();
		const a = connFor('a');
		expect(a?.start).toHaveBeenCalledTimes(1);

		await mgr['reconcile'](); // query throws; reconcile returns early

		expect(a?.stop).not.toHaveBeenCalled();

		await mgr.stop();
	});
});

describe('AccountManager.start / stop lifecycle', () => {
	it('arms a reconcile interval that fires on the configured cadence', async () => {
		vi.useFakeTimers();
		const { client, query } = mockConvex([[account('a')]]);
		const mgr = new AccountManager({ ...client } as ConvexClient, CONFIG);

		await mgr.start(); // immediate reconcile (tick 1)
		expect(query).toHaveBeenCalledTimes(1);

		// Advance one interval; the timer should trigger a second reconcile.
		await vi.advanceTimersByTimeAsync(CONFIG.reconcileIntervalMs);
		expect(query).toHaveBeenCalledTimes(2);

		await mgr.stop();
		vi.useRealTimers();
	});

	it('stop() clears the interval and stops every live connection', async () => {
		vi.useFakeTimers();
		const { client, query } = mockConvex([[account('a'), account('b')]]);
		const mgr = new AccountManager(client, CONFIG);

		await mgr.start();
		const a = connFor('a');
		const b = connFor('b');

		await mgr.stop();

		expect(a?.stop).toHaveBeenCalledTimes(1);
		expect(b?.stop).toHaveBeenCalledTimes(1);

		const callsAfterStop = query.mock.calls.length;
		// No further reconciles once stopped, even past several intervals.
		await vi.advanceTimersByTimeAsync(CONFIG.reconcileIntervalMs * 3);
		expect(query.mock.calls.length).toBe(callsAfterStop);

		vi.useRealTimers();
	});
});
