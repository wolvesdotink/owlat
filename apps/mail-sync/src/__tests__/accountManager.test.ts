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
		isStopped: boolean;
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
		isStopped = false;
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
	convexSiteUrl: 'https://example.convex.cloud/http',
	convexAdminKey: 'admin-key',
	apiKey: 'api-key',
	reconcileIntervalMs: 30_000,
	folderPollIntervalMs: 300_000,
	inboxPollIntervalMs: 60_000,
	backfillBatchSize: 200,
	allowedFetchOrigins: ['https://example.convex.cloud'],
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

describe('AccountManager.requestReconcile (Convex poke, plan 3.6)', () => {
	it('opens a new account right away instead of on the next tick', async () => {
		vi.useFakeTimers();
		const { client, query } = mockConvex([[], [account('new')]]);
		const mgr = new AccountManager(client, CONFIG);
		await mgr.start();
		expect(connFor('new')).toBeUndefined();

		await mgr.requestReconcile();

		expect(query).toHaveBeenCalledTimes(2);
		expect(connFor('new')?.start).toHaveBeenCalledTimes(1);
		await mgr.stop();
	});

	it('runs one more pass, not an overlapping one, when poked mid-pass', async () => {
		let release!: (accounts: ConnectableAccount[]) => void;
		let inFlight = 0;
		let peak = 0;
		const lists: Array<ConnectableAccount[] | Promise<ConnectableAccount[]>> = [
			new Promise<ConnectableAccount[]>((resolve) => (release = resolve)),
			[account('a'), account('b')],
		];
		const query = vi.fn(async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			try {
				return await (lists.shift() ?? [account('a'), account('b')]);
			} finally {
				inFlight--;
			}
		});
		const mgr = new AccountManager({ query } as unknown as ConvexClient, CONFIG);

		const first = mgr.requestReconcile();
		// Two pokes while the first pass still waits on its (stale) list.
		const second = mgr.requestReconcile();
		const third = mgr.requestReconcile();
		release([account('a')]);
		await Promise.all([first, second, third]);

		// Exactly one follow-up pass, and never two at once.
		expect(query).toHaveBeenCalledTimes(2);
		expect(peak).toBe(1);
		expect(connFor('b')?.start).toHaveBeenCalledTimes(1);
		await mgr.stop();
	});

	it('does nothing once stopped', async () => {
		const { client, query } = mockConvex([[account('a')]]);
		const mgr = new AccountManager(client, CONFIG);
		await mgr.stop();
		await mgr.requestReconcile();
		expect(query).not.toHaveBeenCalled();
	});
});

describe('AccountManager replaces a connection that stopped for good', () => {
	it('opens a fresh connection when its account is connectable again', async () => {
		// The connection hit an auth error and stopped; the user re-entered the
		// password before any pass saw the account leave the list.
		const { client } = mockConvex([[account('a')]]);
		const mgr = new AccountManager(client, CONFIG);
		await mgr.requestReconcile();
		const first = instances[0]!;
		first.isStopped = true;

		await mgr.requestReconcile();

		expect(instances).toHaveLength(2);
		expect(first.stop).toHaveBeenCalledTimes(1);
		expect(instances[1]!.start).toHaveBeenCalledTimes(1);
	});

	it('leaves a live connection alone', async () => {
		const { client } = mockConvex([[account('a')]]);
		const mgr = new AccountManager(client, CONFIG);
		await mgr.requestReconcile();
		await mgr.requestReconcile();
		expect(instances).toHaveLength(1);
	});
});

describe('AccountManager.stop drains before it resolves', () => {
	/** A promise plus the handle that settles it, for holding a read or a stop open. */
	function deferred<T>() {
		let resolve!: (value: T) => void;
		const promise = new Promise<T>((r) => (resolve = r));
		return { promise, resolve };
	}

	/** Records when `p` settles, without awaiting it. */
	function track(p: Promise<unknown>) {
		const state = { settled: false };
		void p.then(() => (state.settled = true));
		return state;
	}

	it('opens nothing from an account list that arrives after stop', async () => {
		vi.useFakeTimers();
		const list = deferred<ConnectableAccount[]>();
		const query = vi.fn(() => list.promise);
		const mgr = new AccountManager({ query } as unknown as ConvexClient, CONFIG);

		const started = mgr.start();
		const stopped = mgr.stop();
		const stopState = track(stopped);
		await vi.advanceTimersByTimeAsync(0);
		// The pass is still waiting on its read, so the drain is too.
		expect(stopState.settled).toBe(false);

		list.resolve([account('a')]);
		await Promise.all([started, stopped]);

		expect(instances).toHaveLength(0);
		// start() lost the race to stop(): it must not arm the reconcile interval.
		expect(vi.getTimerCount()).toBe(0);

		// Pokes after stop stay no-ops.
		await mgr.requestReconcile();
		await vi.advanceTimersByTimeAsync(CONFIG.reconcileIntervalMs * 3);
		expect(query).toHaveBeenCalledTimes(1);
		expect(instances).toHaveLength(0);
	});

	it('does not arm the interval when stop() ran before start()', async () => {
		vi.useFakeTimers();
		const { client, query } = mockConvex([[account('a')]]);
		const mgr = new AccountManager(client, CONFIG);

		await mgr.stop();
		await mgr.start();

		expect(query).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('waits for a connection retired mid-run to finish stopping', async () => {
		// Tick 1 opens a; tick 2 no longer lists it, so the pass retires it.
		const { client } = mockConvex([[account('a')], []]);
		const mgr = new AccountManager(client, CONFIG);
		await mgr.start();
		const a = connFor('a')!;
		const logout = deferred<void>();
		a.stop.mockImplementation(() => logout.promise);

		await mgr.requestReconcile();
		expect(a.stop).toHaveBeenCalledTimes(1);

		const stopState = track(mgr.stop());
		await new Promise((r) => setTimeout(r, 0));
		expect(stopState.settled).toBe(false);

		logout.resolve();
		await vi.waitFor(() => expect(stopState.settled).toBe(true));
		// The drain did not stop the retired connection a second time.
		expect(a.stop).toHaveBeenCalledTimes(1);
	});

	it('waits for a replaced connection that had stopped for good', async () => {
		const { client } = mockConvex([[account('a')]]);
		const mgr = new AccountManager(client, CONFIG);
		await mgr.requestReconcile();
		const first = instances[0]!;
		first.isStopped = true;
		const logout = deferred<void>();
		first.stop.mockImplementation(() => logout.promise);

		await mgr.requestReconcile();
		const second = instances[1]!;

		const stopState = track(mgr.stop());
		await new Promise((r) => setTimeout(r, 0));
		expect(second.stop).toHaveBeenCalledTimes(1);
		expect(stopState.settled).toBe(false);

		logout.resolve();
		await vi.waitFor(() => expect(stopState.settled).toBe(true));
	});

	it('waits for live connections and is shared by repeated calls', async () => {
		const { client } = mockConvex([[account('a'), account('b')]]);
		const mgr = new AccountManager(client, CONFIG);
		await mgr.start();
		const a = connFor('a')!;
		const b = connFor('b')!;
		const logout = deferred<void>();
		a.stop.mockImplementation(() => logout.promise);
		b.stop.mockRejectedValue(new Error('socket already gone'));

		const first = mgr.stop();
		const second = mgr.stop();
		expect(second).toBe(first);
		const stopState = track(first);
		await new Promise((r) => setTimeout(r, 0));
		expect(stopState.settled).toBe(false);

		logout.resolve();
		// A connection whose stop fails does not fail the drain.
		await expect(first).resolves.toBeUndefined();
		expect(a.stop).toHaveBeenCalledTimes(1);
		expect(b.stop).toHaveBeenCalledTimes(1);
	});
});
