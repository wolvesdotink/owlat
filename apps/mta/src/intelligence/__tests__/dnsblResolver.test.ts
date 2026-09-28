import { describe, expect, it, vi } from 'vitest';
import { createDnsblTransport, getDnsblTransport, parseDnsblResolver } from '../dnsblResolver.js';
import { dnsError } from './dnsblFixtures.js';

describe('parseDnsblResolver', () => {
	it('reads host, host:port, IPv4 and bracketed IPv6, defaulting to port 53', () => {
		expect(parseDnsblResolver('dns-resolver:5335')).toEqual({ host: 'dns-resolver', port: 5335 });
		expect(parseDnsblResolver('dns-resolver')).toEqual({ host: 'dns-resolver', port: 53 });
		expect(parseDnsblResolver('10.0.0.53')).toEqual({ host: '10.0.0.53', port: 53 });
		expect(parseDnsblResolver('[2001:db8::53]:5335')).toEqual({ host: '2001:db8::53', port: 5335 });
	});

	it('treats an empty value as "use the system resolver"', () => {
		expect(parseDnsblResolver(undefined)).toBeUndefined();
		expect(parseDnsblResolver('')).toBeUndefined();
		expect(parseDnsblResolver('   ')).toBeUndefined();
	});

	it('refuses anything that is not a resolver address', () => {
		expect(() => parseDnsblResolver('https://resolver.example')).toThrow('DNSBL_RESOLVER');
		expect(() => parseDnsblResolver('[not-v6]:53')).toThrow('DNSBL_RESOLVER');
		expect(() => parseDnsblResolver('resolver:0')).toThrow('port');
		expect(() => parseDnsblResolver('resolver:70000')).toThrow('port');
	});
});

function bundledDeps(bundledResolve4: (hostname: string) => Promise<string[]>) {
	const systemResolve4 = vi.fn(async () => ['127.255.255.254']);
	const lookupAddress = vi.fn(async () => '172.18.0.9');
	const createResolver = vi.fn((_server: string) => ({ resolve4: bundledResolve4 }));
	return { systemResolve4, lookupAddress, createResolver, now: () => 0 };
}

describe('createDnsblTransport', () => {
	it('is the system resolver when no target is configured', async () => {
		const systemResolve4 = vi.fn(async () => ['127.0.0.2']);
		const transport = createDnsblTransport(undefined, { systemResolve4 });

		expect(await transport.resolve4('2.0.0.127.zen.spamhaus.org')).toEqual(['127.0.0.2']);
		expect(transport.configured).toBe('system');
		expect(transport.lastPath()).toBe('system');
	});

	it('asks the bundled resolver at its container address and port', async () => {
		const deps = bundledDeps(async () => ['127.0.0.2']);
		const transport = createDnsblTransport({ host: 'dns-resolver', port: 5335 }, deps);

		expect(await transport.resolve4('2.0.0.127.zen.spamhaus.org')).toEqual(['127.0.0.2']);
		expect(deps.lookupAddress).toHaveBeenCalledWith('dns-resolver');
		expect(deps.createResolver).toHaveBeenCalledWith('172.18.0.9:5335');
		expect(deps.systemResolve4).not.toHaveBeenCalled();
		expect(transport.configured).toBe('bundled');
		expect(transport.lastPath()).toBe('bundled');
	});

	it('passes an NXDOMAIN answer through instead of asking the system resolver', async () => {
		const deps = bundledDeps(async () => {
			throw dnsError('ENOTFOUND');
		});
		const transport = createDnsblTransport({ host: 'dns-resolver', port: 5335 }, deps);

		await expect(transport.resolve4('1.0.0.10.zen.spamhaus.org')).rejects.toMatchObject({
			code: 'ENOTFOUND',
		});
		expect(deps.systemResolve4).not.toHaveBeenCalled();
		expect(transport.lastPath()).toBe('bundled');
	});

	it('falls back to the system resolver when the bundled one fails, and finds it again next time', async () => {
		const deps = bundledDeps(async () => {
			throw dnsError('ESERVFAIL');
		});
		const transport = createDnsblTransport({ host: 'dns-resolver', port: 5335 }, deps);

		expect(await transport.resolve4('1.0.0.10.zen.spamhaus.org')).toEqual(['127.255.255.254']);
		expect(transport.lastPath()).toBe('system');
		await transport.resolve4('1.0.0.10.zen.spamhaus.org');
		// The cached address is dropped on failure: a recreated container may have moved.
		expect(deps.lookupAddress).toHaveBeenCalledTimes(2);
	});

	it('falls back when the resolver container does not exist, without mistaking that for NXDOMAIN', async () => {
		const deps = bundledDeps(async () => ['127.0.0.2']);
		deps.lookupAddress.mockRejectedValue(dnsError('ENOTFOUND'));
		const transport = createDnsblTransport({ host: 'dns-resolver', port: 5335 }, deps);

		expect(await transport.resolve4('1.0.0.10.zen.spamhaus.org')).toEqual(['127.255.255.254']);
		expect(deps.createResolver).not.toHaveBeenCalled();
		expect(transport.lastPath()).toBe('system');
	});

	it('brackets an IPv6 resolver address', async () => {
		const deps = bundledDeps(async () => ['127.0.0.2']);
		const transport = createDnsblTransport(
			{ host: '2001:db8::53', port: 5335 },
			{
				...deps,
				lookupAddress: async (host) => host,
			}
		);

		await transport.resolve4('2.0.0.127.zen.spamhaus.org');
		expect(deps.createResolver).toHaveBeenCalledWith('[2001:db8::53]:5335');
	});
});

describe('getDnsblTransport', () => {
	it('shares one transport per configured target', () => {
		const target = { host: 'dns-resolver', port: 5335 };
		const first = getDnsblTransport({ dnsblResolver: target });
		expect(getDnsblTransport({ dnsblResolver: { ...target } })).toBe(first);
		expect(getDnsblTransport({})).not.toBe(first);
		expect(getDnsblTransport({}).configured).toBe('system');
	});
});
