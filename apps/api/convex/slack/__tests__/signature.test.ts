import { describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../../webhooks/security';
import { SLACK_SIGNATURE_TOLERANCE_SECONDS, verifySlackSignature } from '../signature';

const SECRET = 'slack-signing-secret';
const NOW_MS = 1_700_000_000_000;
const TIMESTAMP = Math.floor(NOW_MS / 1000); // seconds
const BODY = 'payload=%7B%22ok%22%3Atrue%7D';

async function sign(body: string, timestamp: number, secret = SECRET): Promise<string> {
	return `v0=${await hmacSha256Hex(secret, `v0:${timestamp}:${body}`)}`;
}

async function verify(overrides: Partial<Parameters<typeof verifySlackSignature>[0]> = {}) {
	return verifySlackSignature({
		signingSecret: SECRET,
		timestampHeader: String(TIMESTAMP),
		signatureHeader: await sign(BODY, TIMESTAMP),
		rawBody: BODY,
		nowMs: NOW_MS,
		...overrides,
	});
}

describe('verifySlackSignature — accepts a fresh, correctly-signed request', () => {
	it('passes for a valid signature within the window', async () => {
		expect(await verify()).toEqual({ ok: true });
	});
});

describe('verifySlackSignature — fails closed on configuration', () => {
	it('returns 503 when the signing secret is unset', async () => {
		const result = await verify({ signingSecret: undefined });
		expect(result).toMatchObject({ ok: false, status: 503 });
	});

	it('returns 503 when the signing secret is empty', async () => {
		const result = await verify({ signingSecret: '' });
		expect(result).toMatchObject({ ok: false, status: 503 });
	});
});

describe('verifySlackSignature — rejects bad signatures (401)', () => {
	it('rejects a tampered body', async () => {
		const result = await verify({ rawBody: 'payload=%7B%22ok%22%3Afalse%7D' });
		expect(result).toMatchObject({ ok: false, status: 401 });
	});

	it('rejects a signature made with the wrong secret', async () => {
		const result = await verify({ signatureHeader: await sign(BODY, TIMESTAMP, 'other-secret') });
		expect(result).toMatchObject({ ok: false, status: 401 });
	});

	it('rejects a missing signature header', async () => {
		expect(await verify({ signatureHeader: null })).toMatchObject({ ok: false, status: 401 });
		expect(await verify({ signatureHeader: '' })).toMatchObject({ ok: false, status: 401 });
	});
});

describe('verifySlackSignature — replay / freshness window (401)', () => {
	it('rejects a stale timestamp beyond tolerance (replay)', async () => {
		const stale = TIMESTAMP - SLACK_SIGNATURE_TOLERANCE_SECONDS - 1;
		const result = await verifySlackSignature({
			signingSecret: SECRET,
			timestampHeader: String(stale),
			signatureHeader: await sign(BODY, stale),
			rawBody: BODY,
			nowMs: NOW_MS,
		});
		expect(result).toMatchObject({ ok: false, status: 401 });
	});

	it('rejects a far-future timestamp beyond tolerance', async () => {
		const future = TIMESTAMP + SLACK_SIGNATURE_TOLERANCE_SECONDS + 1;
		const result = await verifySlackSignature({
			signingSecret: SECRET,
			timestampHeader: String(future),
			signatureHeader: await sign(BODY, future),
			rawBody: BODY,
			nowMs: NOW_MS,
		});
		expect(result).toMatchObject({ ok: false, status: 401 });
	});

	it('accepts a timestamp exactly at the tolerance edge', async () => {
		const edge = TIMESTAMP - SLACK_SIGNATURE_TOLERANCE_SECONDS;
		const result = await verifySlackSignature({
			signingSecret: SECRET,
			timestampHeader: String(edge),
			signatureHeader: await sign(BODY, edge),
			rawBody: BODY,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ ok: true });
	});

	it('rejects a malformed (non-numeric / missing) timestamp', async () => {
		expect(await verify({ timestampHeader: 'not-a-number' })).toMatchObject({
			ok: false,
			status: 401,
		});
		expect(await verify({ timestampHeader: null })).toMatchObject({ ok: false, status: 401 });
		expect(await verify({ timestampHeader: '' })).toMatchObject({ ok: false, status: 401 });
	});
});

describe('verifySlackSignature — captured-then-tampered timestamp', () => {
	it('rejects when the timestamp is swapped but the old signature is replayed', async () => {
		// Attacker keeps the old signature (still fresh window) but re-labels the
		// request with a new timestamp to move it inside the window: the signature
		// no longer matches the base string, so it is rejected.
		const oldSignature = await sign(BODY, TIMESTAMP - 10);
		const result = await verifySlackSignature({
			signingSecret: SECRET,
			timestampHeader: String(TIMESTAMP),
			signatureHeader: oldSignature,
			rawBody: BODY,
			nowMs: NOW_MS,
		});
		expect(result).toMatchObject({ ok: false, status: 401 });
	});
});
