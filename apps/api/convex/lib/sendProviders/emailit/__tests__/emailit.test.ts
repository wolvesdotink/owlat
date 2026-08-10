import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailitSendProvider, EMAILIT_SEND_URL } from '..';
import { EmailErrorCode } from '../../types';
import type { SendTransportRecord } from '../../transports';

const transport: SendTransportRecord = Object.freeze({
	id: 'emailit',
	kind: 'emailit',
	instanceKey: null,
	label: 'Emailit',
	requiredEnvVars: ['EMAILIT_API_KEY'],
});

const params = {
	to: 'recipient@example.com',
	from: 'Sender <sender@example.com>',
	subject: 'Subject',
	html: '<p>Hello</p>',
	text: 'Hello',
	replyTo: 'reply@example.com',
	headers: { 'List-Id': 'news.example.com' },
	attachments: [
		{ filename: 'hello.txt', content: Buffer.from('hello'), contentType: 'text/plain' },
	],
};

const originalFetch = global.fetch;

beforeEach(() => vi.stubEnv('EMAILIT_API_KEY', 'emailit-secret'));
afterEach(() => {
	global.fetch = originalFetch;
	vi.unstubAllEnvs();
});

describe('Emailit transport', () => {
	it('preserves message capabilities and disables provider tracking', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ id: 'em_123' }), { status: 200 }));
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(
			emailitSendProvider.sendEmail(transport, params, { idempotencyKey: 'send_123' })
		).resolves.toEqual({ success: true, id: 'em_123' });

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(EMAILIT_SEND_URL);
		expect(init.headers).toEqual({
			Authorization: 'Bearer emailit-secret',
			'Content-Type': 'application/json',
			'Idempotency-Key': 'send_123',
		});
		expect(JSON.parse(init.body as string)).toEqual({
			from: params.from,
			to: params.to,
			subject: params.subject,
			html: params.html,
			text: params.text,
			reply_to: params.replyTo,
			headers: params.headers,
			attachments: [
				{
					filename: 'hello.txt',
					content: 'aGVsbG8=',
					content_type: 'text/plain',
					encoding: 'base64',
				},
			],
			tracking: { loads: false, clicks: false },
		});
	});

	it('rejects an untrackable success', async () => {
		global.fetch = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ id: '' }), { status: 200 })) as typeof fetch;
		const result = await emailitSendProvider.sendEmail(transport, params);
		expect(result).toMatchObject({ success: false, errorCode: EmailErrorCode.UNKNOWN });
	});

	it('classifies status, honors Retry-After, and never leaks the API key', async () => {
		global.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ message: 'slow emailit-secret down' }), {
				status: 429,
				headers: { 'Retry-After': '3' },
			})
		) as typeof fetch;
		const result = await emailitSendProvider.sendEmail(transport, params);
		expect(result).toMatchObject({
			success: false,
			errorCode: EmailErrorCode.RATE_LIMIT,
			retryAfterMs: 3_000,
		});
		expect(JSON.stringify(result)).not.toContain('emailit-secret');
	});

	it('fails before the network when the instance credential is absent', async () => {
		vi.stubEnv('EMAILIT_API_KEY', '');
		const fetchMock = vi.fn();
		global.fetch = fetchMock as unknown as typeof fetch;
		const result = await emailitSendProvider.sendEmail(transport, params);
		expect(result).toMatchObject({ success: false, errorCode: EmailErrorCode.AUTH_FAILED });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('keeps a timed-out idempotent request retryable', () => {
		expect(emailitSendProvider.categorizeError('Emailit API call timed out')).toBe(
			EmailErrorCode.SERVER_ERROR
		);
	});
});
