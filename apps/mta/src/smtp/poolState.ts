/** Internal state carried by one tracked SMTP socket lineage. */

import type { SmtpConnectOptions, SmtpConnection } from '@owlat/smtp-client';
import type { PoolConfig } from './poolLimits.js';

export const DEFAULT_POOL_CONFIG: PoolConfig = {
	maxPerHost: 3,
	idleTimeoutMs: 30_000,
	maxAgeMs: 300_000,
	maxMessagesPerConnection: 100,
};

export interface IdleConnection {
	conn: SmtpConnection;
	/** Deliveries already completed over this socket. */
	messagesSent: number;
	/** When the socket opened, for the maximum-lifetime cap. */
	openedAt: number;
}

export interface PoolEntry {
	baseKey: string;
	config: SmtpConnectOptions;
	connectionScope: string;
	maxDeliveriesPerConnection: number;
	lastUsedAt: number;
	inFlight: number;
	createdAt: number;
	/** At most one protocol-clean socket parked for reuse. */
	idle?: IdleConnection;
}
