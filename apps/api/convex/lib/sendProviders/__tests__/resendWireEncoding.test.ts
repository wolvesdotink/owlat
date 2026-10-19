/**
 * THE RESEND ADAPTER'S WIRE ENCODING, THROUGH THE REAL SDK.
 *
 * Every other Resend suite replaces the SDK's `emails.send` (see
 * `ambiguousTimeout.test.ts`), so it sees only the adapter's INPUT to the SDK.
 * Two facts live below that seam, inside the SDK's serializer:
 *
 * - the adapter passes `contentType` and the SDK's `parseAttachments` renames
 *   it to the `content_type` wire field. Passing the wire spelling instead was
 *   a real bug: it was dropped as an excess property and Resend guessed the
 *   type from the filename;
 * - the `idempotencyKey` request option becomes the `Idempotency-Key` header,
 *   which is what makes a retry after an ambiguous timeout safe.
 *
 * Here the real `resend` package runs and only `fetch` is replaced, so an SDK
 * upgrade that renames either field fails this suite. No request leaves the
 * process: the stub records the request and answers it, and the API key is
 * synthetic. Stubbing `fetch` alone would not keep an SDK that moved to
 * `node:https` or its own fetch off the network, so every outbound socket
 * connect is refused while this file runs and any attempt fails the test.
 */

import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { resendSendProvider, _resetResendClientCacheForTests } from '../resend';
import { resolveSendTransport, _resetSendTransportCacheForTests } from '../transports';
import type { EmailSendParams } from '../types';

interface CapturedRequest {
	url: string;
	method: string | undefined;
	headers: Headers;
	body: Record<string, unknown>;
}

const params: EmailSendParams = {
	to: 'to@example.com',
	from: 'from@owlat.example',
	subject: 'Quarterly report',
	html: '<p>Attached.</p>',
	text: 'Attached.',
};

/** Bytes that are not valid UTF-8, so a lossy text round trip would show. */
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0x00, 0x80]);

let requests: CapturedRequest[];
let blockedConnects: unknown[];
let connectGuard: MockInstance<net.Socket['connect']>;

/**
 * Fail closed on any transport other than the stubbed `fetch`. Every Node TCP
 * or TLS client (`http(s).request`, `tls.connect`, undici's fetch) opens its
 * socket through `net.Socket#connect`, so refusing it here stops the attempt
 * before DNS, and recording it fails the test even when the SDK swallows the
 * error into an `{ error }` result.
 */
function guardOutboundConnections(): void {
	blockedConnects = [];
	connectGuard = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation((...args) => {
		blockedConnects.push(args[0]);
		throw new Error('resendWireEncoding.test: outbound connection blocked');
	});
}

function stubResendApi(): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({
				url: String(input),
				method: init?.method,
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			});
			return Response.json({ id: 're_wire_1' });
		})
	);
}

function onlyRequest(): CapturedRequest {
	expect(requests).toHaveLength(1);
	return requests[0]!;
}

beforeEach(() => {
	requests = [];
	guardOutboundConnections();
	_resetSendTransportCacheForTests();
	_resetResendClientCacheForTests();
	vi.stubEnv('RESEND_API_KEY', 're_synthetic_test_key');
	stubResendApi();
});

afterEach(() => {
	connectGuard.mockRestore();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	_resetSendTransportCacheForTests();
	_resetResendClientCacheForTests();
	// Last, so a failure here cannot skip the cleanup above.
	expect(blockedConnects, 'a request bypassed the stubbed fetch').toEqual([]);
});

describe('Resend wire encoding (real SDK, fetch intercepted)', () => {
	it('refuses an outbound connection made around the stubbed fetch', () => {
		// `.example` never resolves, so even a broken guard reaches no one.
		expect(() => net.connect({ host: 'api.owlat.example', port: 443 })).toThrow(
			'outbound connection blocked'
		);
		expect(blockedConnects).toHaveLength(1);
		blockedConnects = [];
	});

	it('posts one JSON request to the Resend emails endpoint with the synthetic key', async () => {
		const result = await resendSendProvider.sendEmail(resolveSendTransport('resend'), params);

		expect(result).toEqual({ success: true, id: 're_wire_1' });
		const request = onlyRequest();
		expect(request.method).toBe('POST');
		expect(new URL(request.url).pathname).toBe('/emails');
		expect(request.headers.get('authorization')).toBe('Bearer re_synthetic_test_key');
		expect(request.headers.get('content-type')).toBe('application/json');
	});

	it('encodes attachments with the snake_case content_type and base64 content', async () => {
		await resendSendProvider.sendEmail(resolveSendTransport('resend'), {
			...params,
			attachments: [{ filename: 'report.pdf', content: PDF_BYTES, contentType: 'application/pdf' }],
		});

		const { attachments } = onlyRequest().body;
		expect(attachments).toEqual([
			{
				filename: 'report.pdf',
				content: Buffer.from(PDF_BYTES).toString('base64'),
				content_type: 'application/pdf',
			},
		]);
		// The camelCase input spelling must not reach the wire in its place.
		expect((attachments as Record<string, unknown>[])[0]).not.toHaveProperty('contentType');
	});

	it('sends the governed idempotency key as the Idempotency-Key header', async () => {
		await resendSendProvider.sendEmail(resolveSendTransport('resend'), params, {
			idempotencyKey: 'send_send-row-1',
		});

		const request = onlyRequest();
		expect(request.headers.get('idempotency-key')).toBe('send_send-row-1');
		// A header, not a body field.
		expect(request.body).not.toHaveProperty('idempotencyKey');
		expect(request.body).not.toHaveProperty('idempotency_key');
	});

	it('sends the system-mail caller key as the header, and no header without one', async () => {
		const transport = resolveSendTransport('resend');
		await resendSendProvider.sendEmail(
			transport,
			params,
			resendSendProvider.buildSystemMailExtras!({ idempotencyKey: 'password-reset-1' })
		);
		await resendSendProvider.sendEmail(
			transport,
			params,
			resendSendProvider.buildSystemMailExtras!({ idempotencyKey: undefined })
		);

		expect(requests).toHaveLength(2);
		expect(requests[0]!.headers.get('idempotency-key')).toBe('password-reset-1');
		expect(requests[1]!.headers.has('idempotency-key')).toBe(false);
	});

	it('keeps caller headers in the body, apart from the request headers', async () => {
		await resendSendProvider.sendEmail(
			resolveSendTransport('resend'),
			{ ...params, replyTo: 'reply@owlat.example', headers: { 'List-Unsubscribe': '<u>' } },
			{ idempotencyKey: 'send_send-row-2' }
		);

		const request = onlyRequest();
		expect(request.body).toMatchObject({
			to: 'to@example.com',
			from: 'from@owlat.example',
			subject: 'Quarterly report',
			html: '<p>Attached.</p>',
			text: 'Attached.',
			reply_to: 'reply@owlat.example',
			headers: { 'List-Unsubscribe': '<u>' },
		});
		expect(request.headers.has('list-unsubscribe')).toBe(false);
	});
});
