import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { CONNREFUSED, NOTFOUND, SERVFAIL, TIMEOUT } from 'node:dns';
import { Resolver } from 'node:dns/promises';
import { isNameResolutionCode, probeDns, probeTcp } from '../portProbe';

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

	/**
	 * With port 53 dropped, every name lookup hangs. If the lookup shared the
	 * socket's deadline, all six outbound rows would read `blocked` and send the
	 * operator to a firewall rule for a DNS fault — so a lookup that never
	 * answers must be its own, shorter failure.
	 */
	it('does not call a hanging resolver a blocked port', async () => {
		const startedAt = Date.now();
		const result = await probeTcp({
			// `.invalid` never resolves, and the lookup budget is what bounds it.
			host: 'hangs.invalid',
			port: 25,
			timeoutMs: 30_000,
			lookupTimeoutMs: 200,
		});
		expect(result.status).toBe('error');
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});
});

describe('isNameResolutionCode', () => {
	/**
	 * A successful probe carries no code. Reading that as a name failure turned
	 * every healthy inbound row into "not running here" — and an absent
	 * `node:dns` constant (there is no `TRY_AGAIN`) is exactly how a comparison
	 * against `undefined` gets written by accident.
	 */
	it('is false for a probe that carried no error at all', () => {
		expect(isNameResolutionCode(undefined)).toBe(false);
	});

	it('is true for the two codes a failed lookup actually produces', () => {
		expect(isNameResolutionCode(NOTFOUND)).toBe(true);
		expect(isNameResolutionCode('EAI_AGAIN')).toBe(true);
	});

	it('is false for socket-level codes', () => {
		expect(isNameResolutionCode('ECONNREFUSED')).toBe(false);
		expect(isNameResolutionCode('ETIMEDOUT')).toBe(false);
	});
});

describe('probeDns', () => {
	const record = [{ exchange: 'mx.example.com', priority: 10 }];

	/** A resolver pointed at one address, with the probe's own short budget. */
	function realResolverAt(address: string) {
		return async (domain: string) => {
			const resolver = new Resolver({ timeout: 300, tries: 1 });
			resolver.setServers([address]);
			return resolver.resolveMx(domain);
		};
	}

	it('is open when the resolver answers with records', async () => {
		const result = await probeDns({ domain: 'example.com', resolve: async () => record });
		expect(result.status).toBe('open');
	});

	it('is error — not open — when the answer is empty', async () => {
		const result = await probeDns({ domain: 'example.com', resolve: async () => [] });
		expect(result.status).toBe('error');
	});

	/**
	 * The DNS codes are NOT the socket ones — `node:dns` reports a resolver
	 * timeout as `ETIMEOUT`, one letter away from the socket's `ETIMEDOUT`. They
	 * are taken from the module's own constants here, because a test that spells
	 * them by hand pins whichever spelling the implementation happens to use and
	 * stays green while the real path returns the opposite verdict.
	 */
	it.each([TIMEOUT, 'ETIMEDOUT', CONNREFUSED, SERVFAIL])(
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
				throw Object.assign(new Error(NOTFOUND), { code: NOTFOUND });
			},
		});
		expect(result.status).toBe('error');
	});

	it('reports a real dropped resolver as blocked, through the default resolver', async () => {
		// The default path, not an injected stub: this is the case the constant
		// mismatch hid. TEST-NET-3 is routed nowhere, so the query times out.
		const result = await probeDns({
			domain: 'example.com',
			resolve: realResolverAt('203.0.113.1'),
		});
		expect(result.status).toBe('blocked');
	});
});
