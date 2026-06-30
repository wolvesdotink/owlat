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

	constructor(
		private readonly convex: ConvexClient,
		private readonly config: MailSyncConfig,
	) {}

	async start(): Promise<void> {
		await this.reconcile();
		this.timer = setInterval(() => void this.reconcile(), this.config.reconcileIntervalMs);
	}

	async stop(): Promise<void> {
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
			accounts = (await this.convex.query(
				fn.listConnectableAccounts as never,
				{} as never,
			)) as ConnectableAccount[];
		} catch (err) {
			logger.warn({ err }, 'reconcile: listConnectableAccounts failed');
			return;
		}

		const live = new Set(accounts.map((a) => a.accountId));

		for (const account of accounts) {
			if (this.connections.has(account.accountId)) continue;
			const conn = new AccountConnection(account, this.convex, this.config);
			this.connections.set(account.accountId, conn);
			logger.info({ accountId: account.accountId }, 'starting connection');
			void conn
				.start()
				.catch((err) => logger.warn({ accountId: account.accountId, err }, 'connection start failed'));
		}

		for (const [id, conn] of this.connections) {
			if (live.has(id)) continue;
			logger.info({ accountId: id }, 'stopping connection (no longer connectable)');
			void conn.stop();
			this.connections.delete(id);
		}
	}
}
