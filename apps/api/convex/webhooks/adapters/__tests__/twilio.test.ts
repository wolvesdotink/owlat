import { describe, it, expect } from 'vitest';
import {
	twilioAdapter,
	twilioValidationString,
	verifyTwilioRequest,
} from '../twilio';

const AUTH_TOKEN = 'test_twilio_auth_token';
const REQUEST_URL = 'https://owlat.example.com/webhooks/sms';

async function sign(canonical: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(AUTH_TOKEN),
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(canonical)
	);
	return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function urlEncode(params: Record<string, string>): string {
	return new URLSearchParams(params).toString();
}

describe('twilioValidationString', () => {
	it('appends sorted key-value pairs to the URL with no separator', () => {
		const canonical = twilioValidationString(REQUEST_URL, {
			Body: 'hello',
			From: '+15551234567',
			MessageSid: 'SM123',
		});
		expect(canonical).toBe(
			`${REQUEST_URL}Bodyhello` +
				`From+15551234567` +
				`MessageSidSM123`
		);
	});

	it('is sort-stable regardless of insertion order', () => {
		const a = twilioValidationString(REQUEST_URL, {
			z: '1',
			a: '2',
			m: '3',
		});
		const b = twilioValidationString(REQUEST_URL, {
			a: '2',
			m: '3',
			z: '1',
		});
		expect(a).toBe(b);
	});

	it('handles empty params', () => {
		expect(twilioValidationString(REQUEST_URL, {})).toBe(REQUEST_URL);
	});

	it('handles a single param', () => {
		expect(twilioValidationString(REQUEST_URL, { K: 'V' })).toBe(
			`${REQUEST_URL}KV`
		);
	});
});

describe('verifyTwilioRequest', () => {
	const params = {
		From: '+15551234567',
		Body: 'hello',
		MessageSid: 'SM_abc',
	};
	const rawBody = urlEncode(params);

	it('accepts a valid signature', async () => {
		const canonical = twilioValidationString(REQUEST_URL, params);
		const sig = await sign(canonical);
		expect(
			await verifyTwilioRequest(REQUEST_URL, rawBody, sig, AUTH_TOKEN)
		).toBe(true);
	});

	it('rejects a tampered body', async () => {
		const canonical = twilioValidationString(REQUEST_URL, params);
		const sig = await sign(canonical);
		const tampered = urlEncode({ ...params, Body: 'evil' });
		expect(
			await verifyTwilioRequest(REQUEST_URL, tampered, sig, AUTH_TOKEN)
		).toBe(false);
	});

	it('rejects when the URL changes (mismatched host)', async () => {
		const canonical = twilioValidationString(REQUEST_URL, params);
		const sig = await sign(canonical);
		expect(
			await verifyTwilioRequest(
				'https://attacker.example.com/webhooks/sms',
				rawBody,
				sig,
				AUTH_TOKEN
			)
		).toBe(false);
	});

	it('rejects an entirely bogus signature value', async () => {
		expect(
			await verifyTwilioRequest(
				REQUEST_URL,
				rawBody,
				'definitelynotvalid',
				AUTH_TOKEN
			)
		).toBe(false);
	});
});

describe('twilioAdapter.verifySignature', () => {
	const params = { From: '+15551234567', Body: 'hello', MessageSid: 'SM_x' };
	const rawBody = urlEncode(params);

	function makeRequest(headers: Record<string, string> = {}): Request {
		return new Request(REQUEST_URL, {
			method: 'POST',
			headers,
			body: rawBody,
		});
	}

	it('returns 503 when TWILIO_AUTH_TOKEN is unset', async () => {
		const original = process.env['TWILIO_AUTH_TOKEN'];
		delete process.env['TWILIO_AUTH_TOKEN'];
		try {
			const result = await twilioAdapter.verifySignature(
				makeRequest(),
				rawBody
			);
			expect(result).toEqual({
				ok: false,
				status: 503,
				reason: expect.stringContaining('TWILIO_AUTH_TOKEN'),
			});
		} finally {
			if (original !== undefined) process.env['TWILIO_AUTH_TOKEN'] = original;
		}
	});

	it('returns 401 when the signature header is missing', async () => {
		process.env['TWILIO_AUTH_TOKEN'] = AUTH_TOKEN;
		const result = await twilioAdapter.verifySignature(
			makeRequest(),
			rawBody
		);
		expect(result).toEqual({
			ok: false,
			status: 401,
			reason: expect.stringContaining('Missing'),
		});
	});

	it('returns ok for a correctly-signed request', async () => {
		process.env['TWILIO_AUTH_TOKEN'] = AUTH_TOKEN;
		const canonical = twilioValidationString(REQUEST_URL, params);
		const sig = await sign(canonical);
		const result = await twilioAdapter.verifySignature(
			makeRequest({ 'x-twilio-signature': sig }),
			rawBody
		);
		expect(result).toEqual({ ok: true });
	});

	it('returns 401 for an invalid signature', async () => {
		process.env['TWILIO_AUTH_TOKEN'] = AUTH_TOKEN;
		const result = await twilioAdapter.verifySignature(
			makeRequest({ 'x-twilio-signature': 'bogus' }),
			rawBody
		);
		expect(result).toEqual({
			ok: false,
			status: 401,
			reason: expect.stringContaining('Invalid'),
		});
	});
});

describe('twilioAdapter.parseEvent', () => {
	it('emits a channel.received event for a text-only SMS', () => {
		const rawBody = urlEncode({
			From: '+15551234567',
			Body: 'hello world',
			MessageSid: 'SM_text',
			FromCity: 'NewYork',
			FromState: 'NY',
			FromCountry: 'US',
		});
		expect(twilioAdapter.parseEvent(rawBody)).toEqual({
			kind: 'channel.received',
			channel: 'sms',
			from: '+15551234567',
			content: { text: 'hello world' },
			externalMessageId: 'SM_text',
			metadata: {
				fromCity: 'NewYork',
				fromState: 'NY',
				fromCountry: 'US',
			},
		});
	});

	it('includes mediaUrl when MediaUrl0 is present (MMS)', () => {
		const rawBody = urlEncode({
			From: '+15551234567',
			Body: 'photo',
			MessageSid: 'SM_mms',
			MediaUrl0: 'https://example.com/image.jpg',
		});
		const event = twilioAdapter.parseEvent(rawBody);
		expect(event).not.toBeNull();
		expect(event!.kind).toBe('channel.received');
		if (event!.kind === 'channel.received') {
			expect(event!.content).toEqual({
				text: 'photo',
				mediaUrl: 'https://example.com/image.jpg',
			});
		}
	});

	it('throws when From is missing', () => {
		const rawBody = urlEncode({ Body: 'hi', MessageSid: 'SM_x' });
		expect(() => twilioAdapter.parseEvent(rawBody)).toThrow(/From and Body/);
	});

	it('throws when Body is missing', () => {
		const rawBody = urlEncode({ From: '+15551234567', MessageSid: 'SM_x' });
		expect(() => twilioAdapter.parseEvent(rawBody)).toThrow(/From and Body/);
	});

	it('omits externalMessageId when MessageSid is empty', () => {
		const rawBody = urlEncode({
			From: '+15551234567',
			Body: 'hi',
		});
		const event = twilioAdapter.parseEvent(rawBody);
		expect(event).not.toBeNull();
		if (event!.kind === 'channel.received') {
			expect(event!.externalMessageId).toBeUndefined();
		}
	});
});

describe('twilioAdapter.successResponse', () => {
	it('returns a TwiML XML response', async () => {
		const response = twilioAdapter.successResponse!({
			kind: 'channel.received',
			channel: 'sms',
			from: '+1',
			content: { text: 'x' },
			metadata: {},
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/xml');
		expect(await response.text()).toBe(
			'<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
		);
	});

	it('returns a fresh Response on each call (body not exhausted)', async () => {
		const a = twilioAdapter.successResponse!({
			kind: 'channel.received',
			channel: 'sms',
			from: '+1',
			content: {},
			metadata: {},
		});
		const b = twilioAdapter.successResponse!({
			kind: 'channel.received',
			channel: 'sms',
			from: '+1',
			content: {},
			metadata: {},
		});
		// Consuming one must not affect the other.
		await a.text();
		expect(await b.text()).toContain('<Response>');
	});
});
