import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signMtaRequest } from '@owlat/mta-protocol/signer';
import {
	MTA_EVENT_TOLERANCE_SECONDS,
	MTA_REQUEST_TOLERANCE_SECONDS,
	readMtaSignatureHeaders,
	verifyMtaSignedRequest,
} from '../mtaSignature';

const SECRET = 'mta-test-secret';
const NOW_SECONDS = 1_800_000_000;
const NOW_MS = NOW_SECONDS * 1000;
const BODY = '{"event":"bounced","messageId":"m1","bounceType":"hard"}';

function sign(timestamp: string, body: string = BODY): string {
	return createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
}

function signedRequest(timestamp: string, signature = sign(timestamp)): Request {
	return new Request('https://api.example.test/webhooks/mta', {
		method: 'POST',
		headers: { 'x-mta-timestamp': timestamp, 'x-mta-signature': signature },
		body: BODY,
	});
}

function verify(request: Request, toleranceSeconds: number, body: string = BODY) {
	return verifyMtaSignedRequest(request, body, { secret: SECRET, toleranceSeconds, nowMs: NOW_MS });
}

describe('verifyMtaSignedRequest', () => {
	it('accepts a fresh, correctly signed request', async () => {
		expect(await verify(signedRequest(String(NOW_SECONDS)), 60)).toEqual({ ok: true });
	});

	it('accepts what signMtaRequest produces', async () => {
		const headers = signMtaRequest(SECRET, BODY, NOW_MS);
		const request = new Request('https://api.example.test/webhooks/mta', {
			method: 'POST',
			headers,
			body: BODY,
		});
		expect(await verify(request, 60)).toEqual({ ok: true });
	});

	it('rejects a tampered body', async () => {
		expect(await verify(signedRequest(String(NOW_SECONDS)), 60, `${BODY} `)).toEqual({
			ok: false,
			reason: 'invalid_signature',
		});
	});

	it('rejects a request without both headers', async () => {
		const request = new Request('https://api.example.test/webhooks/mta', {
			method: 'POST',
			headers: { 'x-mta-signature': sign(String(NOW_SECONDS)) },
			body: BODY,
		});
		expect(await verify(request, 60)).toEqual({ ok: false, reason: 'missing_headers' });
	});

	// Each of these is signed correctly over its own timestamp string, so only
	// the timestamp rule decides the verdict.
	it.each([
		['trailing letters', `${NOW_SECONDS}abc`],
		['a fraction', `${NOW_SECONDS}.0`],
		['a leading plus', `+${NOW_SECONDS}`],
		['exponent form', '1.8e9'],
		['a negative value', '-5'],
		['an empty value', ''],
		['more digits than a safe integer', '9'.repeat(16)],
	])('rejects a timestamp with %s', async (_label, timestamp) => {
		const verdict = await verify(signedRequest(timestamp), MTA_EVENT_TOLERANCE_SECONDS);
		expect(verdict.ok).toBe(false);
	});

	it('enforces the window the caller states, in both directions', async () => {
		const past = String(NOW_SECONDS - 90);
		const future = String(NOW_SECONDS + 90);
		expect(await verify(signedRequest(past), MTA_REQUEST_TOLERANCE_SECONDS)).toEqual({
			ok: false,
			reason: 'invalid_timestamp',
		});
		expect(await verify(signedRequest(future), MTA_REQUEST_TOLERANCE_SECONDS)).toEqual({
			ok: false,
			reason: 'invalid_timestamp',
		});
		expect(await verify(signedRequest(past), MTA_EVENT_TOLERANCE_SECONDS)).toEqual({ ok: true });
		expect(await verify(signedRequest(future), MTA_EVENT_TOLERANCE_SECONDS)).toEqual({
			ok: true,
		});
		const stale = String(NOW_SECONDS - MTA_EVENT_TOLERANCE_SECONDS - 1);
		expect(await verify(signedRequest(stale), MTA_EVENT_TOLERANCE_SECONDS)).toEqual({
			ok: false,
			reason: 'invalid_timestamp',
		});
	});

	it('keeps the windows the routes rely on', () => {
		expect(MTA_EVENT_TOLERANCE_SECONDS).toBe(300);
		expect(MTA_REQUEST_TOLERANCE_SECONDS).toBe(60);
	});
});

describe('readMtaSignatureHeaders', () => {
	it('returns the headers when they are present and fresh', () => {
		const timestamp = String(NOW_SECONDS);
		expect(
			readMtaSignatureHeaders(signedRequest(timestamp), { toleranceSeconds: 60, nowMs: NOW_MS })
		).toEqual({ ok: true, timestamp, signature: sign(timestamp) });
	});

	it('refuses a stale timestamp before any body is read', () => {
		expect(
			readMtaSignatureHeaders(signedRequest(String(NOW_SECONDS - 61)), {
				toleranceSeconds: 60,
				nowMs: NOW_MS,
			})
		).toEqual({ ok: false, reason: 'invalid_timestamp' });
	});
});
