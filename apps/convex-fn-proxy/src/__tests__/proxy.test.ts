import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { createProxyHandler, type ProxyConfig } from '../proxy.js';

/**
 * End-to-end proof of the least-privilege boundary. A REAL `ConvexHttpClient` —
 * the exact client the code-worker uses — authenticates with the WORKER token
 * and drives the proxy, which forwards to a mock "Convex" upstream. We verify,
 * against the true Convex HTTP wire format:
 *   - an allowlisted call reaches upstream with the WORKER token stripped and
 *     the real admin key injected;
 *   - a non-allowlisted call is refused 403 and never reaches upstream;
 *   - a wrong/absent worker token is refused 401 and never reaches upstream.
 */

const REAL_ADMIN_KEY = 'real-deployment-admin-key-do-not-leak';
const WORKER_TOKEN = 'code-worker-proxy-token-abc123';

interface CapturedRequest {
	readonly pathname: string;
	readonly authorization: string | undefined;
	readonly body: { path?: string };
}

/** Start an HTTP server on an ephemeral port and resolve its base URL. */
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

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

describe('convex function-allowlist proxy (real ConvexHttpClient → proxy → mock upstream)', () => {
	let upstream: Server;
	let proxy: Server;
	let proxyUrl: string;
	let captured: CapturedRequest[];

	beforeEach(async () => {
		captured = [];

		// Mock Convex upstream: record the forwarded request and reply with the
		// backend's real success envelope `{ status: 'success', value }`.
		const up = await startServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c: Buffer) => chunks.push(c));
			req.on('end', () => {
				let body: { path?: string } = {};
				try {
					body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				} catch {
					body = {};
				}
				captured.push({
					pathname: new URL(req.url ?? '/', 'http://u').pathname,
					authorization: req.headers['authorization'] as string | undefined,
					body,
				});
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ status: 'success', value: null, logLines: [] }));
			});
		});
		upstream = up.server;

		const config: ProxyConfig = {
			convexUrl: up.url,
			adminKey: REAL_ADMIN_KEY,
			workerToken: WORKER_TOKEN,
		};
		const px = await startServer(createProxyHandler(config));
		proxy = px.server;
		proxyUrl = px.url;
	});

	afterEach(async () => {
		await closeServer(proxy);
		await closeServer(upstream);
	});

	function workerClient(): ConvexHttpClient {
		const client = new ConvexHttpClient(proxyUrl, { skipConvexDeploymentUrlCheck: true });
		// The worker presents the PROXY TOKEN via setAdminAuth — never the admin key.
		(client as unknown as { setAdminAuth(token: string): void }).setAdminAuth(WORKER_TOKEN);
		return client;
	}

	it('forwards an allowlisted query with the worker token stripped and admin injected', async () => {
		const client = workerClient();
		const result = await client.query(
			makeFunctionReference<'query', Record<string, never>, null>('codeWorkTasks:getNextQueued')
		);

		expect(result).toBeNull();
		expect(captured).toHaveLength(1);
		expect(captured[0]!.pathname).toBe('/api/query');
		expect(captured[0]!.body.path).toBe('codeWorkTasks:getNextQueued');
		// The real admin key is injected; the worker token is gone.
		expect(captured[0]!.authorization).toBe(`Convex ${REAL_ADMIN_KEY}`);
		expect(captured[0]!.authorization).not.toContain(WORKER_TOKEN);
	});

	it('forwards an allowlisted mutation with the admin key injected', async () => {
		const client = workerClient();
		await client.mutation(
			makeFunctionReference<'mutation', { taskId: string }, null>('codeWorkTasks:claim'),
			{ taskId: 'task_1' }
		);

		expect(captured).toHaveLength(1);
		expect(captured[0]!.pathname).toBe('/api/mutation');
		expect(captured[0]!.body.path).toBe('codeWorkTasks:claim');
		expect(captured[0]!.authorization).toBe(`Convex ${REAL_ADMIN_KEY}`);
	});

	it('forwards an allowlisted plugins/workerTasks call', async () => {
		const client = workerClient();
		await client.mutation(
			makeFunctionReference<'mutation', { taskId: string }, null>('plugins/workerTasks:heartbeat'),
			{ taskId: 'task_1' }
		);
		expect(captured).toHaveLength(1);
		expect(captured[0]!.body.path).toBe('plugins/workerTasks:heartbeat');
	});

	it('refuses a non-allowlisted function with 403 and never reaches upstream', async () => {
		const client = workerClient();
		await expect(
			client.mutation(
				makeFunctionReference<'mutation', Record<string, never>, null>('codeWorkTasks:create')
			)
		).rejects.toThrow();
		expect(captured).toHaveLength(0);
	});

	it('refuses an unrelated module path with 403 and never reaches upstream', async () => {
		const res = await fetch(`${proxyUrl}/api/mutation`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Convex ${WORKER_TOKEN}` },
			body: JSON.stringify({
				path: 'organizations:deleteAll',
				format: 'convex_encoded_json',
				args: [{}],
			}),
		});
		expect(res.status).toBe(403);
		expect(captured).toHaveLength(0);
	});

	it('refuses a request with the wrong worker token (401) and never reaches upstream', async () => {
		const res = await fetch(`${proxyUrl}/api/mutation`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: 'Convex not-the-token' },
			body: JSON.stringify({
				path: 'codeWorkTasks:claim',
				format: 'convex_encoded_json',
				args: [{}],
			}),
		});
		expect(res.status).toBe(401);
		expect(captured).toHaveLength(0);
	});

	it('refuses a request with no Authorization header (401) and never reaches upstream', async () => {
		const res = await fetch(`${proxyUrl}/api/mutation`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				path: 'codeWorkTasks:claim',
				format: 'convex_encoded_json',
				args: [{}],
			}),
		});
		expect(res.status).toBe(401);
		expect(captured).toHaveLength(0);
	});

	it('refuses a non-Convex endpoint (404) even with a valid token', async () => {
		const res = await fetch(`${proxyUrl}/api/function`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Convex ${WORKER_TOKEN}` },
			body: JSON.stringify({
				path: 'codeWorkTasks:claim',
				format: 'convex_encoded_json',
				args: {},
			}),
		});
		expect(res.status).toBe(404);
		expect(captured).toHaveLength(0);
	});
});
