import { describe, it, expect } from 'vitest';
import { createServer } from 'node:net';
import { checkPublicHosts, defaultHostCheckDeps, type HostCheckDeps } from '../publicHostCheck';

const HOSTS = ['owlat.example.com', 'api.example.com', 'rest.api.example.com'];

/** A server the names point at: every connection lands on the token listener. */
function server(overrides: Partial<HostCheckDeps> = {}): HostCheckDeps {
	let token = '';
	return {
		resolve: async () => ['203.0.113.10'],
		listen: async (_port, t) => {
			token = t;
			return { close: async () => {} };
		},
		connect: async () => token,
		token: () => 'fresh-token',
		...overrides,
	};
}

describe('checkPublicHosts', () => {
	it('passes when every name resolves and reaches this server on 80 and 443', async () => {
		expect(await checkPublicHosts(HOSTS, server())).toEqual([]);
	});

	it('names each record that is missing', async () => {
		const problems = await checkPublicHosts(
			HOSTS,
			server({ resolve: async (host) => (host === 'api.example.com' ? [] : ['203.0.113.10']) })
		);
		expect(problems).toEqual([
			"api.example.com does not resolve. Create an A record for it pointing at this server's public IPv4 address.",
		]);
	});

	it('fails a name whose port answers, but not from this server', async () => {
		const probed: Array<[string, number]> = [];
		const problems = await checkPublicHosts(
			['owlat.example.com'],
			server({
				resolve: async () => ['198.51.100.7'],
				connect: async (address, port) => {
					probed.push([address, port]);
					return 'someone else';
				},
			})
		);
		expect(probed).toEqual([
			['198.51.100.7', 80],
			['198.51.100.7', 443],
		]);
		expect(problems).toHaveLength(2);
		expect(problems[0]).toContain(
			'Port 80 on owlat.example.com (198.51.100.7) does not reach this server: point the A record at this server'
		);
	});

	it('accepts a port another process on this server already serves, when it connects', async () => {
		const deps = server({ listen: async () => 'EADDRINUSE', connect: async () => '' });
		expect(await checkPublicHosts(HOSTS, deps)).toEqual([]);
		const unreachable = server({ listen: async () => 'EADDRINUSE', connect: async () => null });
		expect(await checkPublicHosts(['owlat.example.com'], unreachable)).toHaveLength(2);
	});

	it('says so when it cannot listen to test a port', async () => {
		const problems = await checkPublicHosts(
			['owlat.example.com'],
			server({ listen: async (port) => (port === 80 ? 'EACCES' : { close: async () => {} }) })
		);
		expect(problems[0]).toBe(
			'Could not listen on port 80 to test it (EACCES). Run the installer as root on the server itself.'
		);
	});

	it('reads the token back through a real listener on loopback', async () => {
		const probe = createServer();
		const port = await new Promise<number>((resolve) =>
			probe.listen(0, '127.0.0.1', () => {
				const address = probe.address();
				resolve(typeof address === 'object' && address ? address.port : 0);
			})
		);
		await new Promise<void>((resolve) => probe.close(() => resolve()));

		const listener = await defaultHostCheckDeps.listen(port, 'the-token');
		expect(typeof listener).toBe('object');
		try {
			expect(await defaultHostCheckDeps.connect('127.0.0.1', port)).toBe('the-token');
		} finally {
			if (typeof listener === 'object') await listener.close();
		}
		expect(await defaultHostCheckDeps.connect('127.0.0.1', port)).toBeNull();
	});
});
