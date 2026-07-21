/** Periodic ownership renewal for live distributed SMTP pool leases. */

import type { GlobalConnectionLease, PoolCoordinationProtocol } from './poolGlobalCap.js';
import { PoolGlobalCap } from './poolGlobalCap.js';

export interface LeaseHeartbeatTarget {
	key: string;
	lease: GlobalConnectionLease;
}

export class PoolLeaseHeartbeat {
	private timer: ReturnType<typeof setInterval> | undefined;
	private isRunning = false;

	constructor(
		private readonly cap: PoolGlobalCap,
		private readonly ttlSeconds: () => number,
		private readonly targets: () => LeaseHeartbeatTarget[],
		private readonly onOwnershipLost: (target: LeaseHeartbeatTarget) => void
	) {}

	start(protocol: PoolCoordinationProtocol): void {
		this.stop();
		if (protocol !== 'leases-v1') return;
		const intervalMs = Math.max(100, Math.floor((this.ttlSeconds() * 1000) / 3));
		this.timer = setInterval(() => void this.runNow(), intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	async runNow(): Promise<void> {
		if (this.isRunning) return;
		this.isRunning = true;
		try {
			await Promise.all(
				this.targets().map(async (target) => {
					if (!(await this.cap.renew(target.lease, this.ttlSeconds()))) {
						this.onOwnershipLost(target);
					}
				})
			);
		} finally {
			this.isRunning = false;
		}
	}
}
