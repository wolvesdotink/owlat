/**
 * THE D3 REGRESSION TEST.
 *
 * Owlat's composition pipeline is the product: first-party open/click tracking,
 * RFC 8058 one-click unsubscribe headers, `Feedback-ID`, `List-Id`, and a
 * plain-text part derived from the UNTRACKED HTML. Mandrill will cheerfully
 * undo all of it — rewriting every link through its own redirector, injecting
 * its own open pixel, regenerating the text part from the tracked HTML — if the
 * account's dashboard defaults say so and the request does not say otherwise.
 *
 * That failure is invisible: mail still arrives, and only ONE arm loses its
 * first-party instrumentation. The ramp controller then compares the own arm and
 * the Mandrill arm on `engagement_ratio` measured with two different rulers and
 * concludes something false about which one is safe. So the exact request shape
 * is pinned here, flag by flag, and every flag is asserted to be present —
 * `toBe(false)`, never `toBeFalsy()`, because an OMITTED flag inherits the
 * account default and is exactly the bug.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mandrillSendProvider, _resetMandrillConfigCacheForTests } from '../index';
import { EmailErrorCode } from '../../types';
import { resolveSendTransport, _resetSendTransportCacheForTests } from '../../transports';

const originalFetch = global.fetch;

const params = {
	to: 'to@example.com',
	from: 'Acme <from@acme.com>',
	subject: 'Your receipt',
	html: '<p>Hello <a href="https://acme.com/x?utm=1">link</a></p>',
	text: 'Hello link',
};

/** One accepted recipient — the shape a single-recipient send-raw answers with. */
function accepted(id = 'mandrill-msg-1', status = 'sent'): typeof fetch {
	return vi.fn().mockResolvedValue(
		new Response(JSON.stringify([{ email: 'to@example.com', status, _id: id }]), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		})
	) as unknown as typeof fetch;
}

function lastBody(): Record<string, unknown> {
	const spy = global.fetch as unknown as ReturnType<typeof vi.fn>;
	const init = spy.mock.calls[spy.mock.calls.length - 1]![1] as RequestInit;
	return JSON.parse(init.body as string) as Record<string, unknown>;
}

function transport() {
	return resolveSendTransport('mandrill');
}

beforeEach(() => {
	_resetSendTransportCacheForTests();
	_resetMandrillConfigCacheForTests();
	vi.stubEnv('MANDRILL_API_KEY', 'md-test-key');
	global.fetch = accepted();
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	global.fetch = originalFetch;
	_resetSendTransportCacheForTests();
	_resetMandrillConfigCacheForTests();
});

describe('send-raw request shape', () => {
	it('posts JSON to the send-raw endpoint with the key in the BODY, never a header or URL', async () => {
		await mandrillSendProvider.sendEmail(transport(), params);

		const spy = global.fetch as unknown as ReturnType<typeof vi.fn>;
		expect(spy).toHaveBeenCalledTimes(1);
		const [url, init] = spy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://mandrillapp.com/api/1.0/messages/send-raw');
		expect(init.method).toBe('POST');
		expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
		// Mandrill convention: the credential travels in the JSON body, so it can
		// never leak through a URL, a proxy log, or an Authorization header dump.
		expect(String(url)).not.toContain('md-test-key');
		expect(JSON.stringify(init.headers)).not.toContain('md-test-key');
		expect(lastBody()['key']).toBe('md-test-key');
	});

	it('sends async:true so a slow recipient domain cannot manufacture a D4 ambiguity', async () => {
		await mandrillSendProvider.sendEmail(transport(), params);
		expect(lastBody()['async']).toBe(true);
	});

	// ── The flags. One assertion each, so a failure names the exact feature. ──
	it.each([
		['track_opens', 'Mandrill would inject its own open pixel beside our first-party one'],
		['track_clicks', 'Mandrill would rewrite every link through its redirector'],
		['auto_html', 'Mandrill would synthesise an HTML part we did not compose'],
		['auto_text', 'Mandrill would regenerate the text part from the TRACKED html'],
		['url_strip_qs', 'Mandrill would strip our tracking query strings off links'],
		['preserve_recipients', 'Mandrill would rewrite the To header our composer built'],
	])('sends %s: false — %s', async (flag) => {
		await mandrillSendProvider.sendEmail(transport(), params);
		const body = lastBody();
		// Present AND false. An omitted flag inherits the ACCOUNT default, which is
		// the silent-corruption bug this whole file exists to prevent.
		expect(Object.keys(body)).toContain(flag);
		expect(body[flag]).toBe(false);
	});

	it('pins the whole feature-off block at once, so a new Mandrill knob is a visible decision', async () => {
		await mandrillSendProvider.sendEmail(transport(), params);
		const body = lastBody();
		expect({
			track_opens: body['track_opens'],
			track_clicks: body['track_clicks'],
			auto_html: body['auto_html'],
			auto_text: body['auto_text'],
			url_strip_qs: body['url_strip_qs'],
			preserve_recipients: body['preserve_recipients'],
		}).toEqual({
			track_opens: false,
			track_clicks: false,
			auto_html: false,
			auto_text: false,
			url_strip_qs: false,
			preserve_recipients: false,
		});
	});

	it('omits every optional field when nothing configured or routed one', async () => {
		await mandrillSendProvider.sendEmail(transport(), params);
		const keys = Object.keys(lastBody());
		expect(keys).not.toContain('ip_pool');
		expect(keys).not.toContain('subaccount');
		expect(keys).not.toContain('return_path_domain');
	});
});

describe('MIME passthrough — the composed message reaches Mandrill intact', () => {
	it('carries our headers, both body parts and the envelope the composer built', async () => {
		await mandrillSendProvider.sendEmail(transport(), {
			...params,
			replyTo: 'reply@acme.com',
			headers: {
				'List-Unsubscribe': '<https://acme.com/u/abc>, <mailto:unsub@acme.com>',
				'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
				'List-Id': '<campaigns.acme.com>',
				'Feedback-ID': 'camp1:acme:campaign:owlat',
			},
		});

		const body = lastBody();
		const raw = body['raw_message'] as string;

		// RFC 8058 one-click unsubscribe survives — the header pair whose loss is
		// invisible until a mailbox provider downgrades the whole sending domain.
		expect(raw).toContain('List-Unsubscribe: <https://acme.com/u/abc>, <mailto:unsub@acme.com>');
		expect(raw).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
		expect(raw).toContain('List-Id: <campaigns.acme.com>');
		expect(raw).toContain('Feedback-ID: camp1:acme:campaign:owlat');
		expect(raw).toContain('Reply-To: reply@acme.com');
		expect(raw).toContain('Subject:');
		// The text part is the composer's (derived from UNTRACKED html), which is
		// why `auto_text` must stay off.
		expect(raw).toContain('text/plain');
		expect(raw).toContain('text/html');
		// The tracking query string the composer emitted is still on the link.
		expect(raw).toContain('utm=1');

		// The envelope names the composer's normalised addresses, not the raw
		// `params` strings — the address on the wire and the address the headers
		// were built around must be the same one.
		expect(body['to']).toEqual(['to@example.com']);
		expect(body['from_email']).toBe('from@acme.com');
	});

	it('carries attachments through the composed MIME', async () => {
		await mandrillSendProvider.sendEmail(transport(), {
			...params,
			attachments: [
				{
					filename: 'receipt.pdf',
					content: Buffer.from('%PDF-1.4 fake'),
					contentType: 'application/pdf',
				},
			],
		});

		const raw = lastBody()['raw_message'] as string;
		expect(raw).toContain('application/pdf');
		expect(raw).toContain('receipt.pdf');
		expect(raw).toContain(Buffer.from('%PDF-1.4 fake').toString('base64'));
	});
});

describe('subaccount / ip_pool / return_path_domain plumbing', () => {
	it('sends the configured subaccount from env, never from extras', async () => {
		vi.stubEnv('MANDRILL_SUBACCOUNT', 'owlat');
		_resetMandrillConfigCacheForTests();

		await mandrillSendProvider.sendEmail(transport(), params);

		expect(lastBody()['subaccount']).toBe('owlat');
	});

	it('falls back to MANDRILL_IP_POOL when the route named no pool', async () => {
		vi.stubEnv('MANDRILL_IP_POOL', 'Main Pool');
		_resetMandrillConfigCacheForTests();

		await mandrillSendProvider.sendEmail(transport(), params);

		expect(lastBody()['ip_pool']).toBe('Main Pool');
	});

	it("lets the ROUTE's pool win over the deployment default", async () => {
		vi.stubEnv('MANDRILL_IP_POOL', 'Main Pool');
		_resetMandrillConfigCacheForTests();

		await mandrillSendProvider.sendEmail(transport(), params, { ipPool: 'Campaign Pool' });

		expect(lastBody()['ip_pool']).toBe('Campaign Pool');
	});

	it('sends return_path_domain only when the probe verdict handed one over (D5)', async () => {
		await mandrillSendProvider.sendEmail(transport(), params, {
			returnPathDomain: 'bounces.acme.com',
		});
		expect(lastBody()['return_path_domain']).toBe('bounces.acme.com');

		await mandrillSendProvider.sendEmail(transport(), params, {});
		expect(Object.keys(lastBody())).not.toContain('return_path_domain');
	});
});

describe('per-recipient response parsing', () => {
	it.each(['sent', 'queued', 'scheduled'])(
		'%s is a success whose _id becomes the provider message id',
		async (status) => {
			global.fetch = accepted('mandrill-id-42', status);

			const result = await mandrillSendProvider.sendEmail(transport(), params);

			// `_id` is what the P2.1 webhook adapter joins on via
			// `by_provider_message_id`, so it must be returned verbatim.
			expect(result).toEqual({ success: true, id: 'mandrill-id-42' });
		}
	);

	it.each([
		['hard-bounce', EmailErrorCode.INVALID_RECIPIENT],
		['soft-bounce', EmailErrorCode.INVALID_RECIPIENT],
		['unsub', EmailErrorCode.INVALID_RECIPIENT],
		['custom', EmailErrorCode.INVALID_RECIPIENT],
		['spam', EmailErrorCode.CONTENT_REJECTED],
		['rule', EmailErrorCode.CONTENT_REJECTED],
		['unsigned', EmailErrorCode.INVALID_SENDER],
		['invalid-sender', EmailErrorCode.INVALID_SENDER],
		['test-mode-limit', EmailErrorCode.RATE_LIMIT],
	])('rejected/%s is a FAILURE classified %s', async (reason, expected) => {
		global.fetch = vi
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify([
						{ email: 'to@example.com', status: 'rejected', _id: 'x', reject_reason: reason },
					]),
					{ status: 200 }
				)
			) as unknown as typeof fetch;

		const result = await mandrillSendProvider.sendEmail(transport(), params);

		// An HTTP 200 that rejected the recipient is still a failed send.
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.errorCode).toBe(expected);
			expect(result.errorMessage).toContain(reason);
		}
	});

	it('invalid is an INVALID_RECIPIENT even with no reject_reason', async () => {
		global.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify([{ email: 'nope@', status: 'invalid', _id: '' }]), {
				status: 200,
			})
		) as unknown as typeof fetch;

		const result = await mandrillSendProvider.sendEmail(transport(), params);

		expect(result.success).toBe(false);
		if (!result.success) expect(result.errorCode).toBe(EmailErrorCode.INVALID_RECIPIENT);
	});

	it('an accepted status with no _id fails instead of returning an untrackable success', async () => {
		// A success we cannot join a webhook event to would strand the Send row in
		// `sent` forever. A classified, retryable failure is the honest answer.
		global.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify([{ email: 'to@example.com', status: 'sent' }]), {
				status: 200,
			})
		) as unknown as typeof fetch;

		const result = await mandrillSendProvider.sendEmail(transport(), params);

		expect(result.success).toBe(false);
		if (!result.success) expect(result.errorCode).toBe(EmailErrorCode.SERVER_ERROR);
	});

	it('an empty array is a SERVER_ERROR, not a silent success', async () => {
		global.fetch = vi
			.fn()
			.mockResolvedValue(new Response('[]', { status: 200 })) as unknown as typeof fetch;

		const result = await mandrillSendProvider.sendEmail(transport(), params);

		expect(result.success).toBe(false);
		if (!result.success) expect(result.errorCode).toBe(EmailErrorCode.SERVER_ERROR);
	});
});

describe('API-level failures', () => {
	it('classifies the Invalid_Key error body Mandrill returns with a 5xx', async () => {
		global.fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					status: 'error',
					code: -1,
					name: 'Invalid_Key',
					message: 'Invalid API key',
				}),
				{ status: 500 }
			)
		) as unknown as typeof fetch;

		const result = await mandrillSendProvider.sendEmail(transport(), params);

		expect(result.success).toBe(false);
		if (!result.success) expect(result.errorCode).toBe(EmailErrorCode.AUTH_FAILED);
	});

	it('honours a derivable Retry-After on a 429', async () => {
		global.fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({ status: 'error', name: 'GeneralError', message: 'slow down' }),
				{
					status: 429,
					headers: { 'Retry-After': '30' },
				}
			)
		) as unknown as typeof fetch;

		const result = await mandrillSendProvider.sendEmail(transport(), params);

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.errorCode).toBe(EmailErrorCode.RATE_LIMIT);
			expect(result.retryAfterMs).toBe(30_000);
		}
	});

	it('returns AUTH_FAILED without touching the network when the key is missing', async () => {
		vi.stubEnv('MANDRILL_API_KEY', '');
		_resetMandrillConfigCacheForTests();
		const fetchSpy = vi.fn();
		global.fetch = fetchSpy as unknown as typeof fetch;

		const result = await mandrillSendProvider.sendEmail(transport(), params);

		expect(result.success).toBe(false);
		if (!result.success) expect(result.errorCode).toBe(EmailErrorCode.AUTH_FAILED);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('never echoes an unstructured error body — the key travels IN the body', async () => {
		// The realistic leak: a proxy or gateway returns what it was sent. Copying
		// that into `errorMessage` would persist the API key into
		// `emailSends.errorMessage` and every log sink behind it.
		global.fetch = vi
			.fn()
			.mockImplementation(
				async (_url: string, init: RequestInit) =>
					new Response(init.body as string, { status: 400 })
			) as unknown as typeof fetch;

		const result = await mandrillSendProvider.sendEmail(transport(), params);

		expect(result.success).toBe(false);
		expect(JSON.stringify(result)).not.toContain('md-test-key');
		if (!result.success) {
			// Reported by status alone, because nothing in that body was ours.
			expect(result.errorMessage).toBe('Mandrill send failed (HTTP 400)');
		}
	});

	it('redacts the key even out of a STRUCTURED message field', async () => {
		// Defence in depth: a body that parses as a Mandrill error still has an
		// upstream-controlled `message`. The adapter is holding the key, so it
		// proves the key absent rather than assuming the upstream is well behaved.
		global.fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					status: 'error',
					name: 'ValidationError',
					message: 'bad request: key=md-test-key',
				}),
				{ status: 400 }
			)
		) as unknown as typeof fetch;

		const result = await mandrillSendProvider.sendEmail(transport(), params);

		expect(JSON.stringify(result)).not.toContain('md-test-key');
		if (!result.success) expect(result.errorMessage).toContain('[redacted]');
	});
});

describe('single-attempt contract', () => {
	it('does not retry internally — the dispatch helper owns the loop', async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(new Response('boom', { status: 503 })) as unknown as typeof fetch;
		global.fetch = fetchSpy;

		const result = await mandrillSendProvider.sendEmail(transport(), params);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.errorCode).toBe(EmailErrorCode.SERVER_ERROR);
	});

	it('caches config per transport id, not per kind', async () => {
		vi.stubEnv('SEND_TRANSPORT_INSTANCES', 'mandrill#eu');
		vi.stubEnv('MANDRILL_API_KEY__EU', 'md-eu-key');
		_resetSendTransportCacheForTests();
		_resetMandrillConfigCacheForTests();

		await mandrillSendProvider.sendEmail(transport(), params);
		await mandrillSendProvider.sendEmail(resolveSendTransport('mandrill#eu'), params);
		// Back to the default: a per-KIND cache would have been overwritten by now
		// and would send the EU instance's credential.
		await mandrillSendProvider.sendEmail(transport(), params);

		const spy = global.fetch as unknown as ReturnType<typeof vi.fn>;
		const keys = spy.mock.calls.map(
			(call) => (JSON.parse((call[1] as RequestInit).body as string) as { key: string }).key
		);
		expect(keys).toEqual(['md-test-key', 'md-eu-key', 'md-test-key']);
	});
});
