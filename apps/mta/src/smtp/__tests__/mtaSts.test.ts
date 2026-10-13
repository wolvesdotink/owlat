import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type RealRedis from 'ioredis';

vi.mock('dns/promises', () => ({
	resolveTxt: vi.fn(),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getStsTlsOptions, parseStsPolicy, isMxAllowed, fetchStsPolicy } from '../mtaSts.js';
import { resolveTxt } from 'dns/promises';

const resolveTxtMock = vi.mocked(resolveTxt);

const CACHE_PREFIX = 'mta:sts:';

/** Build a DNS TXT lookup that returns an MTA-STS record with the given id. */
function dnsRecord(id: string): string[][] {
	return [[`v=STSv1; id=${id};`]];
}

/** Build a valid STSv1 enforcing policy body for a fetch() stub. */
function policyBody(opts: { mode?: string; mx?: string[]; maxAge?: number | string } = {}): string {
	const lines = ['version: STSv1'];
	lines.push(`mode: ${opts.mode ?? 'enforce'}`);
	for (const mx of opts.mx ?? ['*.example.com']) lines.push(`mx: ${mx}`);
	if (opts.maxAge !== undefined) lines.push(`max_age: ${opts.maxAge}`);
	return lines.join('\n');
}

function stubFetch(body: string) {
	return vi
		.spyOn(globalThis, 'fetch')
		.mockResolvedValue(new Response(body, { status: 200 }) as unknown as Response);
}

describe('mtaSts', () => {
	let redis: RealRedis;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
		resolveTxtMock.mockReset();
	});

	afterEach(async () => {
		await redis.flushall();
		vi.restoreAllMocks();
	});

	describe('parseStsPolicy — version validation (RFC 8461 §3.1)', () => {
		it('rejects a body with no version line', () => {
			const policy = parseStsPolicy('mode: enforce\nmx: *.example.com\nmax_age: 86400', 'id-1');
			expect(policy.mode).toBe('none');
			expect(policy.mx).toEqual([]);
		});

		it('rejects a future STSv2 body', () => {
			const policy = parseStsPolicy(
				'version: STSv2\nmode: enforce\nmx: *.example.com\nmax_age: 86400',
				'id-1'
			);
			expect(policy.mode).toBe('none');
			expect(policy.mx).toEqual([]);
		});

		it('rejects an HTML error page served instead of a policy', () => {
			const policy = parseStsPolicy('<html><body>404 Not Found</body></html>', 'id-1');
			expect(policy.mode).toBe('none');
		});

		it('accepts a valid STSv1 policy', () => {
			const policy = parseStsPolicy(
				'version: STSv1\nmode: enforce\nmx: *.example.com\nmax_age: 86400',
				'id-1'
			);
			expect(policy.mode).toBe('enforce');
			expect(policy.mx).toEqual(['*.example.com']);
			expect(policy.maxAge).toBe(86400);
			expect(policy.version).toBe('id-1');
		});

		it('accepts STSv1 case-insensitively', () => {
			const policy = parseStsPolicy(
				'version: stsv1\nmode: testing\nmx: mx.example.com\nmax_age: 600',
				'id-1'
			);
			expect(policy.mode).toBe('testing');
		});
	});

	describe('parseStsPolicy — max_age clamping (RFC 8461 §3.2)', () => {
		it('clamps an over-large max_age to the one-year ceiling', () => {
			const policy = parseStsPolicy(
				'version: STSv1\nmode: enforce\nmx: *.example.com\nmax_age: 99999999',
				'id-1'
			);
			expect(policy.maxAge).toBe(31557600);
		});

		it('preserves max_age: 0 for mode: none', () => {
			const policy = parseStsPolicy('version: STSv1\nmode: none\nmax_age: 0', 'id-1');
			expect(policy.mode).toBe('none');
			expect(policy.maxAge).toBe(0);
		});

		it('preserves max_age: 0 even for an enforce policy (does not coerce to 86400)', () => {
			const policy = parseStsPolicy(
				'version: STSv1\nmode: enforce\nmx: *.example.com\nmax_age: 0',
				'id-1'
			);
			expect(policy.maxAge).toBe(0);
		});

		it('never accepts a negative max_age', () => {
			const policy = parseStsPolicy(
				'version: STSv1\nmode: enforce\nmx: *.example.com\nmax_age: -5',
				'id-1'
			);
			expect(policy.maxAge).toBeGreaterThanOrEqual(0);
			// Negative is invalid → falls back to the 1-day default for an enforce policy.
			expect(policy.maxAge).toBe(86400);
		});

		it('falls back to the default for a non-numeric max_age', () => {
			const policy = parseStsPolicy(
				'version: STSv1\nmode: enforce\nmx: *.example.com\nmax_age: abc',
				'id-1'
			);
			expect(policy.maxAge).toBe(86400);
		});

		it('falls back to the default for an absent max_age', () => {
			const policy = parseStsPolicy('version: STSv1\nmode: enforce\nmx: *.example.com', 'id-1');
			expect(policy.maxAge).toBe(86400);
		});
	});

	describe('getStsTlsOptions — id-based refresh on cache hit (RFC 8461 §5.1)', () => {
		it('re-fetches and re-caches when the DNS id changes (testing -> enforce)', async () => {
			// Seed cache with a stale testing policy at id-1.
			const cacheKey = `${CACHE_PREFIX}example.com`;
			await redis.set(
				cacheKey,
				JSON.stringify({
					mode: 'testing',
					mx: ['*.example.com'],
					maxAge: 86400,
					version: 'id-1',
					cachedAt: Date.now(),
				})
			);

			// DNS now advertises a bumped id-2; the policy file is now enforce.
			resolveTxtMock.mockResolvedValue(dnsRecord('id-2'));
			const fetchSpy = stubFetch(policyBody({ mode: 'enforce', mx: ['mail.example.com'] }));

			const opts = await getStsTlsOptions(redis, 'example.com');

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(opts.policyMode).toBe('enforce');
			expect(opts.requireTLS).toBe(true);
			expect(opts.rejectUnauthorized).toBe(true);
			expect(opts.allowedMxHosts).toEqual(['mail.example.com']);

			// Re-cached under the new id.
			const reCached = JSON.parse((await redis.get(cacheKey))!);
			expect(reCached.version).toBe('id-2');
			expect(reCached.mode).toBe('enforce');
		});

		it('takes the cheap path (no HTTP fetch) when cached id matches DNS id', async () => {
			const cacheKey = `${CACHE_PREFIX}example.com`;
			await redis.set(
				cacheKey,
				JSON.stringify({
					mode: 'enforce',
					mx: ['*.example.com'],
					maxAge: 86400,
					version: 'id-1',
					cachedAt: Date.now(),
				})
			);

			resolveTxtMock.mockResolvedValue(dnsRecord('id-1'));
			const fetchSpy = stubFetch(policyBody());

			const opts = await getStsTlsOptions(redis, 'example.com');

			expect(fetchSpy).not.toHaveBeenCalled();
			expect(opts.policyMode).toBe('enforce');
			expect(opts.requireTLS).toBe(true);
		});

		it('keeps the cached enforce policy when the id-change re-fetch fails (no downgrade)', async () => {
			// RFC 8461 §5.1/§6.2: a policy-fetch failure must NOT discard an
			// unexpired cached policy. An on-path attacker who spoofs the DNS id
			// AND blocks the HTTPS fetch must not be able to strip a live enforce
			// policy down to opportunistic TLS.
			const cacheKey = `${CACHE_PREFIX}example.com`;
			await redis.set(
				cacheKey,
				JSON.stringify({
					mode: 'enforce',
					mx: ['mail.example.com'],
					maxAge: 86400,
					version: 'id-1',
					cachedAt: Date.now(),
				})
			);

			// DNS advertises a bumped id-2 but the policy fetch is blocked/fails.
			resolveTxtMock.mockResolvedValue(dnsRecord('id-2'));
			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				.mockRejectedValue(new Error('connect ECONNREFUSED'));

			const opts = await getStsTlsOptions(redis, 'example.com');

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			// Still enforcing against the cached policy, not downgraded to 'none'.
			expect(opts.policyMode).toBe('enforce');
			expect(opts.requireTLS).toBe(true);
			expect(opts.rejectUnauthorized).toBe(true);
			expect(opts.allowedMxHosts).toEqual(['mail.example.com']);

			// Cache untouched: still the id-1 enforce policy (not overwritten/cleared).
			const stillCached = JSON.parse((await redis.get(cacheKey))!);
			expect(stillCached.version).toBe('id-1');
			expect(stillCached.mode).toBe('enforce');
		});

		it('keeps serving the cached policy when DNS is currently unreachable', async () => {
			const cacheKey = `${CACHE_PREFIX}example.com`;
			await redis.set(
				cacheKey,
				JSON.stringify({
					mode: 'enforce',
					mx: ['*.example.com'],
					maxAge: 86400,
					version: 'id-1',
					cachedAt: Date.now(),
				})
			);

			resolveTxtMock.mockRejectedValue(new Error('SERVFAIL'));
			const fetchSpy = stubFetch(policyBody());

			const opts = await getStsTlsOptions(redis, 'example.com');

			expect(fetchSpy).not.toHaveBeenCalled();
			expect(opts.policyMode).toBe('enforce');
		});

		it('fetches and caches on a cold cache', async () => {
			resolveTxtMock.mockResolvedValue(dnsRecord('id-1'));
			const fetchSpy = stubFetch(policyBody({ mode: 'enforce', mx: ['*.example.com'] }));

			const opts = await getStsTlsOptions(redis, 'example.com');

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(opts.policyMode).toBe('enforce');

			const cached = JSON.parse((await redis.get(`${CACHE_PREFIX}example.com`))!);
			expect(cached.version).toBe('id-1');
		});

		it('returns opportunistic TLS for a domain without an MTA-STS record', async () => {
			resolveTxtMock.mockResolvedValue([]);

			const opts = await getStsTlsOptions(redis, 'no-sts.example.com');

			expect(opts.policyMode).toBe('none');
			expect(opts.requireTLS).toBe(false);
			expect(opts.allowedMxHosts).toEqual([]);
		});
	});

	describe('isMxAllowed', () => {
		it('matches exact and wildcard patterns', () => {
			expect(isMxAllowed('mail.google.com', ['*.google.com'])).toBe(true);
			expect(isMxAllowed('aspmx.l.google.com', ['*.google.com'])).toBe(true);
			expect(isMxAllowed('mail.google.com', ['mail.google.com'])).toBe(true);
			expect(isMxAllowed('evil.com', ['*.google.com'])).toBe(false);
		});

		it('allows any host when there are no patterns', () => {
			expect(isMxAllowed('anything.com', [])).toBe(true);
		});
	});

	// ── PR-35 regression lock ────────────────────────────────────────────────
	// Locks the MTA-STS core called out in EMAIL_BEST_PRACTICES_AUDIT_2026-06-21
	// item PR-35: the policy fetch (URL/throw/abort), the enforce/testing/none
	// option mapping, wildcard matching, the empty-mx validation guard, the
	// fetch/Redis fail-open, and the negative cache. RFC 8461 §3.3/§4.1/§5.

	describe('fetchStsPolicy — HTTPS retrieval (RFC 8461 §3.3)', () => {
		it('GETs exactly https://mta-sts.<domain>/.well-known/mta-sts.txt', async () => {
			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValue(new Response(policyBody(), { status: 200 }) as unknown as Response);

			await fetchStsPolicy('example.com', 'id-1');

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const calledUrl = fetchSpy.mock.calls[0]![0];
			expect(calledUrl).toBe('https://mta-sts.example.com/.well-known/mta-sts.txt');
		});

		it('throws on a non-2xx response (404)', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response('not found', { status: 404, statusText: 'Not Found' }) as unknown as Response
			);

			await expect(fetchStsPolicy('example.com', 'id-1')).rejects.toThrow(/404/);
		});

		it('throws on a 5xx response (does not silently treat it as no-policy)', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response('boom', {
					status: 503,
					statusText: 'Service Unavailable',
				}) as unknown as Response
			);

			await expect(fetchStsPolicy('example.com', 'id-1')).rejects.toThrow();
		});

		it('passes an AbortSignal that aborts at the 10s timeout', async () => {
			let capturedSignal: AbortSignal | undefined;
			vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
				capturedSignal = (init as RequestInit | undefined)?.signal ?? undefined;
				return Promise.resolve(new Response(policyBody(), { status: 200 }) as unknown as Response);
			});
			// AbortSignal.timeout(ms) — assert the deadline is the 10s budget, not 0/∞.
			const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

			await fetchStsPolicy('example.com', 'id-1');

			expect(capturedSignal).toBeInstanceOf(AbortSignal);
			expect(timeoutSpy).toHaveBeenCalledWith(10_000);
		});

		it('carries the policy DNS id onto the parsed policy', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response(policyBody({ mode: 'enforce', mx: ['*.example.com'] }), {
					status: 200,
				}) as unknown as Response
			);

			const policy = await fetchStsPolicy('example.com', 'id-xyz');
			expect(policy.version).toBe('id-xyz');
			expect(policy.mode).toBe('enforce');
		});
	});

	// Issue #1326: the policy host is attacker-controlled. A redirect must not
	// carry the GET to another origin (plaintext / internal), and the body must
	// be read under a byte cap instead of buffered whole.
	describe('fetchStsPolicy — redirect and size bounds (RFC 8461 §3.3)', () => {
		const realFetch = globalThis.fetch;
		const servers: Server[] = [];

		function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
			const server = createServer(handler);
			servers.push(server);
			return new Promise((resolve) =>
				server.listen(0, '127.0.0.1', () =>
					resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
				)
			);
		}

		afterEach(async () => {
			await Promise.all(
				servers.splice(0).map((s) => {
					s.closeAllConnections();
					return new Promise((resolve) => s.close(() => resolve(undefined)));
				})
			);
		});

		it('does not follow a redirect to a private plaintext target (real fetch)', async () => {
			let secondHopRequests = 0;
			const internal = await listen((_req, res) => {
				secondHopRequests++;
				res.end(policyBody());
			});
			const policyHost = await listen((_req, res) => {
				res.writeHead(302, { Location: `${internal}/` });
				res.end();
			});
			// Stand in for DNS: send the production RequestInit to the local policy
			// host so real fetch decides whether to follow the 302.
			vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => realFetch(policyHost, init));

			await expect(fetchStsPolicy('example.com', 'id-1')).rejects.toThrow(/redirect/);
			expect(secondHopRequests).toBe(0);
		});

		it.each([301, 302, 307, 308])('rejects a %i response', async (status) => {
			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response(null, {
					status,
					headers: { Location: 'http://127.0.0.1/.well-known/mta-sts.txt' },
				}) as unknown as Response
			);

			await expect(fetchStsPolicy('example.com', 'id-1')).rejects.toThrow(/redirect/);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect((fetchSpy.mock.calls[0]![1] as RequestInit).redirect).toBe('manual');
		});

		it('rejects a declared Content-Length over the cap without reading the body', async () => {
			const policyHost = await listen((_req, res) => {
				res.writeHead(200, { 'Content-Length': String(1024 * 1024) });
				res.write('version: STSv1\n');
				// Never finish: a read that waited for the body would hang the test.
			});
			vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => realFetch(policyHost, init));

			await expect(fetchStsPolicy('example.com', 'id-1')).rejects.toThrow(/too large/);
		});

		it('rejects an oversized chunked body at the cap and cancels the stream', async () => {
			let cancelled = false;
			let pulled = 0;
			// 2 MiB of valid-looking lines in 1 KiB chunks, with no Content-Length.
			const oversized = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(policyBody() + '\n'));
				},
				pull(controller) {
					if (++pulled > 2048) return controller.close();
					controller.enqueue(new TextEncoder().encode(`mx: ${'a'.repeat(1019)}\n`));
				},
				cancel() {
					cancelled = true;
				},
			});
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response(oversized, { status: 200 }) as unknown as Response
			);

			await expect(fetchStsPolicy('example.com', 'id-1')).rejects.toThrow(/exceeds/);
			expect(cancelled).toBe(true);
			// 1 KiB chunks against a 64 KiB cap: reading stops just past the limit.
			expect(pulled).toBeLessThanOrEqual(66);
		});

		it('still parses a valid policy served in small chunks', async () => {
			const policyHost = await listen((_req, res) => {
				res.writeHead(200, { 'Content-Type': 'text/plain' });
				for (const line of policyBody({
					mode: 'enforce',
					mx: ['mx1.example.com', '*.example.net'],
				}).split('\n'))
					res.write(`${line}\n`);
				res.end('max_age: 604800\n');
			});
			vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => realFetch(policyHost, init));

			const policy = await fetchStsPolicy('example.com', 'id-1');
			expect(policy).toMatchObject({
				mode: 'enforce',
				mx: ['mx1.example.com', '*.example.net'],
				maxAge: 604800,
				version: 'id-1',
			});
		});
	});

	describe('getStsTlsOptions — mode → option mapping (RFC 8461 §5)', () => {
		// A distinct domain per call so a cold-cache fetch happens every time and the
		// previous mode's cached policy is never reused (same domain+id would hit
		// the cheap cache path and serve the prior policy).
		let n = 0;
		async function optionsFor(mode: 'enforce' | 'testing'): Promise<{
			requireTLS: boolean;
			rejectUnauthorized: boolean;
			allowedMxHosts: string[];
			policyMode: string;
		}> {
			const domain = `d${n++}.example.com`;
			resolveTxtMock.mockResolvedValue(dnsRecord('id-1'));
			stubFetch(policyBody({ mode, mx: ['*.example.com'] }));
			return getStsTlsOptions(redis, domain);
		}

		it('enforce → (requireTLS true, rejectUnauthorized true) with policyMode passed through', async () => {
			const opts = await optionsFor('enforce');
			expect(opts.requireTLS).toBe(true);
			expect(opts.rejectUnauthorized).toBe(true);
			expect(opts.policyMode).toBe('enforce');
			expect(opts.allowedMxHosts).toEqual(['*.example.com']);
		});

		it('testing → (requireTLS false, rejectUnauthorized false) but still reports the allowed MX + policyMode', async () => {
			const opts = await optionsFor('testing');
			expect(opts.requireTLS).toBe(false);
			expect(opts.rejectUnauthorized).toBe(false);
			expect(opts.policyMode).toBe('testing');
			// testing carries the MX list for reporting, but does not enforce against it
			expect(opts.allowedMxHosts).toEqual(['*.example.com']);
		});

		it('none → (requireTLS false, rejectUnauthorized false) with no allowed MX', async () => {
			// An explicit mode:none body parses to a none policy; getStsTlsOptions
			// falls through to opportunistic TLS with an empty allow list.
			resolveTxtMock.mockResolvedValue(dnsRecord('id-1'));
			stubFetch('version: STSv1\nmode: none\nmax_age: 0');
			const opts = await getStsTlsOptions(redis, 'none-mode.example.com');
			expect(opts.requireTLS).toBe(false);
			expect(opts.rejectUnauthorized).toBe(false);
			expect(opts.policyMode).toBe('none');
			expect(opts.allowedMxHosts).toEqual([]);
		});

		it('enforce skips a disallowed MX (isMxAllowed is consulted), testing/none allow all MX', async () => {
			// enforce: only the listed MX is permitted; an off-list MX is rejected.
			const enforce = await optionsFor('enforce');
			expect(isMxAllowed('mail.example.com', enforce.allowedMxHosts)).toBe(true);
			expect(isMxAllowed('mx.attacker.net', enforce.allowedMxHosts)).toBe(false);

			// testing: requireTLS is false so the sender attempts EVERY MX (it does
			// not skip on the policy); the off-list MX is still attempted.
			const testing = await optionsFor('testing');
			expect(testing.requireTLS).toBe(false);

			// none: empty allow list — isMxAllowed allow-all, every MX attempted.
			resolveTxtMock.mockResolvedValue([]);
			const none = await getStsTlsOptions(redis, 'no-sts.example.com');
			expect(none.allowedMxHosts).toEqual([]);
			expect(isMxAllowed('anything.example.org', none.allowedMxHosts)).toBe(true);
		});
	});

	describe('isMxAllowed — wildcard semantics (RFC 8461 §4.1)', () => {
		it('*.google.com matches a multi-label subdomain a.b.google.com', () => {
			expect(isMxAllowed('a.b.google.com', ['*.google.com'])).toBe(true);
		});

		it('*.google.com matches aspmx.l.google.com', () => {
			expect(isMxAllowed('aspmx.l.google.com', ['*.google.com'])).toBe(true);
		});

		it('*.google.com does NOT match the bare apex google.com', () => {
			// A wildcard requires at least one label to the left of the suffix.
			expect(isMxAllowed('google.com', ['*.google.com'])).toBe(false);
		});

		it('*.google.com does NOT match the look-alike evilgoogle.com (suffix-confusion)', () => {
			// "evilgoogle.com" ends with "google.com" textually but is a different
			// registrable domain — the match must be on a dot boundary, not a raw
			// string suffix.
			expect(isMxAllowed('evilgoogle.com', ['*.google.com'])).toBe(false);
			expect(isMxAllowed('mail.evilgoogle.com', ['*.google.com'])).toBe(false);
		});

		it('is case-insensitive and tolerates a trailing dot (FQDN form)', () => {
			expect(isMxAllowed('Mail.Google.Com.', ['*.google.com'])).toBe(true);
			expect(isMxAllowed('mail.google.com', ['*.GOOGLE.COM.'])).toBe(true);
		});
	});

	describe('empty-mx enforce policy is a validation failure, not allow-all (RFC 8461 §3.2)', () => {
		it('parses an enforce body with no mx line as mode: none (fail closed)', () => {
			const policy = parseStsPolicy('version: STSv1\nmode: enforce\nmax_age: 86400', 'id-1');
			expect(policy.mode).toBe('none');
			expect(policy.mx).toEqual([]);
		});

		it('parses a testing body with no mx line as mode: none', () => {
			const policy = parseStsPolicy('version: STSv1\nmode: testing\nmax_age: 600', 'id-1');
			expect(policy.mode).toBe('none');
			expect(policy.mx).toEqual([]);
		});

		it('getStsTlsOptions does NOT enter enforce for a no-mx policy (no allow-all)', async () => {
			resolveTxtMock.mockResolvedValue(dnsRecord('id-1'));
			// Server advertises mode: enforce but lists ZERO mx hosts.
			stubFetch('version: STSv1\nmode: enforce\nmax_age: 86400');

			const opts = await getStsTlsOptions(redis, 'example.com');

			// Must fall back to opportunistic TLS rather than enforce-against-nothing.
			expect(opts.policyMode).toBe('none');
			expect(opts.requireTLS).toBe(false);
			expect(opts.rejectUnauthorized).toBe(false);
			expect(opts.allowedMxHosts).toEqual([]);
		});

		it('an enforce policy that DOES list an mx still enforces (guard is scoped to empty mx)', () => {
			const policy = parseStsPolicy(
				'version: STSv1\nmode: enforce\nmx: mail.example.com\nmax_age: 86400',
				'id-1'
			);
			expect(policy.mode).toBe('enforce');
			expect(policy.mx).toEqual(['mail.example.com']);
		});
	});

	describe('fetch / Redis error → fail-open to opportunistic TLS (no throw) (RFC 8461 §5)', () => {
		it('a thrown fetch yields policyMode none / requireTLS false and does NOT throw', async () => {
			resolveTxtMock.mockResolvedValue(dnsRecord('id-1'));
			vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));

			const opts = await getStsTlsOptions(redis, 'example.com');

			expect(opts.policyMode).toBe('none');
			expect(opts.requireTLS).toBe(false);
			expect(opts.rejectUnauthorized).toBe(false);
			expect(opts.allowedMxHosts).toEqual([]);
		});

		it('a Redis failure (cache read throws) fails open and does NOT throw', async () => {
			const brokenRedis = {
				get: vi.fn().mockRejectedValue(new Error('redis down')),
				set: vi.fn().mockRejectedValue(new Error('redis down')),
			} as unknown as RealRedis;

			const opts = await getStsTlsOptions(brokenRedis, 'example.com');

			expect(opts.policyMode).toBe('none');
			expect(opts.requireTLS).toBe(false);
			expect(opts.allowedMxHosts).toEqual([]);
		});
	});

	describe('absent policy → negative cache EX 3600, second call hits cache (RFC 8461 §5)', () => {
		it('caches the none result for 1h and serves the second lookup from cache (no second DNS hit)', async () => {
			resolveTxtMock.mockResolvedValue([]); // no _mta-sts TXT record
			const fetchSpy = stubFetch(policyBody());

			const first = await getStsTlsOptions(redis, 'no-sts.example.com');
			expect(first.policyMode).toBe('none');
			expect(fetchSpy).not.toHaveBeenCalled();

			// Negative result cached for exactly 3600s.
			const cacheKey = `${CACHE_PREFIX}no-sts.example.com`;
			const ttl = await redis.ttl(cacheKey);
			expect(ttl).toBeGreaterThan(3000);
			expect(ttl).toBeLessThanOrEqual(3600);
			const cached = JSON.parse((await redis.get(cacheKey))!);
			expect(cached.mode).toBe('none');

			// Second call hits the cache: the cached id ('') matches the (absent) DNS
			// id, so no HTTP fetch is performed.
			const second = await getStsTlsOptions(redis, 'no-sts.example.com');
			expect(second.policyMode).toBe('none');
			expect(fetchSpy).not.toHaveBeenCalled();
		});
	});
});
