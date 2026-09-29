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

	constructor(
		private readonly convex: ConvexClient,
		private readonly config: MailSyncConfig
	) {}

	async start(): Promise<void> {
		await this.requestReconcile();
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

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		await Promise.all([...this.connections.values()].map((c) => c.stop()));
		this.connections.clear();
	}

	private async reconcile(): Promise<void> {
		let accounts: ConnectableAccount[];
		try {
			accounts = await this.convex.query(fn.listConnectableAccounts, {});
		} catch (err) {
			logger.warn({ err }, 'reconcile: listConnectableAccounts failed');
			return;
		}

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
				void existing.stop();
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
			void conn.stop();
			this.connections.delete(id);
		}
	}
}
