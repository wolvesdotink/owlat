/**
 * GET /metrics — the worker's Prometheus process metrics, served from the
 * same internal HTTP surface as /health and, like it, without the worker key.
 */

import { describe, expect, it, vi } from 'vitest';
import { startNodeMetrics } from '@owlat/shared/nodeMetrics';
import type { ConvexClient } from '../convex.js';
import type { MailSyncConfig } from '../config.js';

vi.mock('../logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createApp } = await import('../server.js');

const config = { apiKey: 'test-api-key', allowedFetchOrigins: [] } as unknown as MailSyncConfig;
// A Convex client that fails the test if the route reaches for it.
const convex = new Proxy({} as ConvexClient, {
	get: () => {
		throw new Error('/metrics must not call Convex');
	},
});

describe('GET /metrics', () => {
	it('serves process, memory and event-loop families without the worker key', async () => {
		const metrics = startNodeMetrics({ log: { warn: vi.fn() }, sampler: null });
		const app = createApp(config, convex, { metrics: metrics.registry });

		const res = await app.request('/metrics');

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe(metrics.registry.contentType);
		const body = await res.text();
		expect(body).toContain('# TYPE process_cpu_user_seconds_total counter');
		expect(body).toContain('# TYPE process_resident_memory_bytes gauge');
		expect(body).toContain('# TYPE nodejs_eventloop_lag_seconds gauge');
		expect(body).toContain('# TYPE nodejs_eventloop_stalls_total counter');
	});

	it('is not routed when the worker has no registry', async () => {
		const app = createApp(config, convex);

		expect((await app.request('/metrics')).status).toBe(404);
	});
});
