/**
 * Tests for the SSRF guard.
 *
 * The interesting security property is the connect-time defence against DNS
 * rebinding (TOCTOU): the up-front `validatePublicUrl` check resolves DNS once,
 * but the socket re-resolves independently, so a name that flips to a private
 * IP between the two would otherwise slip through. `ssrfLookup` is the
 * `dns.lookup`-shaped hook installed on the fetch socket's `undici` Agent; it
 * must reject the connection if ANY address it resolves is private/loopback,
 * regardless of what the up-front check saw. We exercise it with an injected
 * resolver so no real DNS is needed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LookupAddress, LookupAllOptions } from 'dns';
import {
	fetchGuarded,
	isDisallowedIpAddress,
	RedirectRefusedError,
	SsrfBlockedError,
	ssrfLookup,
	type LookupFn,
} from '../ssrfGuard';

/** Build a fake `dns.lookup`-shaped resolver that always returns `addresses`. */
function staticResolver(addresses: LookupAddress[]): LookupFn {
	return (_hostname, _options, callback) => {
		callback(null, addresses);
	};
}

/** Build a fake resolver that fails like a real resolution error. */
function failingResolver(err: NodeJS.ErrnoException): LookupFn {
	return (_hostname, _options, callback) => {
		callback(err, []);
	};
}

/** Invoke ssrfLookup with an injected resolver and capture the callback. */
function runLookup(
	hostname: string,
	resolver: LookupFn
): Promise<{ err: NodeJS.ErrnoException | null; addresses: LookupAddress[] }> {
	const options: LookupAllOptions = { all: true };
	return new Promise((resolve) => {
		ssrfLookup(hostname, options, (err, addresses) => resolve({ err, addresses }), resolver);
	});
}

describe('isDisallowedIpAddress', () => {
	it('flags loopback / private / link-local / CGNAT IPv4', () => {
		expect(isDisallowedIpAddress('127.0.0.1')).toBe(true);
		expect(isDisallowedIpAddress('10.0.0.5')).toBe(true);
		expect(isDisallowedIpAddress('172.16.0.1')).toBe(true);
		expect(isDisallowedIpAddress('192.168.1.1')).toBe(true);
		expect(isDisallowedIpAddress('169.254.169.254')).toBe(true); // cloud metadata
		expect(isDisallowedIpAddress('100.64.0.1')).toBe(true); // CGNAT
		expect(isDisallowedIpAddress('0.0.0.0')).toBe(true);
	});

	it('allows routable public IPv4', () => {
		expect(isDisallowedIpAddress('8.8.8.8')).toBe(false);
		expect(isDisallowedIpAddress('1.1.1.1')).toBe(false);
		expect(isDisallowedIpAddress('172.32.0.1')).toBe(false); // just outside private range
	});

	it('flags loopback / ULA / link-local IPv6 and mapped IPv4', () => {
		expect(isDisallowedIpAddress('::1')).toBe(true);
		expect(isDisallowedIpAddress('fd00::1')).toBe(true);
		expect(isDisallowedIpAddress('fe80::1')).toBe(true);
		expect(isDisallowedIpAddress('::ffff:127.0.0.1')).toBe(true);
		expect(isDisallowedIpAddress('2606:4700:4700::1111')).toBe(false); // public
	});

	it('flags hex-form IPv4-mapped IPv6 (the dotted-quad bypass)', () => {
		// ::ffff:7f00:1 is 127.0.0.1 written as hextets — the hex suffix used to
		// fall through the mapped-IPv4 branch unclassified.
		expect(isDisallowedIpAddress('::ffff:7f00:1')).toBe(true);
		expect(isDisallowedIpAddress('::ffff:a00:1')).toBe(true); // 10.0.0.1
		expect(isDisallowedIpAddress('::ffff:c0a8:101')).toBe(true); // 192.168.1.1
		expect(isDisallowedIpAddress('::ffff:A9FE:FEFE')).toBe(true); // 169.254.254.254
		// Public addresses in hex-mapped form stay allowed.
		expect(isDisallowedIpAddress('::ffff:808:808')).toBe(false); // 8.8.8.8
		// Malformed hex suffixes fail closed rather than classify as public.
		expect(isDisallowedIpAddress('::ffff:zzzz:1')).toBe(true);
	});

	it('flags IPv4-mapped IPv6 written uncompressed or partially compressed', () => {
		// The same 127.0.0.1 the `::ffff:` prefix rule caught, respelled. A textual
		// prefix match sees none of these, so each one used to fall through as
		// "public"; classification now runs on the expanded hextets.
		expect(isDisallowedIpAddress('0:0:0:0:0:ffff:7f00:1')).toBe(true);
		expect(isDisallowedIpAddress('0:0:0:0:0:ffff:127.0.0.1')).toBe(true);
		expect(isDisallowedIpAddress('0::ffff:7f00:1')).toBe(true);
		expect(isDisallowedIpAddress('0:0:0:0:0:ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254
		// Public addresses in those same spellings stay allowed — the fix is not a
		// blanket IPv6 deny.
		expect(isDisallowedIpAddress('0:0:0:0:0:ffff:808:808')).toBe(false); // 8.8.8.8
		expect(isDisallowedIpAddress('0:0:0:0:0:ffff:8.8.8.8')).toBe(false);
		expect(isDisallowedIpAddress('0::ffff:8.8.8.8')).toBe(false);
	});

	it('flags IPv4-compatible and IPv4-translated IPv6 embeddings', () => {
		// ::a.b.c.d is the deprecated IPv4-compatible form and ::ffff:0:a.b.c.d the
		// RFC 2765 IPv4-translated one; both still reach the embedded IPv4 on a
		// host that speaks them.
		expect(isDisallowedIpAddress('::7f00:1')).toBe(true); // 127.0.0.1
		expect(isDisallowedIpAddress('::127.0.0.1')).toBe(true);
		expect(isDisallowedIpAddress('::a9fe:a9fe')).toBe(true); // 169.254.169.254
		expect(isDisallowedIpAddress('::ffff:0:7f00:1')).toBe(true);
		expect(isDisallowedIpAddress('::ffff:0:127.0.0.1')).toBe(true);
		expect(isDisallowedIpAddress('64:ff9b::7f00:1')).toBe(true); // RFC 6052 NAT64
		// Public counterexamples in each form.
		expect(isDisallowedIpAddress('::808:808')).toBe(false); // 8.8.8.8
		expect(isDisallowedIpAddress('::8.8.8.8')).toBe(false);
		expect(isDisallowedIpAddress('::ffff:0:808:808')).toBe(false);
		expect(isDisallowedIpAddress('64:ff9b::8.8.8.8')).toBe(false);
	});

	it('classifies bracketed literals, since URL.hostname keeps the brackets', () => {
		// `new URL('http://[::1]/').hostname` is '[::1]', and the webhook-host check
		// passes that hostname straight in with no isIP() in front of it — without
		// stripping the brackets it looks like a DNS name and is allowed.
		expect(isDisallowedIpAddress('[::1]')).toBe(true);
		expect(isDisallowedIpAddress('[::ffff:7f00:1]')).toBe(true);
		expect(isDisallowedIpAddress('[fe80::1]')).toBe(true);
		expect(isDisallowedIpAddress('[2606:4700:4700::1111]')).toBe(false); // public
	});

	it('fails closed on anything colon-bearing it cannot parse', () => {
		expect(isDisallowedIpAddress('1:2:3:4:5:6:7:8:9')).toBe(true); // too many groups
		expect(isDisallowedIpAddress('1::2::3')).toBe(true); // two zero runs
		expect(isDisallowedIpAddress('::ffff:999.1.1.1')).toBe(true); // octet > 255
		expect(isDisallowedIpAddress('::ffff:1.2.3.4.5')).toBe(true); // five octets
		expect(isDisallowedIpAddress('fe80::1%eth0')).toBe(true); // zone id
		// A colon can't appear in a DNS name, so hostnames are still not our
		// business — 'fd'/'ff' prefixed names are not addresses.
		expect(isDisallowedIpAddress('example.com')).toBe(false);
		expect(isDisallowedIpAddress('fdcdn.example.com')).toBe(false);
	});

	it('holds the fe80::/10 and fc00::/7 range edges exactly', () => {
		// The old fe8/fe9/fea/feb string prefixes approximated fe80::/10; the
		// hextet range must not widen (fec0:: is global) or narrow (febf:: is not).
		expect(isDisallowedIpAddress('fe7f:ffff::1')).toBe(false);
		expect(isDisallowedIpAddress('fe80::')).toBe(true);
		expect(isDisallowedIpAddress('febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(true);
		expect(isDisallowedIpAddress('fec0::1')).toBe(false);
		expect(isDisallowedIpAddress('fbff::1')).toBe(false);
		expect(isDisallowedIpAddress('fc00::')).toBe(true);
		expect(isDisallowedIpAddress('fdff:ffff::1')).toBe(true);
		expect(isDisallowedIpAddress('fe00::1')).toBe(false);
		expect(isDisallowedIpAddress('ff02::1')).toBe(true); // multicast
	});
});

describe('fetchGuarded typed refusals', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('throws a typed SsrfBlockedError for a blocked (private/internal) destination', async () => {
		// A literal private IP is refused up front by validatePublicUrl — no DNS,
		// no socket — so this asserts the mapped error TYPE, not just the message.
		await expect(
			fetchGuarded('https://127.0.0.1/hook', { protocols: ['https:'] })
		).rejects.toBeInstanceOf(SsrfBlockedError);
	});

	it('throws a typed RedirectRefusedError when the destination answers a 3xx', async () => {
		// A literal PUBLIC IP passes the up-front check without DNS; a stubbed fetch
		// returns a redirect so the guard's redirect-refusal path is exercised.
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					({
						status: 302,
						headers: new Headers({ location: 'https://10.0.0.1/' }),
					}) as unknown as Response
			)
		);
		await expect(
			fetchGuarded('https://8.8.8.8/hook', { protocols: ['https:'] })
		).rejects.toBeInstanceOf(RedirectRefusedError);
	});
});

describe('ssrfLookup (connect-time DNS-rebinding guard)', () => {
	it('passes through public addresses unchanged', async () => {
		const addrs: LookupAddress[] = [{ address: '93.184.216.34', family: 4 }];
		const { err, addresses } = await runLookup('example.com', staticResolver(addrs));
		expect(err).toBeNull();
		expect(addresses).toEqual(addrs);
	});

	it('rejects when the socket-time resolution flips to a loopback address', async () => {
		// Rebinding: the up-front check saw a public IP, but the socket re-resolves
		// to loopback. The hook must error so the connection is never made.
		const { err, addresses } = await runLookup(
			'rebind.attacker.example',
			staticResolver([{ address: '127.0.0.1', family: 4 }])
		);
		expect(err).not.toBeNull();
		expect(err?.message).toMatch(/disallowed \(private\/internal\)/);
		expect(addresses).toEqual([]);
	});

	it('rejects when the socket-time resolution flips to cloud metadata', async () => {
		const { err } = await runLookup(
			'metadata.attacker.example',
			staticResolver([{ address: '169.254.169.254', family: 4 }])
		);
		expect(err).not.toBeNull();
		expect(err?.message).toContain('169.254.169.254');
	});

	it('rejects if ANY of several resolved addresses is private', async () => {
		// A multi-record response with one poisoned address must be refused
		// wholesale — undici would otherwise be free to pick the private one.
		const { err } = await runLookup(
			'mixed.attacker.example',
			staticResolver([
				{ address: '8.8.8.8', family: 4 },
				{ address: '10.0.0.1', family: 4 },
			])
		);
		expect(err).not.toBeNull();
		expect(err?.message).toContain('10.0.0.1');
	});

	it('rejects a private IPv6 (ULA) at connect time', async () => {
		const { err } = await runLookup(
			'v6.attacker.example',
			staticResolver([{ address: 'fd00::1', family: 6 }])
		);
		expect(err).not.toBeNull();
	});

	it('propagates a genuine resolution failure', async () => {
		const resolveErr = Object.assign(new Error('getaddrinfo ENOTFOUND'), {
			code: 'ENOTFOUND',
		}) as NodeJS.ErrnoException;
		const { err } = await runLookup('does-not-exist.invalid', failingResolver(resolveErr));
		expect(err).toBe(resolveErr);
	});

	it('forces all:true so it sees the full address list', async () => {
		let seenOptions: LookupAllOptions | undefined;
		const recordingResolver: LookupFn = (_hostname, options, callback) => {
			seenOptions = options;
			callback(null, [{ address: '8.8.8.8', family: 4 }]);
		};
		// undici may pass all:false defaults through; the hook must still resolve
		// the full list so a single poisoned record can't hide behind all:false.
		await new Promise<void>((resolve) => {
			ssrfLookup(
				'example.com',
				{ all: false } as unknown as LookupAllOptions,
				() => resolve(),
				recordingResolver
			);
		});
		expect(seenOptions?.all).toBe(true);
	});
});
