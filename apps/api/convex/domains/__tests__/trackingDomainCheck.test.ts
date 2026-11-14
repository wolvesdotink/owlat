/**
 * The tracking-domain check's two lookups (`domains/trackingDomainCheck.ts`):
 * the DNS-over-HTTPS CNAME read and the HTTPS probe, each with its fetch
 * stubbed, so every way a host can fail is classified without a network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookupTrackingCname, probeTrackingHost } from '../trackingDomainCheck';
import { trackingProbeAnswer } from '../../delivery/trackingProbe';
import { FetchGuardError, RedirectRefusedError, SsrfBlockedError } from '../../lib/ssrfGuard';

const SECRET = 'probe-test-secret';
const NONCE = '0123456789abcdef0123456789abcdef';
const DOMAIN = 'track.example.com';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('probeTrackingHost', () => {
	const answer = () => trackingProbeAnswer(SECRET, NONCE);

	it('accepts this deployment’s answer, asked over HTTPS on the tracking host', async () => {
		const fetchFn = vi.fn(async () => new Response(await answer(), { status: 200 }));
		await expect(probeTrackingHost(DOMAIN, SECRET, NONCE, fetchFn)).resolves.toBe('ok');
		expect(fetchFn).toHaveBeenCalledWith(
			`https://${DOMAIN}/t/probe/${NONCE}`,
			expect.objectContaining({ protocols: ['https:'] })
		);
	});

	it('reports a TLS or certificate failure as unreachable', async () => {
		const fetchFn = vi.fn(async () => {
			throw new TypeError('fetch failed', {
				cause: Object.assign(new Error('unable to verify the first certificate'), {
					code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
				}),
			});
		});
		await expect(probeTrackingHost(DOMAIN, SECRET, NONCE, fetchFn)).resolves.toBe('unreachable');
	});

	it('reports a host on a private address as unreachable', async () => {
		const fetchFn = vi.fn(async () => {
			throw new SsrfBlockedError('blocked');
		});
		await expect(probeTrackingHost(DOMAIN, SECRET, NONCE, fetchFn)).resolves.toBe('unreachable');
	});

	it('reports another site on the host as the wrong response', async () => {
		const wrongBody = vi.fn(async () => new Response('<html>parked</html>', { status: 200 }));
		const notFound = vi.fn(async () => new Response('Not found', { status: 404 }));
		const redirect = vi.fn(async () => {
			throw new RedirectRefusedError('redirect');
		});
		for (const fetchFn of [wrongBody, notFound, redirect]) {
			await expect(probeTrackingHost(DOMAIN, SECRET, NONCE, fetchFn)).resolves.toBe(
				'wrong_response'
			);
		}
	});

	it('rejects an answer computed with another deployment’s secret', async () => {
		const other = await trackingProbeAnswer('another-instance', NONCE);
		const fetchFn = vi.fn(async () => new Response(other, { status: 200 }));
		await expect(probeTrackingHost(DOMAIN, SECRET, NONCE, fetchFn)).resolves.toBe('wrong_response');
	});

	it('never puts anything but a hostname into the probe URL', async () => {
		const fetchFn = vi.fn(async () => new Response(await answer(), { status: 200 }));
		for (const domain of ['127.0.0.1:3211', 'user@internal.example', 'example.com/t/c']) {
			await expect(probeTrackingHost(domain, SECRET, NONCE, fetchFn)).resolves.toBe('unreachable');
		}
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('is unanswered when the host does not resolve for the fetch, or the probe is rate limited', async () => {
		const unresolved = vi.fn(async () => {
			throw new FetchGuardError('Failed to resolve URL hostname');
		});
		const limited = vi.fn(async () => new Response('Too many requests', { status: 429 }));
		await expect(probeTrackingHost(DOMAIN, SECRET, NONCE, unresolved)).resolves.toBe('unanswered');
		await expect(probeTrackingHost(DOMAIN, SECRET, NONCE, limited)).resolves.toBe('unanswered');
	});
});

describe('lookupTrackingCname', () => {
	const dohAnswer = (body: unknown, status = 200) =>
		vi.fn(async () => new Response(JSON.stringify(body), { status }));

	it('matches the expected target, trailing dot and case aside', async () => {
		vi.stubGlobal(
			'fetch',
			dohAnswer({ Status: 0, Answer: [{ type: 5, data: 'Site.Example.NET.' }] })
		);
		await expect(lookupTrackingCname(DOMAIN, 'site.example.net')).resolves.toBe('match');
	});

	it('is a mismatch when the resolver answers with no or another CNAME', async () => {
		vi.stubGlobal(
			'fetch',
			dohAnswer({ Status: 0, Answer: [{ type: 5, data: 'elsewhere.example.' }] })
		);
		await expect(lookupTrackingCname(DOMAIN, 'site.example.net')).resolves.toBe('mismatch');
		vi.stubGlobal('fetch', dohAnswer({ Status: 3 }));
		await expect(lookupTrackingCname(DOMAIN, 'site.example.net')).resolves.toBe('mismatch');
	});

	it('is unanswered when the resolver fails', async () => {
		vi.stubGlobal('fetch', dohAnswer({ Status: 2 }));
		await expect(lookupTrackingCname(DOMAIN, 'site.example.net')).resolves.toBe('unanswered');
		vi.stubGlobal('fetch', dohAnswer({}, 503));
		await expect(lookupTrackingCname(DOMAIN, 'site.example.net')).resolves.toBe('unanswered');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('fetch failed');
			})
		);
		await expect(lookupTrackingCname(DOMAIN, 'site.example.net')).resolves.toBe('unanswered');
	});
});
