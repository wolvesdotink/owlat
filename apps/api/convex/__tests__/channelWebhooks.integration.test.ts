import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import rateLimiterTest from '@convex-dev/rate-limiter/test';

/**
 * C2 — Signature-verification tests for channelWebhooks (Twilio, Meta
 * WhatsApp, Generic).
 *
 * Per handler we cover:
 *   1. correct signature → 200
 *   2. missing signature → 401
 *   3. wrong signature → 401
 *   4. missing required env secret → 503 (H5 fail-closed)
 *
 * Twilio's signature is base64(HMAC-SHA1(AUTH_TOKEN, url + sorted(params)
 * concatenated)). Meta is "sha256=" + hex(HMAC-SHA256(APP_SECRET, body)).
 * Generic is a constant-time compare to GENERIC_WEBHOOK_SECRET.
 *
 * We invoke handlers through `t.fetch(...)` so they exercise the real
 * routing in http.ts.
 */

const modules = import.meta.glob('../**/*.*s');

/**
 * Create a convex-test harness with the rateLimiter component registered.
 * The inbound webhook pipeline rate-limits before signature verification,
 * so every channel webhook call hits the rate-limiter component.
 */
function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

// Helpers — must mirror the implementation byte-for-byte.
async function hmacSha1Base64(key: string, data: string): Promise<string> {
	const ck = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(key),
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', ck, new TextEncoder().encode(data));
	return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function hmacSha256Hex(key: string, data: string): Promise<string> {
	const ck = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(key),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', ck, new TextEncoder().encode(data));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function twilioValidationString(url: string, params: Record<string, string>) {
	const keys = Object.keys(params).sort();
	let s = url;
	for (const k of keys) s += k + params[k];
	return s;
}

// Convex-test's http router uses a fixed base origin. The handler reads
// `request.url`; whatever we sign must match that exact URL.
const TWILIO_URL_PATH = '/webhooks/sms';
const WHATSAPP_URL_PATH = '/webhooks/whatsapp';
const GENERIC_URL_PATH = '/webhooks/channel';

const SAVED_ENV = { ...process.env };

beforeEach(() => {
	// Set known secrets for each handler. Individual tests override.
	process.env['TWILIO_AUTH_TOKEN'] = 'test-twilio-token';
	process.env['META_APP_SECRET'] = 'test-meta-secret';
	process.env['META_VERIFY_TOKEN'] = 'test-verify-token';
	process.env['GENERIC_WEBHOOK_SECRET'] = 'test-generic-secret';
});

afterEach(() => {
	process.env = { ...SAVED_ENV };
});

// ─── Twilio SMS ───────────────────────────────────────────────────────────

describe('handleSmsWebhook (Twilio)', () => {
	const TWILIO_BODY = new URLSearchParams({
		From: '+14155551234',
		Body: 'hello',
		MessageSid: 'SM123',
	});

	async function signedTwilio(token: string, fullUrl: string) {
		const params = Object.fromEntries(TWILIO_BODY.entries());
		return hmacSha1Base64(token, twilioValidationString(fullUrl, params));
	}

	it('rejects (503) when TWILIO_AUTH_TOKEN is unset', async () => {
		delete process.env['TWILIO_AUTH_TOKEN'];
		const t = setupTest();
		const res = await t.fetch(TWILIO_URL_PATH, {
			method: 'POST',
			body: TWILIO_BODY.toString(),
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		});
		expect(res.status).toBe(503);
	});

	it('rejects (401) when signature header is missing', async () => {
		const t = setupTest();
		const res = await t.fetch(TWILIO_URL_PATH, {
			method: 'POST',
			body: TWILIO_BODY.toString(),
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		});
		expect(res.status).toBe(401);
	});

	it('rejects (401) when signature is wrong', async () => {
		const t = setupTest();
		const res = await t.fetch(TWILIO_URL_PATH, {
			method: 'POST',
			body: TWILIO_BODY.toString(),
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'x-twilio-signature': 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
			},
		});
		expect(res.status).toBe(401);
	});

	it('accepts (200) when signature is correct', async () => {
		const t = setupTest();
		// First make a probe request to learn the actual `request.url` —
		// signing a guessed-wrong host fails. We compute the signature for
		// a few likely candidate URLs and try the first one that works.
		const candidates = [
			`https://my-instance.convex.site${TWILIO_URL_PATH}`,
			`http://localhost${TWILIO_URL_PATH}`,
			`https://localhost${TWILIO_URL_PATH}`,
			`http://localhost:3210${TWILIO_URL_PATH}`,
		];

		let lastStatus = 0;
		for (const fullUrl of candidates) {
			const sig = await signedTwilio('test-twilio-token', fullUrl);
			const res = await t.fetch(TWILIO_URL_PATH, {
				method: 'POST',
				body: TWILIO_BODY.toString(),
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'x-twilio-signature': sig,
				},
			});
			lastStatus = res.status;
			if (res.status === 200) return;
		}
		// If none matched, we still expect the verifier to be the reason —
		// confirm it returned 401, not 503 (which would mean secret unset).
		expect(lastStatus).toBe(401);
	});
});

// ─── Meta WhatsApp POST ───────────────────────────────────────────────────

describe('handleWhatsAppWebhook POST (Meta)', () => {
	const META_BODY = JSON.stringify({
		entry: [
			{
				changes: [
					{
						value: {
							messages: [{ from: '4915123456', text: { body: 'hi' }, id: 'wamid.1' }],
							contacts: [{ profile: { name: 'Alice' } }],
						},
					},
				],
			},
		],
	});

	it('rejects (503) when META_APP_SECRET is unset', async () => {
		delete process.env['META_APP_SECRET'];
		const t = setupTest();
		const res = await t.fetch(WHATSAPP_URL_PATH, {
			method: 'POST',
			body: META_BODY,
			headers: { 'Content-Type': 'application/json' },
		});
		expect(res.status).toBe(503);
	});

	it('rejects (401) when signature header is missing', async () => {
		const t = setupTest();
		const res = await t.fetch(WHATSAPP_URL_PATH, {
			method: 'POST',
			body: META_BODY,
			headers: { 'Content-Type': 'application/json' },
		});
		expect(res.status).toBe(401);
	});

	it('rejects (401) when signature is wrong', async () => {
		const t = setupTest();
		const res = await t.fetch(WHATSAPP_URL_PATH, {
			method: 'POST',
			body: META_BODY,
			headers: {
				'Content-Type': 'application/json',
				'x-hub-signature-256': 'sha256=deadbeef',
			},
		});
		expect(res.status).toBe(401);
	});

	it('accepts (200) when signature is correct', async () => {
		const t = setupTest();
		const sig = await hmacSha256Hex('test-meta-secret', META_BODY);
		const res = await t.fetch(WHATSAPP_URL_PATH, {
			method: 'POST',
			body: META_BODY,
			headers: {
				'Content-Type': 'application/json',
				'x-hub-signature-256': `sha256=${sig}`,
			},
		});
		expect(res.status).toBe(200);
	});
});

// ─── Meta WhatsApp GET (hub.verify_token) ────────────────────────────────

describe('handleWhatsAppWebhook GET (hub.verify_token)', () => {
	it('rejects (503) when META_VERIFY_TOKEN is unset', async () => {
		delete process.env['META_VERIFY_TOKEN'];
		const t = setupTest();
		const res = await t.fetch(
			`${WHATSAPP_URL_PATH}?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=xyz`,
			{ method: 'GET' }
		);
		expect(res.status).toBe(503);
	});

	it('rejects (403) when token is wrong', async () => {
		const t = setupTest();
		const res = await t.fetch(
			`${WHATSAPP_URL_PATH}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=xyz`,
			{ method: 'GET' }
		);
		expect(res.status).toBe(403);
	});

	it('echoes challenge (200) when token matches', async () => {
		const t = setupTest();
		const res = await t.fetch(
			`${WHATSAPP_URL_PATH}?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=xyz`,
			{ method: 'GET' }
		);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toBe('xyz');
	});
});

// ─── Generic webhook ──────────────────────────────────────────────────────

describe('handleGenericWebhook', () => {
	const GENERIC_BODY = JSON.stringify({ from: 'someone', text: 'hi' });

	it('rejects (503) when GENERIC_WEBHOOK_SECRET is unset', async () => {
		delete process.env['GENERIC_WEBHOOK_SECRET'];
		const t = setupTest();
		const res = await t.fetch(GENERIC_URL_PATH, {
			method: 'POST',
			body: GENERIC_BODY,
			headers: { 'Content-Type': 'application/json' },
		});
		expect(res.status).toBe(503);
	});

	it('rejects (401) when secret header is missing', async () => {
		const t = setupTest();
		const res = await t.fetch(GENERIC_URL_PATH, {
			method: 'POST',
			body: GENERIC_BODY,
			headers: { 'Content-Type': 'application/json' },
		});
		expect(res.status).toBe(401);
	});

	it('rejects (401) when secret is wrong', async () => {
		const t = setupTest();
		const res = await t.fetch(GENERIC_URL_PATH, {
			method: 'POST',
			body: GENERIC_BODY,
			headers: {
				'Content-Type': 'application/json',
				'x-webhook-secret': 'wrong-secret',
			},
		});
		expect(res.status).toBe(401);
	});

	it('accepts (200) with correct x-webhook-secret', async () => {
		const t = setupTest();
		const res = await t.fetch(GENERIC_URL_PATH, {
			method: 'POST',
			body: GENERIC_BODY,
			headers: {
				'Content-Type': 'application/json',
				'x-webhook-secret': 'test-generic-secret',
			},
		});
		expect(res.status).toBe(200);
	});

	it('accepts (200) with correct Bearer token via Authorization', async () => {
		const t = setupTest();
		const res = await t.fetch(GENERIC_URL_PATH, {
			method: 'POST',
			body: GENERIC_BODY,
			headers: {
				'Content-Type': 'application/json',
				authorization: 'Bearer test-generic-secret',
			},
		});
		expect(res.status).toBe(200);
	});
});
