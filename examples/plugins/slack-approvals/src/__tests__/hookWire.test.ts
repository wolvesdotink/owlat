import { describe, expect, it } from 'vitest';
import { MAX_RAW_BODY_BYTES } from '../bodyLimit';
import { hmacSha256Hex, sha256Hex } from '../crypto';
import {
	createNonceGuard,
	OWLAT_HOOK_HEADERS,
	OWLAT_HOOK_REQUEST_TOLERANCE_SECONDS,
	signOwlatHookResponse,
	verifyOwlatHookRequest,
	type OwlatHookKind,
} from '../hookWire';

const SECRET = 'shared-hook-secret';
const APP_ID = 'app-123';
const NONCE = 'nonce-abc';
const TS = 1_700_000_000;
const NOW_MS = TS * 1000;

/**
 * Build a request signed EXACTLY the way Owlat's `hookClient`/`hookSignature`
 * does — the canonical string is spelled out here independently of `hookWire`'s
 * own builder, so this doubles as a PP-24 wire-conformance check.
 */
async function owlatSignedRequest(opts?: {
	secret?: string;
	appId?: string;
	hookKind?: OwlatHookKind;
	nonce?: string;
	timestampSeconds?: number;
	rawBody?: string;
	version?: string;
}) {
	const secret = opts?.secret ?? SECRET;
	const appId = opts?.appId ?? APP_ID;
	const hookKind = opts?.hookKind ?? 'gate';
	const nonce = opts?.nonce ?? NONCE;
	const timestampSeconds = opts?.timestampSeconds ?? TS;
	const rawBody =
		opts?.rawBody ??
		JSON.stringify({
			hookKind,
			protocolVersion: 'v1',
			connectedAppId: appId,
			timestampSeconds,
			nonce,
			payload: { messageId: 'm-1' },
		});
	const bodyBytes = new TextEncoder().encode(rawBody);
	const signingString = [
		'owlat.hook.request.v1',
		hookKind,
		appId,
		String(timestampSeconds),
		nonce,
		await sha256Hex(bodyBytes),
	].join('\n');
	const signature = `v1=${await hmacSha256Hex(secret, signingString)}`;
	return {
		rawBody,
		headers: {
			[OWLAT_HOOK_HEADERS.kind]: hookKind,
			[OWLAT_HOOK_HEADERS.version]: opts?.version ?? 'v1',
			[OWLAT_HOOK_HEADERS.appId]: appId,
			[OWLAT_HOOK_HEADERS.timestamp]: String(timestampSeconds),
			[OWLAT_HOOK_HEADERS.nonce]: nonce,
			[OWLAT_HOOK_HEADERS.signature]: signature,
		},
	};
}

describe('verifyOwlatHookRequest', () => {
	it('verifies a request signed with Owlat’s canonical scheme', async () => {
		const req = await owlatSignedRequest();
		const result = await verifyOwlatHookRequest({
			secret: SECRET,
			expectedAppId: APP_ID,
			headers: req.headers,
			rawBody: req.rawBody,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({
			valid: true,
			request: { hookKind: 'gate', connectedAppId: APP_ID, nonce: NONCE, timestampSeconds: TS },
		});
	});

	it('rejects the wrong protocol version', async () => {
		const req = await owlatSignedRequest({ version: 'v2' });
		const result = await verifyOwlatHookRequest({
			secret: SECRET,
			expectedAppId: APP_ID,
			headers: req.headers,
			rawBody: req.rawBody,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ valid: false, reason: 'bad_version' });
	});

	it('rejects a request addressed to a different app id', async () => {
		const req = await owlatSignedRequest();
		const result = await verifyOwlatHookRequest({
			secret: SECRET,
			expectedAppId: 'someone-else',
			headers: req.headers,
			rawBody: req.rawBody,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ valid: false, reason: 'foreign_app' });
	});

	it('rejects a stale timestamp beyond the tolerance window', async () => {
		const req = await owlatSignedRequest();
		const result = await verifyOwlatHookRequest({
			secret: SECRET,
			expectedAppId: APP_ID,
			headers: req.headers,
			rawBody: req.rawBody,
			nowMs: NOW_MS + (OWLAT_HOOK_REQUEST_TOLERANCE_SECONDS + 1) * 1000,
		});
		expect(result).toEqual({ valid: false, reason: 'stale_timestamp' });
	});

	it('reports an ABSENT timestamp header as missing_timestamp', async () => {
		const req = await owlatSignedRequest();
		const headers = { ...req.headers, [OWLAT_HOOK_HEADERS.timestamp]: '' };
		const result = await verifyOwlatHookRequest({
			secret: SECRET,
			expectedAppId: APP_ID,
			headers,
			rawBody: req.rawBody,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ valid: false, reason: 'missing_timestamp' });
	});

	it('reports a WHITESPACE-only timestamp header as missing_timestamp (mirrors Slack)', async () => {
		const req = await owlatSignedRequest();
		const headers = { ...req.headers, [OWLAT_HOOK_HEADERS.timestamp]: '   ' };
		const result = await verifyOwlatHookRequest({
			secret: SECRET,
			expectedAppId: APP_ID,
			headers,
			rawBody: req.rawBody,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ valid: false, reason: 'missing_timestamp' });
	});

	it('reports a PRESENT-but-garbage timestamp header as malformed_timestamp', async () => {
		const req = await owlatSignedRequest();
		const headers = { ...req.headers, [OWLAT_HOOK_HEADERS.timestamp]: 'not-a-number' };
		const result = await verifyOwlatHookRequest({
			secret: SECRET,
			expectedAppId: APP_ID,
			headers,
			rawBody: req.rawBody,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ valid: false, reason: 'malformed_timestamp' });
	});

	it('rejects a tampered body (signature no longer covers it)', async () => {
		const req = await owlatSignedRequest();
		const result = await verifyOwlatHookRequest({
			secret: SECRET,
			expectedAppId: APP_ID,
			headers: req.headers,
			rawBody: `${req.rawBody} `,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ valid: false, reason: 'signature_mismatch' });
	});

	it('rejects a forged signature from the wrong secret', async () => {
		const req = await owlatSignedRequest({ secret: 'attacker' });
		const result = await verifyOwlatHookRequest({
			secret: SECRET,
			expectedAppId: APP_ID,
			headers: req.headers,
			rawBody: req.rawBody,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ valid: false, reason: 'signature_mismatch' });
	});

	it('rejects a missing signature header', async () => {
		const req = await owlatSignedRequest();
		const headers = { ...req.headers, [OWLAT_HOOK_HEADERS.signature]: '' };
		const result = await verifyOwlatHookRequest({
			secret: SECRET,
			expectedAppId: APP_ID,
			headers,
			rawBody: req.rawBody,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ valid: false, reason: 'missing_signature' });
	});

	it('rejects an over-cap body before any signature work runs', async () => {
		// A body signed exactly the way Owlat would, but over the cap: it would
		// otherwise verify, so a body_too_large result proves the length guard runs
		// ahead of the SHA-256/HMAC.
		const huge = 'x'.repeat(MAX_RAW_BODY_BYTES + 1);
		const req = await owlatSignedRequest({ rawBody: huge });
		const result = await verifyOwlatHookRequest({
			secret: SECRET,
			expectedAppId: APP_ID,
			headers: req.headers,
			rawBody: req.rawBody,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ valid: false, reason: 'body_too_large' });
	});

	it('rejects a replayed nonce when a nonce guard is supplied', async () => {
		const req = await owlatSignedRequest();
		const nonceGuard = createNonceGuard();
		const first = await verifyOwlatHookRequest({
			secret: SECRET,
			expectedAppId: APP_ID,
			headers: req.headers,
			rawBody: req.rawBody,
			nowMs: NOW_MS,
			nonceGuard,
		});
		expect(first.valid).toBe(true);
		const replay = await verifyOwlatHookRequest({
			secret: SECRET,
			expectedAppId: APP_ID,
			headers: req.headers,
			rawBody: req.rawBody,
			nowMs: NOW_MS,
			nonceGuard,
		});
		expect(replay).toEqual({ valid: false, reason: 'replayed_nonce' });
	});
});

describe('signOwlatHookResponse', () => {
	it('produces a response signature Owlat’s response scheme will verify', async () => {
		const body = JSON.stringify({ outcome: 'no-objection' });
		const responseTs = TS + 1;
		const signed = await signOwlatHookResponse({
			secret: SECRET,
			hookKind: 'gate',
			connectedAppId: APP_ID,
			requestNonce: NONCE,
			responseTimestampSeconds: responseTs,
			body,
		});

		// Independently recompute the expected signature per Owlat's documented
		// RESPONSE signing string (nonce echoes the request; timestamp is the
		// response's own), proving byte-level interop.
		const bodyBytes = new TextEncoder().encode(body);
		const expectedSigningString = [
			'owlat.hook.response.v1',
			'gate',
			APP_ID,
			NONCE,
			String(responseTs),
			await sha256Hex(bodyBytes),
		].join('\n');
		const expected = `v1=${await hmacSha256Hex(SECRET, expectedSigningString)}`;

		expect(signed.headers[OWLAT_HOOK_HEADERS.signature]).toBe(expected);
		expect(signed.headers[OWLAT_HOOK_HEADERS.timestamp]).toBe(String(responseTs));
		expect(signed.headers[OWLAT_HOOK_HEADERS.appId]).toBe(APP_ID);
		expect(signed.headers[OWLAT_HOOK_HEADERS.kind]).toBe('gate');
		expect(signed.body).toBe(body);
	});
});
