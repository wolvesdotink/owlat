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
