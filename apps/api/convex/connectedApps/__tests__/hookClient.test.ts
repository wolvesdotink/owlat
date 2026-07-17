/**
 * Signed synchronous-hook TRANSPORT. Drives the real signed round trip (real Web
 * Crypto on both sides) with only the socket (fetchGuarded) mocked, so every
 * outcome — success and each failure/fallback path — is deterministic without
 * real network or DNS: the request is SSRF-guarded, https-only, deadline-bounded
 * and signed; a valid, fresh, correctly-signed, right-shaped response is ok;
 * SSRF-blocked / redirect / timeout / network / bad-status / oversized /
 * unsigned / wrong-secret / mismatched-nonce (replay) / stale / bad-JSON /
 * wrong-shape responses all map to typed errors and NEVER throw.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '@owlat/plugin-kit';
import { RedirectRefusedError, SsrfBlockedError } from '../../lib/ssrfGuard';
import { signHookResponse } from '../hookSignature';
import type { ConnectedAppHookKind } from '../hookProtocol';

const guard = vi.hoisted(() => ({ fetchGuarded: vi.fn() }));
vi.mock('../../lib/ssrfGuard', async () => ({
	...(await vi.importActual('../../lib/ssrfGuard')),
	fetchGuarded: guard.fetchGuarded,
}));

const { callConnectedAppHook } = await import('../hookClient');

const SECRET = 'cah_transport-secret';
const APP_ID = 'app_transport';
const ENDPOINT = 'https://hooks.example.com/owlat';
const NOW_MS = 1_700_000_000_000;
const NONCE = 'fixed-request-nonce';
const DEPS = { now: () => NOW_MS, nonce: () => NONCE };
const encodeUtf8 = (s: string) => new TextEncoder().encode(s);

function streamResponse(status: number, bodyBytes: Uint8Array, headers: Headers): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bodyBytes);
			controller.close();
		},
	});
	return { status, body, headers } as unknown as Response;
}

interface SignOpts {
	readonly status?: number;
	readonly nonce?: string;
	readonly secret?: string;
	readonly tsSeconds?: number;
	readonly omitSignature?: boolean;
}

/**
 * Stub fetchGuarded to reply like a connected app: read the request headers, sign
 * a response body bound to the request nonce with the shared secret, and stream
 * it back. `opts` lets a test forge each defense's failure (wrong secret, wrong
 * nonce, stale timestamp, missing signature).
 */
function respondWith(body: unknown, opts: SignOpts = {}): void {
	guard.fetchGuarded.mockImplementation(async (_url: unknown, init: unknown) => {
		const headers = (init as { headers: Record<string, string> }).headers;
		const hookKind = headers['x-owlat-hook'] as ConnectedAppHookKind;
		const appId = headers['x-owlat-hook-app']!;
		const nonce = opts.nonce ?? headers['x-owlat-hook-nonce']!;
		const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
		const bodyBytes = encodeUtf8(bodyStr);
		const tsSeconds = opts.tsSeconds ?? Math.floor(NOW_MS / 1000);
		const signature = await signHookResponse(opts.secret ?? SECRET, {
			hookKind,
			connectedAppId: appId,
			nonce,
			timestampSeconds: tsSeconds,
			bodyBytes,
		});
		const respHeaders = new Headers();
		if (!opts.omitSignature) respHeaders.set('x-owlat-hook-signature', signature);
		respHeaders.set('x-owlat-hook-timestamp', String(tsSeconds));
		return streamResponse(opts.status ?? 200, bodyBytes, respHeaders);
	});
}

function runHook(hookKind: ConnectedAppHookKind, payload: JsonObject = {}) {
	return callConnectedAppHook(
		{ connectedAppId: APP_ID, endpointUrl: ENDPOINT, secret: SECRET, hookKind, payload },
		DEPS
	);
}

beforeEach(() => {
	guard.fetchGuarded.mockReset();
});

describe('successful hooks', () => {
	it('returns the validated draft and signs the request through the SSRF guard', async () => {
		respondWith({ draft: 'Proposed reply.' });
		const result = await runHook('draft');
		expect(result).toEqual({
			status: 'ok',
			result: { hookKind: 'draft', draft: 'Proposed reply.' },
		});

		expect(guard.fetchGuarded).toHaveBeenCalledTimes(1);
		const [url, init] = guard.fetchGuarded.mock.calls[0]!;
		expect(url).toBe(ENDPOINT);
		expect(init.protocols).toEqual(['https:']);
		expect(init.method).toBe('POST');
		expect(init.signal).toBeInstanceOf(AbortSignal);
		const headers = init.headers as Record<string, string>;
		expect(headers['x-owlat-hook']).toBe('draft');
		expect(headers['x-owlat-hook-app']).toBe(APP_ID);
		expect(headers['x-owlat-hook-nonce']).toBe(NONCE);
		expect(headers['x-owlat-hook-signature']).toMatch(/^v1=[0-9a-f]{64}$/);
	});

	it('returns a restrict-only gate verdict (no-objection and objection)', async () => {
		respondWith({ outcome: 'no-objection' });
		expect(await runHook('gate')).toEqual({
			status: 'ok',
			result: { hookKind: 'gate', gate: { outcome: 'no-objection' } },
		});
		respondWith({ outcome: 'objection', reason: 'quiet hours' });
		expect(await runHook('gate')).toEqual({
			status: 'ok',
			result: { hookKind: 'gate', gate: { outcome: 'objection', reason: 'quiet hours' } },
		});
	});

	it('returns a bounded score', async () => {
		respondWith({ score: 0.8, reason: 'looks spammy' });
		expect(await runHook('score')).toEqual({
			status: 'ok',
			result: { hookKind: 'score', score: 0.8, reason: 'looks spammy' },
		});
	});
});

describe('network-layer failures (never throw)', () => {
	it('maps an SSRF block, a refused redirect, a timeout, and a generic error', async () => {
		guard.fetchGuarded.mockRejectedValueOnce(new SsrfBlockedError('blocked'));
		expect(await runHook('gate')).toMatchObject({ status: 'error', code: 'blocked_ssrf' });

		guard.fetchGuarded.mockRejectedValueOnce(new RedirectRefusedError('redirect'));
		expect(await runHook('gate')).toMatchObject({ status: 'error', code: 'redirect_refused' });

		const timeout = new Error('timed out');
		timeout.name = 'TimeoutError';
		guard.fetchGuarded.mockRejectedValueOnce(timeout);
		expect(await runHook('gate')).toMatchObject({ status: 'error', code: 'timeout' });

		guard.fetchGuarded.mockRejectedValueOnce(new Error('socket hang up'));
		expect(await runHook('gate')).toMatchObject({ status: 'error', code: 'network_error' });
	});

	it('rejects a non-2xx status', async () => {
		guard.fetchGuarded.mockResolvedValueOnce(streamResponse(503, encodeUtf8(''), new Headers()));
		expect(await runHook('gate')).toMatchObject({ status: 'error', code: 'bad_status' });
	});
});

describe('size limits', () => {
	it('refuses an over-large request BEFORE any network call', async () => {
		const huge = { blob: 'x'.repeat(70 * 1024) };
		expect(await runHook('draft', huge)).toMatchObject({
			status: 'error',
			code: 'request_too_large',
		});
		expect(guard.fetchGuarded).not.toHaveBeenCalled();
	});

	it('rejects an over-large response body', async () => {
		const headers = new Headers();
		headers.set('x-owlat-hook-timestamp', String(Math.floor(NOW_MS / 1000)));
		headers.set('x-owlat-hook-signature', 'v1=deadbeef');
		guard.fetchGuarded.mockResolvedValueOnce(
			streamResponse(200, new Uint8Array(65 * 1024 + 1), headers)
		);
		expect(await runHook('gate')).toMatchObject({ status: 'error', code: 'response_too_large' });
	});
});

describe('response authentication and replay defense', () => {
	it('rejects a missing signature (fail closed)', async () => {
		respondWith({ outcome: 'no-objection' }, { omitSignature: true });
		expect(await runHook('gate')).toMatchObject({ status: 'error', code: 'signature_missing' });
	});

	it('rejects a signature made with the wrong secret', async () => {
		respondWith({ outcome: 'no-objection' }, { secret: 'attacker-secret' });
		expect(await runHook('gate')).toMatchObject({ status: 'error', code: 'signature_mismatch' });
	});

	it('rejects a response bound to a DIFFERENT request nonce (replay)', async () => {
		respondWith({ outcome: 'no-objection' }, { nonce: 'some-other-request-nonce' });
		expect(await runHook('gate')).toMatchObject({ status: 'error', code: 'signature_mismatch' });
	});

	it('rejects a correctly-signed but STALE response', async () => {
		const staleTs = Math.floor((NOW_MS - 120_000) / 1000);
		respondWith({ outcome: 'no-objection' }, { tsSeconds: staleTs });
		expect(await runHook('gate')).toMatchObject({ status: 'error', code: 'stale_response' });
	});
});

describe('response body validation', () => {
	it('rejects non-JSON and wrong-shape bodies (both correctly signed)', async () => {
		respondWith('this is not json');
		expect(await runHook('gate')).toMatchObject({ status: 'error', code: 'invalid_json' });

		respondWith({ draft: '' });
		expect(await runHook('draft')).toMatchObject({ status: 'error', code: 'invalid_response' });

		respondWith({ outcome: 'approve' });
		expect(await runHook('gate')).toMatchObject({ status: 'error', code: 'invalid_response' });
	});
});
