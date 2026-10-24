import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { connect, type AddressInfo } from 'node:net';
import { startNodeMetrics, type MetricsSource } from '@owlat/shared/nodeMetrics';
import { startMetricsServer, type MetricsServerHandle } from '../metricsServer.js';

vi.mock('../logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const handles: MetricsServerHandle[] = [];

async function listen(
	source: MetricsSource
): Promise<{ handle: MetricsServerHandle; base: string }> {
	const handle = startMetricsServer(source, { port: 0, host: '127.0.0.1' });
	handles.push(handle);
	await once(handle.server, 'listening');
	const { port } = handle.server.address() as AddressInfo;
	return { handle, base: `http://127.0.0.1:${port}` };
}

afterEach(() => {
	for (const handle of handles.splice(0)) handle.stop();
});

describe('IMAP metrics listener', () => {
	it('serves the process registry on GET /metrics', async () => {
		const metrics = startNodeMetrics({ log: { warn: vi.fn() }, sampler: null });
		const { base } = await listen(metrics.registry);

		const res = await fetch(`${base}/metrics`);

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe(metrics.registry.contentType);
		const body = await res.text();
		expect(body).toContain('# TYPE process_resident_memory_bytes gauge');
		expect(body).toContain('# TYPE nodejs_eventloop_lag_seconds gauge');
		expect(body).toContain('# TYPE nodejs_eventloop_stalls_total counter');
	});

	it('answers 404 for any other path or method', async () => {
		const { base } = await listen({ contentType: 'text/plain', metrics: async () => '' });

		expect((await fetch(`${base}/`)).status).toBe(404);
		expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(404);
	});

	it('answers 400 for an unparseable request target and keeps serving', async () => {
		const { handle, base } = await listen({ contentType: 'text/plain', metrics: async () => 'ok' });
		const { port } = handle.server.address() as AddressInfo;

		// fetch() normalises the target, so the malformed request line goes over a raw socket.
		const socket = connect(port, '127.0.0.1');
		socket.setEncoding('utf8');
		socket.write('GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
		let raw = '';
		socket.on('data', (chunk: string) => {
			raw += chunk;
		});
		await once(socket, 'end');

		expect(raw.startsWith('HTTP/1.1 400 ')).toBe(true);
		const res = await fetch(`${base}/metrics`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ok');
	});

	it('answers 500 when the registry cannot render', async () => {
		const { base } = await listen({
			contentType: 'text/plain',
			metrics: () => Promise.reject(new Error('collector threw')),
		});

		const res = await fetch(`${base}/metrics`);

		expect(res.status).toBe(500);
	});

	it('stop() closes the listener', async () => {
		const { handle } = await listen({ contentType: 'text/plain', metrics: async () => '' });

		handle.stop();
		await once(handle.server, 'close');

		expect(handle.server.listening).toBe(false);
	});
});
