/**
 * Prometheus metrics for the SMTP connection pool.
 *
 * Split out of `connectionPool.ts` to keep that module under the file-size gate;
 * re-exported from it so existing importers are unaffected.
 */

import { Counter, Gauge } from 'prom-client';
import { registry } from '../monitoring/collector.js';

/** Pool connections by state (`idle` / `active`). */
export const smtpPoolConnections = new Gauge({
	name: 'mta_smtp_pool_connections',
	help: 'SMTP connection pool size by state',
	labelNames: ['state'] as const,
	registers: [registry],
});

/**
 * Deliveries that reused an already-open pooled socket via RSET rather than
 * opening a fresh TCP+STARTTLS+EHLO handshake (X1). A monotonically rising
 * counter — every successful RSET-boundary reuse increments it exactly once.
 */
export const smtpPoolReused = new Counter({
	name: 'mta_smtp_pool_reused_total',
	help: 'Total SMTP deliveries that reused a live pooled connection via RSET',
	registers: [registry],
});
