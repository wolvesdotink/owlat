/**
 * Reconcile loop: Convex is the source of truth for which accounts should have
 * a live connection. On each tick we diff `listConnectableAccounts` against the
 * in-memory connection map — open connections for new accounts, tear down ones
 * that became disconnected/auth_error (no longer returned by the query) or were
 * deleted. This makes the worker stateless-recoverable and sharding-ready.
 */

import type { ConnectableAccount, ConvexClient } from './convex.js';
import { fn } from './convex.js';
import type { MailSyncConfig } from './config.js';
import { AccountConnection } from './connection.js';
import { logger } from './logger.js';

export class AccountManager {
	private readonly connections = new Map<string, AccountConnection>();
	private timer: ReturnType<typeof setInterval> | null = null;
	/** The pass in progress, if any; overlapping requests join it. */
	private running: Promise<void> | null = null;
	/** Another pass was asked for while one was running. */
	private rerun = false;
	private stopped = false;
	/** The shutdown drain, once stop() has been called; later calls join it. */
	private stopping: Promise<void> | null = null;
	/** Stops of connections this manager let go of mid-run, so stop() can await them. */
	private readonly retiring = new Set<Promise<void>>();

	constructor(
		private readonly convex: ConvexClient,
		private readonly config: MailSyncConfig
	) {}

	async start(): Promise<void> {
		await this.requestReconcile();
		// stop() may have run while the first pass was in flight; arming the
		// interval now would leave a timer nothing ever clears.
		if (this.stopped) return;
		this.timer = setInterval(() => void this.requestReconcile(), this.config.reconcileIntervalMs);
	}

	/**
	 * Run a reconcile pass now instead of on the next tick. Convex calls this
	 * (POST /reconcile) right after a mailbox is connected or its credentials
	 * change, so a new account does not sit idle for up to a full
	 * `reconcileIntervalMs`.
	 *
	 * Passes never overlap: a request that arrives mid-pass schedules exactly one
	 * more pass after it, because the running one may have read the account list
	 * before the change being announced. Two overlapping passes could also race
	 * each other — the older list tearing down a connection the newer one just
	 * opened.
	 */
	requestReconcile(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.running) {
			this.rerun = true;
			return this.running;
		}
		const run = async (): Promise<void> => {
			try {
				do {
					this.rerun = false;
					await this.reconcile();
				} while (this.rerun && !this.stopped);
			} finally {
				this.running = null;
			}
		};
		this.running = run();
		return this.running;
	}

	/**
	 * Terminal: once called, no pass opens or retires another connection. Resolves
	 * after the pass in flight (if any) has settled and every connection this
	 * manager created — live or already being retired — has finished stopping.
	 * The shutdown drain in index.ts relies on that, so nothing keeps syncing
	 * while the process exits.
	 */
	stop(): Promise<void> {
		this.stopping ??= this.drain();
		return this.stopping;
	}

	private async drain(): Promise<void> {
		this.stopped = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		// A pass still waiting on its account list sees `stopped` when the read
		// returns and changes nothing, so the map is final from here on.
		const pass = this.running?.catch(() => undefined);
		const live = [...this.connections];
		this.connections.clear();
		await Promise.all([
			pass,
			...live.map(([id, conn]) => this.stopConnection(id, conn)),
			...this.retiring,
		]);
	}

	/**
	 * The backend queued write-backs for this account. False when the worker
	 * holds no connection for it; the ops wait for the next connect.
	 */
	requestRemoteOps(accountId: string): boolean {
		const conn = this.connections.get(accountId);
		if (!conn) return false;
		conn.requestRemoteOps();
		return true;
	}

	private async reconcile(): Promise<void> {
		let accounts: ConnectableAccount[];
		try {
			accounts = await this.convex.query(fn.listConnectableAccounts, {});
		} catch (err) {
			logger.warn({ err }, 'reconcile: listConnectableAccounts failed');
			return;
		}
		// stop() ran while the list was loading. Its drain has already taken the
		// connections it will close; anything opened now would outlive it.
		if (this.stopped) return;

		const live = new Set(accounts.map((a) => a.accountId));

		for (const account of accounts) {
			const existing = this.connections.get(account.accountId);
			// A connection that gave up on its own (bad credentials, a revoked
			// grant) stays stopped for good. If its account is connectable again —
			// the user re-entered the password before any pass saw the `auth_error`
			// — it needs a fresh connection, or it would never sync again.
			if (existing && !existing.isStopped) continue;
			if (existing) {
				logger.info({ accountId: account.accountId }, 'replacing a stopped connection');
				this.retire(account.accountId, existing);
			}
			const conn = new AccountConnection(account, this.convex, this.config);
			this.connections.set(account.accountId, conn);
			logger.info({ accountId: account.accountId }, 'starting connection');
			void conn
				.start()
				.catch((err) =>
					logger.warn({ accountId: account.accountId, err }, 'connection start failed')
				);
		}

		for (const [id, conn] of this.connections) {
			if (live.has(id)) continue;
			logger.info({ accountId: id }, 'stopping connection (no longer connectable)');
			this.retire(id, conn);
			this.connections.delete(id);
		}
	}

	/** Stop a connection in the background, tracked until it settles. */
	private retire(accountId: string, conn: AccountConnection): void {
		const done = this.stopConnection(accountId, conn).finally(() => this.retiring.delete(done));
		this.retiring.add(done);
	}

	private async stopConnection(accountId: string, conn: AccountConnection): Promise<void> {
		try {
			await conn.stop();
		} catch (err) {
			logger.warn({ accountId, err }, 'connection stop failed');
		}
	}
}
