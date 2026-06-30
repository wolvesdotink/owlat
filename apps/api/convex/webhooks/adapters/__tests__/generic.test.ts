import { describe, it, expect } from 'vitest';
import { genericAdapter } from '../generic';

const SECRET = 'test-generic-secret';
const REQUEST_URL = 'https://owlat.example.com/webhooks/channel';

function makeRequest(headers: Record<string, string> = {}): Request {
	return new Request(REQUEST_URL, {
		method: 'POST',
		headers,
		body: '',
	});
}

describe('genericAdapter.verifySignature', () => {
	it('returns 503 when GENERIC_WEBHOOK_SECRET is unset', async () => {
		const original = process.env['GENERIC_WEBHOOK_SECRET'];
		delete process.env['GENERIC_WEBHOOK_SECRET'];
		try {
			const result = await genericAdapter.verifySignature(makeRequest(), '');
			expect(result).toEqual({
				ok: false,
				status: 503,
				reason: expect.stringContaining('GENERIC_WEBHOOK_SECRET'),
			});
		} finally {
			if (original !== undefined)
				process.env['GENERIC_WEBHOOK_SECRET'] = original;
		}
	});

	it('returns 401 when no authentication header is provided', async () => {
		process.env['GENERIC_WEBHOOK_SECRET'] = SECRET;
		const result = await genericAdapter.verifySignature(makeRequest(), '');
		expect(result).toEqual({
			ok: false,
			status: 401,
			reason: expect.stringContaining('Missing'),
		});
	});

	it('accepts a matching x-webhook-secret header', async () => {
		process.env['GENERIC_WEBHOOK_SECRET'] = SECRET;
		const result = await genericAdapter.verifySignature(
			makeRequest({ 'x-webhook-secret': SECRET }),
			''
		);
		expect(result).toEqual({ ok: true });
	});

	it('accepts a matching Authorization header (bare secret)', async () => {
		process.env['GENERIC_WEBHOOK_SECRET'] = SECRET;
		const result = await genericAdapter.verifySignature(
			makeRequest({ authorization: SECRET }),
			''
		);
		expect(result).toEqual({ ok: true });
	});

	it('accepts a matching Authorization: Bearer secret', async () => {
		process.env['GENERIC_WEBHOOK_SECRET'] = SECRET;
		const result = await genericAdapter.verifySignature(
			makeRequest({ authorization: `Bearer ${SECRET}` }),
			''
		);
		expect(result).toEqual({ ok: true });
	});

	it('rejects a wrong secret with 401', async () => {
		process.env['GENERIC_WEBHOOK_SECRET'] = SECRET;
		const result = await genericAdapter.verifySignature(
			makeRequest({ 'x-webhook-secret': 'wrong-secret' }),
			''
		);
		expect(result).toEqual({
			ok: false,
			status: 401,
			reason: expect.stringContaining('Invalid'),
		});
	});
});

describe('genericAdapter.parseEvent', () => {
	it('emits a channel.received event with channel:generic', () => {
		const event = genericAdapter.parseEvent(
			JSON.stringify({
				from: 'user@example.com',
				text: 'hello',
				id: 'msg_1',
			})
		);
		expect(event).toEqual({
			kind: 'channel.received',
			channel: 'generic',
			from: 'user@example.com',
			content: { text: 'hello' },
			externalMessageId: 'msg_1',
		});
	});

	it('falls back to sender when from is missing', () => {
		const event = genericAdapter.parseEvent(
			JSON.stringify({ sender: 'someone', message: 'hi' })
		);
		if (event?.kind !== 'channel.received') throw new Error('wrong kind');
		expect(event.from).toBe('someone');
		expect(event.content.text).toBe('hi');
	});

	it("falls back to 'webhook' literal when from and sender are both missing", () => {
		const event = genericAdapter.parseEvent(JSON.stringify({ text: 'hi' }));
		if (event?.kind !== 'channel.received') throw new Error('wrong kind');
		expect(event.from).toBe('webhook');
	});

	it('supports nested content.text/html/subject', () => {
		const event = genericAdapter.parseEvent(
			JSON.stringify({
				from: 'a@b',
				content: { text: 't', html: '<p>h</p>', subject: 's' },
			})
		);
		if (event?.kind !== 'channel.received') throw new Error('wrong kind');
		expect(event.content).toEqual({ text: 't', html: '<p>h</p>', subject: 's' });
	});

	it('uses messageId when id is missing', () => {
		const event = genericAdapter.parseEvent(
			JSON.stringify({ from: 'a@b', text: 'hi', messageId: 'mid_x' })
		);
		if (event?.kind !== 'channel.received') throw new Error('wrong kind');
		expect(event.externalMessageId).toBe('mid_x');
	});

	it('omits externalMessageId when neither id nor messageId is present', () => {
		const event = genericAdapter.parseEvent(
			JSON.stringify({ from: 'a@b', text: 'hi' })
		);
		if (event?.kind !== 'channel.received') throw new Error('wrong kind');
		expect(event.externalMessageId).toBeUndefined();
	});

	it('passes through metadata when present', () => {
		const event = genericAdapter.parseEvent(
			JSON.stringify({ from: 'a@b', text: 'hi', metadata: { ip: '1.2.3.4' } })
		);
		if (event?.kind !== 'channel.received') throw new Error('wrong kind');
		expect(event.metadata).toEqual({ ip: '1.2.3.4' });
	});

	it('throws on malformed JSON', () => {
		expect(() => genericAdapter.parseEvent('not json')).toThrow();
	});

	it('does NOT supply a custom successResponse (inherits pipeline default)', () => {
		expect(genericAdapter.successResponse).toBeUndefined();
	});
});
