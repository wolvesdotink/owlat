import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { probeDns, probeTcp } from '../portProbe';

/**
 * The socket half of the port checks.
 *
 * What matters here is the vocabulary the card is built on: an operator who
 * reads "blocked" goes to their provider's firewall, one who reads "refused"
 * goes to their own stack, and one who reads "error" is told we could not find
 * out. Mixing those up sends people to the wrong place, so each mapping is
 * pinned — with real sockets where that is deterministic, and an injected
 * resolver where it is not.
 */

const servers: Server[] = [];

afterAll(() => {
	for (const server of servers) server.close();
});

async function listeningPort(): Promise<number> {
	const server = createServer();
	servers.push(server);
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const addr = server.address();
	if (typeof addr !== 'object' || !addr) throw new Error('no address');
	return addr.port;
}

describe('probeTcp', () => {
	it('reports a listening port as open', async () => {
		const port = await listeningPort();
		const result = await probeTcp({ host: '127.0.0.1', port });
		expect(result.status).toBe('open');
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it('reports a closed port as refused — something answered, so the path is open', async () => {
		const port = await listeningPort();
		const server = servers[servers.length - 1]!;
		await new Promise<void>((r) => server.close(() => r()));
		const result = await probeTcp({ host: '127.0.0.1', port });
		expect(result.status).toBe('refused');
		expect(result.code).toBe('ECONNREFUSED');
	});

	it('reports silence as blocked once the probe timeout elapses', async () => {
		// TEST-NET-3 (RFC 5737) is reserved for documentation and routed
		// nowhere, so this is the dropped-packet case a provider firewall
		// produces — with a short budget so the case stays fast.
		const result = await probeTcp({ host: '203.0.113.1', port: 25, timeoutMs: 250 });
		expect(result.status).toBe('blocked');
	});

	it('reports a name that does not resolve as error, never as a blocked port', async () => {
		const result = await probeTcp({
			host: 'service-that-is-not-deployed.invalid',
			port: 993,
			timeoutMs: 1_000,
		});
		expect(result.status).toBe('error');
		expect(result.code).toMatch(/ENOTFOUND|EAI_AGAIN/);
	});
});

describe('probeDns', () => {
	const record = [{ exchange: 'mx.example.com', priority: 10 }];

	it('is open when the resolver answers with records', async () => {
		const result = await probeDns({ domain: 'example.com', resolve: async () => record });
		expect(result.status).toBe('open');
	});

	it('is error — not open — when the answer is empty', async () => {
		const result = await probeDns({ domain: 'example.com', resolve: async () => [] });
		expect(result.status).toBe('error');
	});

	it.each(['ETIMEDOUT', 'ECONNREFUSED', 'ESERVFAIL'])(
		'reads %s as a blocked resolver path',
		async (code) => {
			const result = await probeDns({
				domain: 'example.com',
				resolve: async () => {
					throw Object.assign(new Error(code), { code });
				},
			});
			expect(result.status).toBe('blocked');
			expect(result.code).toBe(code);
		}
	);

	it('reads NXDOMAIN as our own bad probe domain, not as a firewall', async () => {
		const result = await probeDns({
			domain: 'nope.invalid',
			resolve: async () => {
				throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
			},
		});
		expect(result.status).toBe('error');
	});
});
