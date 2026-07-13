/**
 * Live-gather unit tests for the MTA-STS verifier (`domains/mtaStsVerify.ts`).
 *
 * The `verifyReceivingMtaSts` action itself is thin glue (admin gate + read the
 * expected policy + gather observations + delegate to the pure, separately
 * tested `verifyMtaStsPublication`). The behaviour worth asserting is the
 * GATHER: the SSRF guards, the fail-soft nulls on DNS/fetch errors, the RFC 1035
 * multi-chunk TXT joining and the streamed body-size cap. Those live in the
 * exported `resolveMtaStsTxt` / `fetchMtaStsPolicyBody` helpers, whose DNS +
 * HTTPS calls are injected via `MtaStsGatherDeps` (the same dependency-injection
 * pattern as `reverseDns.ts`), so this exercises every path without a network.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	resolveMtaStsTxt,
	fetchMtaStsPolicyBody,
	isPublicUnicastAddress,
	type MtaStsGatherDeps,
} from '../mtaStsVerify';

/** A stream of `bytes` (optionally chunked) so the size cap can be exercised. */
function streamOf(bytes: Uint8Array, chunkSize = bytes.length): ReadableStream<Uint8Array> {
	let offset = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			const end = Math.min(offset + chunkSize, bytes.length);
			controller.enqueue(bytes.slice(offset, end));
			offset = end;
		},
	});
}

/** Build gather deps from simple fakes; unused ones throw if unexpectedly hit. */
function makeDeps(overrides: Partial<MtaStsGatherDeps>): MtaStsGatherDeps {
	return {
		resolveTxt: overrides.resolveTxt ?? vi.fn(async () => [] as string[][]),
		// Default: the host resolves to a public address so the SSRF guard passes.
		lookup: overrides.lookup ?? vi.fn(async () => [{ address: '93.184.216.34' }]),
		fetch: overrides.fetch ?? vi.fn(async () => new Response(null, { status: 500 })),
	};
}

describe('resolveMtaStsTxt (RFC 1035 TXT gather)', () => {
	it('returns null and never queries DNS for an invalid domain (SSRF guard)', async () => {
		const resolveTxt = vi.fn(async () => [['v=STSv1; id=abc']]);
		const result = await resolveMtaStsTxt('not a domain/../evil', makeDeps({ resolveTxt }));
		expect(result).toBeNull();
		expect(resolveTxt).not.toHaveBeenCalled();
	});

	it('joins multi-string TXT chunks into one record (RFC 1035)', async () => {
		const resolveTxt = vi.fn(async () => [['v=STSv1;', ' id=abcd1234abcd1234']]);
		const result = await resolveMtaStsTxt('example.com', makeDeps({ resolveTxt }));
		expect(resolveTxt).toHaveBeenCalledWith('_mta-sts.example.com');
		expect(result).toBe('v=STSv1; id=abcd1234abcd1234');
	});

	it('prefers the STSv1 record when several TXT records exist', async () => {
		const resolveTxt = vi.fn(async () => [['some other txt'], ['v=STSv1; id=zzzz']]);
		const result = await resolveMtaStsTxt('example.com', makeDeps({ resolveTxt }));
		expect(result).toBe('v=STSv1; id=zzzz');
	});

	it('is fail-soft: a DNS error resolves to null, never a throw', async () => {
		const resolveTxt = vi.fn(async () => {
			throw new Error('ENOTFOUND');
		});
		await expect(resolveMtaStsTxt('example.com', makeDeps({ resolveTxt }))).resolves.toBeNull();
	});
});

describe('fetchMtaStsPolicyBody (HTTPS policy gather)', () => {
	const BODY = 'version: STSv1\r\nmode: enforce\r\nmx: mail.example.com\r\nmax_age: 604800\r\n';

	it('returns null and never fetches for an invalid domain (SSRF guard)', async () => {
		const fetchFn = vi.fn(async () => new Response(BODY));
		const result = await fetchMtaStsPolicyBody('bad_domain..', makeDeps({ fetch: fetchFn }));
		expect(result).toBeNull();
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('rejects a host resolving to a private address without fetching (SSRF guard)', async () => {
		const fetchFn = vi.fn(async () => new Response(BODY));
		const lookup = vi.fn(async () => [{ address: '10.0.0.5' }]);
		const result = await fetchMtaStsPolicyBody('example.com', makeDeps({ lookup, fetch: fetchFn }));
		expect(result).toBeNull();
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('fetches the well-known policy from the mta-sts host and returns the body', async () => {
		const fetchFn = vi.fn(
			async () => new Response(BODY, { headers: { 'content-length': String(BODY.length) } })
		);
		const result = await fetchMtaStsPolicyBody('example.com', makeDeps({ fetch: fetchFn }));
		expect(fetchFn).toHaveBeenCalledWith(
			'https://mta-sts.example.com/.well-known/mta-sts.txt',
			expect.objectContaining({ redirect: 'error' })
		);
		expect(result).toBe(BODY);
	});

	it('is fail-soft: a non-2xx response resolves to null', async () => {
		const fetchFn = vi.fn(async () => new Response(null, { status: 404 }));
		await expect(
			fetchMtaStsPolicyBody('example.com', makeDeps({ fetch: fetchFn }))
		).resolves.toBeNull();
	});

	it('is fail-soft: a network/redirect error resolves to null, never a throw', async () => {
		const fetchFn = vi.fn(async () => {
			throw new Error('redirect not allowed');
		});
		await expect(
			fetchMtaStsPolicyBody('example.com', makeDeps({ fetch: fetchFn }))
		).resolves.toBeNull();
	});

	it('rejects early when Content-Length advertises an oversized body', async () => {
		const fetchFn = vi.fn(
			async () => new Response('small', { headers: { 'content-length': String(200_000) } })
		);
		await expect(
			fetchMtaStsPolicyBody('example.com', makeDeps({ fetch: fetchFn }))
		).resolves.toBeNull();
	});

	it('enforces the size cap while streaming even when Content-Length lies', async () => {
		// 128 KB body (over the 64 KB cap) but a Content-Length claiming 10 bytes,
		// so the early check passes and only the streamed running count catches it.
		const big = new Uint8Array(128 * 1024).fill(97);
		const fetchFn = vi.fn(
			async () => new Response(streamOf(big, 16 * 1024), { headers: { 'content-length': '10' } })
		);
		await expect(
			fetchMtaStsPolicyBody('example.com', makeDeps({ fetch: fetchFn }))
		).resolves.toBeNull();
	});
});

describe('isPublicUnicastAddress', () => {
	it('accepts public unicast addresses', () => {
		expect(isPublicUnicastAddress('93.184.216.34')).toBe(true);
		expect(isPublicUnicastAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(true);
	});

	it('rejects private, loopback, link-local, CGNAT and unique-local ranges', () => {
		expect(isPublicUnicastAddress('10.0.0.1')).toBe(false);
		expect(isPublicUnicastAddress('172.16.5.4')).toBe(false);
		expect(isPublicUnicastAddress('192.168.1.1')).toBe(false);
		expect(isPublicUnicastAddress('127.0.0.1')).toBe(false);
		expect(isPublicUnicastAddress('169.254.1.1')).toBe(false);
		expect(isPublicUnicastAddress('100.64.0.1')).toBe(false);
		expect(isPublicUnicastAddress('::1')).toBe(false);
		expect(isPublicUnicastAddress('::')).toBe(false);
		expect(isPublicUnicastAddress('fe80::1')).toBe(false);
		expect(isPublicUnicastAddress('fd00::1')).toBe(false);
		expect(isPublicUnicastAddress('ff02::1')).toBe(false);
		expect(isPublicUnicastAddress('::ffff:10.0.0.1')).toBe(false);
	});

	it('rejects a non-IP string', () => {
		expect(isPublicUnicastAddress('not-an-ip')).toBe(false);
	});
});
