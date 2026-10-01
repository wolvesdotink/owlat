import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createProxyHandler, UPSTREAM_TIMEOUT_MS } from '../proxy.js';

/**
 * A Convex deployment that accepts the forwarded call and never answers must
 * not hold the worker's request open forever: the proxy gives up after its
 * deadline and answers 504, which the worker can retry.
 */

const WORKER_TOKEN = 'code-worker-proxy-token-abc123';

function startServer(
	handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ server: Server; url: string }> {
	return new Promise((resolve) => {
		const server = createServer(handler);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as AddressInfo;
			resolve({ server, url: `http://127.0.0.1:${port}` });
		});
	});
}

const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

async function proxyInFrontOf(
	upstreamHandler: (req: IncomingMessage, res: ServerResponse) => void,
	timeoutMs: number
): Promise<string> {
	const upstream = await startServer(upstreamHandler);
	servers.push(upstream.server);
	const proxy = await startServer(
		createProxyHandler(
			{ convexUrl: upstream.url, adminKey: 'admin-key', workerToken: WORKER_TOKEN },
			fetch,
			timeoutMs
		)
	);
	servers.push(proxy.server);
	return proxy.url;
}

function callProxy(url: string): Promise<Response> {
	return fetch(`${url}/api/query`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Convex ${WORKER_TOKEN}` },
		body: JSON.stringify({
			path: 'codeWorkTasks:getNextQueued',
			format: 'convex_encoded_json',
			args: [{}],
		}),
	});
}

describe('convex-fn-proxy upstream deadline', () => {
	it('answers 504 when the upstream never responds', async () => {
		const url = await proxyInFrontOf(() => {
			// Accept the request and never answer.
		}, 50);

		const res = await callProxy(url);

		expect(res.status).toBe(504);
		expect(await res.json()).toEqual({ error: 'Upstream Convex request timed out' });
	});

	it('answers 504 when the upstream sends headers and then stalls the body', async () => {
		const url = await proxyInFrontOf((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.write('{"status":');
		}, 50);

		const res = await callProxy(url);

		expect(res.status).toBe(504);
	});

	it('still relays a prompt upstream answer unchanged', async () => {
		const url = await proxyInFrontOf((req, res) => {
			req.resume();
			req.on('end', () => {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ status: 'success', value: 7, logLines: [] }));
			});
		}, 1_000);

		const res = await callProxy(url);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'success', value: 7, logLines: [] });
	});

	it('defaults to a deadline that queue queries and mutations never approach', () => {
		expect(UPSTREAM_TIMEOUT_MS).toBe(30_000);
	});
});
