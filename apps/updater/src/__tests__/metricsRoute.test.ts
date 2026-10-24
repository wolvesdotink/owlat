import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNodeMetrics } from '@owlat/shared/nodeMetrics';

// Any Docker command would go through spawn; /metrics must never reach it.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

process.env['INSTANCE_SECRET'] = 'test-instance-secret-0123456789';
process.env['OWLAT_DIR'] = mkdtempSync(join(tmpdir(), 'owlat-updater-metrics-'));

// Dynamic import AFTER env is staged — server.ts reads env at module load.
const { buildRequestListener } = await import('../server.js');

const metrics = startNodeMetrics({ log: { warn: vi.fn() }, sampler: null });
const servers: Server[] = [];

async function mount(listener: ReturnType<typeof buildRequestListener>): Promise<string> {
	const server = createServer(listener);
	servers.push(server);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

let base: string;

beforeAll(async () => {
	base = await mount(buildRequestListener({ metrics: metrics.registry }));
});

afterAll(() => {
	for (const server of servers) server.close();
});

describe('updater GET /metrics', () => {
	it('serves process, memory and event-loop families without the instance secret', async () => {
		const res = await fetch(`${base}/metrics`);

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe(metrics.registry.contentType);
		const body = await res.text();
		expect(body).toContain('# TYPE process_cpu_user_seconds_total counter');
		expect(body).toContain('# TYPE process_resident_memory_bytes gauge');
		expect(body).toContain('# TYPE nodejs_eventloop_lag_seconds gauge');
		expect(body).toContain('# TYPE nodejs_eventloop_stalls_total counter');
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it('is not routed when the listener has no registry', async () => {
		const bare = await mount(buildRequestListener());

		expect((await fetch(`${bare}/metrics`)).status).toBe(404);
	});
});
