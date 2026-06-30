import { describe, it, expect } from 'vitest';
import {
	metaAdapter,
	handleMetaChallenge,
	verifyMetaSignature,
} from '../meta';

const APP_SECRET = 'test-meta-app-secret';
const VERIFY_TOKEN = 'test-meta-verify-token';
const REQUEST_URL = 'https://owlat.example.com/webhooks/whatsapp';

async function signSha256Hex(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(body)
	);
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function makePostRequest(headers: Record<string, string> = {}): Request {
	return new Request(REQUEST_URL, { method: 'POST', headers, body: '' });
}

function makeGetRequest(query: Record<string, string>): Request {
	const url = new URL(REQUEST_URL);
	for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
	return new Request(url.toString(), { method: 'GET' });
}

describe('verifyMetaSignature', () => {
	const body = '{"entry":[]}';

	it('accepts a valid signature', async () => {
		const hex = await signSha256Hex(APP_SECRET, body);
		expect(await verifyMetaSignature(body, `sha256=${hex}`, APP_SECRET)).toBe(
			true
		);
	});

	it('rejects a missing sha256= prefix', async () => {
		const hex = await signSha256Hex(APP_SECRET, body);
		expect(await verifyMetaSignature(body, hex, APP_SECRET)).toBe(false);
	});

	it('rejects a tampered body', async () => {
		const hex = await signSha256Hex(APP_SECRET, body);
		expect(
			await verifyMetaSignature(body + 'extra', `sha256=${hex}`, APP_SECRET)
		).toBe(false);
	});

	it('rejects an entirely bogus signature value', async () => {
		expect(
			await verifyMetaSignature(body, 'sha256=deadbeef', APP_SECRET)
		).toBe(false);
	});
});

describe('metaAdapter.verifySignature', () => {
	it('returns 503 when META_APP_SECRET is unset', async () => {
		const original = process.env['META_APP_SECRET'];
		delete process.env['META_APP_SECRET'];
		try {
			const result = await metaAdapter.verifySignature(
				makePostRequest(),
				''
			);
			expect(result).toEqual({
				ok: false,
				status: 503,
				reason: expect.stringContaining('META_APP_SECRET'),
			});
		} finally {
			if (original !== undefined) process.env['META_APP_SECRET'] = original;
		}
	});

	it('returns 401 when X-Hub-Signature-256 header is missing', async () => {
		process.env['META_APP_SECRET'] = APP_SECRET;
		const result = await metaAdapter.verifySignature(makePostRequest(), '');
		expect(result).toEqual({
			ok: false,
			status: 401,
			reason: expect.stringContaining('Missing'),
		});
	});

	it('returns ok for a correctly-signed request', async () => {
		process.env['META_APP_SECRET'] = APP_SECRET;
		const body = '{"entry":[]}';
		const hex = await signSha256Hex(APP_SECRET, body);
		const result = await metaAdapter.verifySignature(
			makePostRequest({ 'x-hub-signature-256': `sha256=${hex}` }),
			body
		);
		expect(result).toEqual({ ok: true });
	});

	it('returns 401 for a bogus signature', async () => {
		process.env['META_APP_SECRET'] = APP_SECRET;
		const result = await metaAdapter.verifySignature(
			makePostRequest({ 'x-hub-signature-256': 'sha256=deadbeef' }),
			'{}'
		);
		expect(result).toEqual({
			ok: false,
			status: 401,
			reason: expect.stringContaining('Invalid'),
		});
	});
});

describe('metaAdapter.parseEvent', () => {
	function build(value: Record<string, unknown>): string {
		return JSON.stringify({ entry: [{ changes: [{ value }] }] });
	}

	it('emits channel.received for a text message', () => {
		const event = metaAdapter.parseEvent(
			build({
				messages: [
					{ from: '4915123456', id: 'wamid.1', text: { body: 'hello' } },
				],
				contacts: [{ profile: { name: 'Alice' } }],
			})
		);
		expect(event).toEqual({
			kind: 'channel.received',
			channel: 'whatsapp',
			from: '4915123456',
			content: { text: 'hello' },
			externalMessageId: 'wamid.1',
			metadata: { profileName: 'Alice' },
		});
	});

	it('extracts mediaUrl from image messages', () => {
		const event = metaAdapter.parseEvent(
			build({
				messages: [
					{
						from: '49555',
						id: 'wamid.2',
						image: { url: 'https://cdn.example.com/i.jpg' },
					},
				],
			})
		);
		if (event?.kind !== 'channel.received') throw new Error('wrong kind');
		expect(event.content.mediaUrl).toBe('https://cdn.example.com/i.jpg');
	});

	it('falls back to document.url when image.url is absent', () => {
		const event = metaAdapter.parseEvent(
			build({
				messages: [
					{
						from: '49555',
						id: 'wamid.3',
						document: { url: 'https://cdn.example.com/d.pdf' },
					},
				],
			})
		);
		if (event?.kind !== 'channel.received') throw new Error('wrong kind');
		expect(event.content.mediaUrl).toBe('https://cdn.example.com/d.pdf');
	});

	it('returns null when no messages are present (status-update)', () => {
		expect(
			metaAdapter.parseEvent(
				build({
					/* no messages */
				})
			)
		).toBeNull();
	});

	it('returns null when entry is missing entirely', () => {
		expect(metaAdapter.parseEvent('{}')).toBeNull();
	});

	it('returns null when from is missing on the message', () => {
		const event = metaAdapter.parseEvent(
			build({ messages: [{ id: 'wamid.x', text: { body: 'orphan' } }] })
		);
		expect(event).toBeNull();
	});

	it('omits externalMessageId when id is absent', () => {
		const event = metaAdapter.parseEvent(
			build({ messages: [{ from: '4915123456', text: { body: 'hi' } }] })
		);
		if (event?.kind !== 'channel.received') throw new Error('wrong kind');
		expect(event.externalMessageId).toBeUndefined();
	});
});

describe('metaAdapter.successResponse', () => {
	it('returns a plain `OK` 200 response', async () => {
		const response = metaAdapter.successResponse!({
			kind: 'channel.received',
			channel: 'whatsapp',
			from: '1',
			content: {},
			metadata: {},
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('OK');
	});
});

describe('handleMetaChallenge', () => {
	it('returns 503 when META_VERIFY_TOKEN is unset', () => {
		const original = process.env['META_VERIFY_TOKEN'];
		delete process.env['META_VERIFY_TOKEN'];
		try {
			const response = handleMetaChallenge(
				makeGetRequest({
					'hub.mode': 'subscribe',
					'hub.verify_token': 'x',
					'hub.challenge': 'y',
				})
			);
			expect(response.status).toBe(503);
		} finally {
			if (original !== undefined) process.env['META_VERIFY_TOKEN'] = original;
		}
	});

	it('echoes the challenge when token matches and mode is subscribe', async () => {
		process.env['META_VERIFY_TOKEN'] = VERIFY_TOKEN;
		const response = handleMetaChallenge(
			makeGetRequest({
				'hub.mode': 'subscribe',
				'hub.verify_token': VERIFY_TOKEN,
				'hub.challenge': 'xyz123',
			})
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('xyz123');
	});

	it('returns 403 when token does not match', () => {
		process.env['META_VERIFY_TOKEN'] = VERIFY_TOKEN;
		const response = handleMetaChallenge(
			makeGetRequest({
				'hub.mode': 'subscribe',
				'hub.verify_token': 'wrong-token',
				'hub.challenge': 'xyz',
			})
		);
		expect(response.status).toBe(403);
	});

	it('returns 403 when mode is not subscribe', () => {
		process.env['META_VERIFY_TOKEN'] = VERIFY_TOKEN;
		const response = handleMetaChallenge(
			makeGetRequest({
				'hub.mode': 'unsubscribe',
				'hub.verify_token': VERIFY_TOKEN,
				'hub.challenge': 'xyz',
			})
		);
		expect(response.status).toBe(403);
	});

	it('returns 403 when challenge query param is missing', () => {
		process.env['META_VERIFY_TOKEN'] = VERIFY_TOKEN;
		const response = handleMetaChallenge(
			makeGetRequest({
				'hub.mode': 'subscribe',
				'hub.verify_token': VERIFY_TOKEN,
			})
		);
		expect(response.status).toBe(403);
	});
});
