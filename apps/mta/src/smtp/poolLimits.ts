/** Public connection-pool limit configuration and cap error. */

export interface PoolConfig {
	/** Max concurrent entries per host (default 3). */
	maxPerHost: number;
	/** Drop entries idle longer than this (default 30 seconds). */
	idleTimeoutMs: number;
	/** Drop entries older than this regardless of activity (default 5 minutes). */
	maxAgeMs: number;
	/** Default deliveries over one reused socket before a clean recycle. */
	maxMessagesPerConnection: number;
}

/** A new socket lineage would exceed its MX or provider connection scope. */
export class PoolOverCapError extends Error {
	constructor(public readonly connectionScope: string) {
		super(`SMTP connection cap reached for ${connectionScope}`);
		this.name = 'PoolOverCapError';
	}
}
