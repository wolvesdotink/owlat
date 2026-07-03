import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SESClient, SendEmailCommand, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { mtaSendProvider } from '../mta';
import { sesSendProvider, _resetSesClientCacheForTests } from '../ses';
import { resendSendProvider, _resetResendClientCacheForTests } from '../resend';
import { EmailErrorCode, isRetryableErrorCode } from '../types';
import { sendProviderDispatch } from '../dispatch';

// Capture the args passed to the Resend SDK's `emails.send` so the idempotency-
// key forwarding (FIX H1) can be asserted without a live API call. The
// missing-API-key tests still exercise the real `getResendClient` guard, which
// short-circuits before instantiating this mock.
const { resendSendMock } = vi.hoisted(() => ({
	resendSendMock: vi.fn().mockResolvedValue({ data: { id: 'resend-msg-1' }, error: null }),
}));
vi.mock('resend', () => ({
	Resend: class {
		emails = { send: resendSendMock };
	},
}));

// ──────────────────────────────────────────────────────────────────────────
// MTA adapter
// ──────────────────────────────────────────────────────────────────────────

describe('mtaSendProvider', () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		vi.stubEnv('MTA_API_URL', 'https://mta.test');
		vi.stubEnv('MTA_API_KEY', 'test-key');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		global.fetch = originalFetch;
	});

	it('kind discriminator matches the registry key', () => {
		expect(mtaSendProvider.kind).toBe('mta');
	});

	it('declares the documented retry schedule', () => {
		expect([...mtaSendProvider.retryDelays]).toEqual([1000, 5000]);
	});

	it('sendEmail returns success on HTTP 200 with valid body', async () => {
		global.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true, id: 'msg-123' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const result = await mtaSendProvider.sendEmail({
			to: 'to@example.com',
			from: 'from@example.com',
			subject: 'hi',
			html: '<p>hi</p>',
		});

		expect(result).toEqual({ success: true, id: 'msg-123' });
	});

	it('sendEmail does NOT retry internally (single-attempt contract)', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response('500 Internal Server Error', { status: 500 }),
		);
		global.fetch = fetchSpy;

		const result = await mtaSendProvider.sendEmail({
			to: 'to@example.com',
			from: 'from@example.com',
			subject: 'hi',
			html: '<p>hi</p>',
		});

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.errorCode).toBe(EmailErrorCode.SERVER_ERROR);
		}
	});

	it('sendEmail classifies HTTP 429 as RATE_LIMIT', async () => {
		global.fetch = vi.fn().mockResolvedValue(
			new Response('Too many requests', { status: 429 }),
		);

		const result = await mtaSendProvider.sendEmail({
			to: 'to@example.com',
			from: 'from@example.com',
			subject: 'hi',
			html: '<p>hi</p>',
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.errorCode).toBe(EmailErrorCode.RATE_LIMIT);
		}
	});

	it('sendEmail returns AUTH_FAILED when MTA_API_URL is missing', async () => {
		vi.unstubAllEnvs();
		// The vitest setup seeds a default MTA_API_URL; clear it to exercise the
		// missing-URL path explicitly.
		vi.stubEnv('MTA_API_URL', '');
		vi.stubEnv('MTA_API_KEY', 'test-key');

		const result = await mtaSendProvider.sendEmail({
			to: 'to@example.com',
			from: 'from@example.com',
			subject: 'hi',
			html: '<p>hi</p>',
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.errorCode).toBe(EmailErrorCode.AUTH_FAILED);
		}
	});

	it('sendEmail wires MTA extras (ipPool, dkimDomain) into the POST body', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true, id: 'msg-x' }), { status: 200 }),
		);
		global.fetch = fetchSpy;

		await mtaSendProvider.sendEmail(
			{ to: 'to@example.com', from: 'from@example.com', subject: 'hi', html: '<p>hi</p>' },
			{ ipPool: 'campaign', dkimDomain: 'example.com', messageId: 'fixed-id' },
		);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const callArgs = fetchSpy.mock.calls[0]!;
		const body = JSON.parse(callArgs[1]!.body as string);
		expect(body.ipPool).toBe('campaign');
		expect(body.dkimDomain).toBe('example.com');
		expect(body.messageId).toBe('fixed-id');
	});

	// Audit PR-74 (3) — DKIM alignment carries DMARC (RFC 7489 §3.1): when the
	// caller supplies no explicit `dkimDomain`, the MTA send body MUST default it
	// to the From-address domain so the DKIM `d=` aligns with the RFC5322.From
	// domain. A From of `x@acme.com` therefore signs under `acme.com`.
	it('defaults dkimDomain to the From-address domain when no explicit dkimDomain extra is given (PR-74)', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true, id: 'msg-align' }), { status: 200 }),
		);
		global.fetch = fetchSpy;

		await mtaSendProvider.sendEmail(
			{ to: 'to@example.com', from: 'x@acme.com', subject: 'hi', html: '<p>hi</p>' },
			// No dkimDomain — must fall back to the From domain for DMARC alignment.
			{ messageId: 'send_align1' },
		);

		const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
		expect(body.dkimDomain).toBe('acme.com');
	});

	it('strips a trailing ">" when defaulting dkimDomain from an angle-bracket From (PR-74)', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true, id: 'msg-align2' }), { status: 200 }),
		);
		global.fetch = fetchSpy;

		await mtaSendProvider.sendEmail(
			{ to: 'to@example.com', from: 'Acme <x@acme.com>', subject: 'hi', html: '<p>hi</p>' },
			{ messageId: 'send_align2' },
		);

		const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
		expect(body.dkimDomain).toBe('acme.com');
	});

	it('uses the supplied messageId verbatim — the dedup key is STABLE, not a per-attempt UUID (FIX H1)', async () => {
		// The MTA `/send` route SET-NX dedups on `messageId`; a stable
		// Send-row-derived key is what makes a surviving retry de-dupe instead
		// of double-deliver.
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true, id: 'msg-y' }), { status: 200 }),
		);
		global.fetch = fetchSpy;

		const stableKey = 'send_abc123';
		await mtaSendProvider.sendEmail(
			{ to: 'to@example.com', from: 'from@example.com', subject: 'hi', html: '<p>hi</p>' },
			{ messageId: stableKey },
		);
		await mtaSendProvider.sendEmail(
			{ to: 'to@example.com', from: 'from@example.com', subject: 'hi', html: '<p>hi</p>' },
			{ messageId: stableKey },
		);

		const body0 = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
		const body1 = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string);
		expect(body0.messageId).toBe(stableKey);
		expect(body1.messageId).toBe(stableKey);
	});

	it('falls back to a fresh UUID only when no messageId extra is supplied (legacy path)', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true, id: 'msg-z' }), { status: 200 }),
		);
		global.fetch = fetchSpy;

		await mtaSendProvider.sendEmail({
			to: 'to@example.com',
			from: 'from@example.com',
			subject: 'hi',
			html: '<p>hi</p>',
		});

		const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
		expect(typeof body.messageId).toBe('string');
		expect(body.messageId.length).toBeGreaterThan(0);
		// Not derived from a Send row — the worker always supplies a `send_…`
		// key, so this branch is the pre-existing UUID fallback.
		expect(body.messageId.startsWith('send_')).toBe(false);
	});

	describe('categorizeError', () => {
		it('maps HTTP 429 to RATE_LIMIT', () => {
			expect(mtaSendProvider.categorizeError('whatever', 429)).toBe(EmailErrorCode.RATE_LIMIT);
		});
		it('maps HTTP 5xx to SERVER_ERROR', () => {
			expect(mtaSendProvider.categorizeError('whatever', 500)).toBe(EmailErrorCode.SERVER_ERROR);
			expect(mtaSendProvider.categorizeError('whatever', 503)).toBe(EmailErrorCode.SERVER_ERROR);
		});
		it('maps HTTP 401/403 to AUTH_FAILED', () => {
			expect(mtaSendProvider.categorizeError('whatever', 401)).toBe(EmailErrorCode.AUTH_FAILED);
			expect(mtaSendProvider.categorizeError('whatever', 403)).toBe(EmailErrorCode.AUTH_FAILED);
		});
		it('maps network timeout text to SERVER_ERROR', () => {
			expect(mtaSendProvider.categorizeError('Request timeout')).toBe(EmailErrorCode.SERVER_ERROR);
			expect(mtaSendProvider.categorizeError('AbortError: aborted')).toBe(EmailErrorCode.SERVER_ERROR);
			expect(mtaSendProvider.categorizeError('connect ECONNREFUSED 1.2.3.4:443')).toBe(EmailErrorCode.SERVER_ERROR);
		});
		it('maps "invalid recipient" text to INVALID_RECIPIENT', () => {
			expect(mtaSendProvider.categorizeError('Invalid recipient address')).toBe(EmailErrorCode.INVALID_RECIPIENT);
		});
		it('maps DKIM/domain text to INVALID_SENDER', () => {
			expect(mtaSendProvider.categorizeError('DKIM signing failed')).toBe(EmailErrorCode.INVALID_SENDER);
			expect(mtaSendProvider.categorizeError('Domain not verified')).toBe(EmailErrorCode.INVALID_SENDER);
		});
		it('maps spam/blocked text to CONTENT_REJECTED', () => {
			expect(mtaSendProvider.categorizeError('Email marked as spam')).toBe(EmailErrorCode.CONTENT_REJECTED);
			expect(mtaSendProvider.categorizeError('Recipient server blocked the message')).toBe(EmailErrorCode.CONTENT_REJECTED);
		});
		it('maps API-key text to AUTH_FAILED', () => {
			expect(mtaSendProvider.categorizeError('Invalid API key')).toBe(EmailErrorCode.AUTH_FAILED);
		});
		it('falls through to UNKNOWN for unrecognized errors', () => {
			expect(mtaSendProvider.categorizeError('mystery error')).toBe(EmailErrorCode.UNKNOWN);
		});
	});
});

// ──────────────────────────────────────────────────────────────────────────
// SES adapter
// ──────────────────────────────────────────────────────────────────────────

describe('sesSendProvider', () => {
	it('kind discriminator matches the registry key', () => {
		expect(sesSendProvider.kind).toBe('ses');
	});

	it('declares the documented retry schedule', () => {
		expect([...sesSendProvider.retryDelays]).toEqual([1000, 5000, 30000]);
	});

	describe('categorizeError', () => {
		beforeEach(() => _resetSesClientCacheForTests());
		afterEach(() => _resetSesClientCacheForTests());

		it('maps SES Throttling error to RATE_LIMIT', () => {
			expect(sesSendProvider.categorizeError('Throttling: Maximum sending rate exceeded')).toBe(EmailErrorCode.RATE_LIMIT);
			expect(sesSendProvider.categorizeError('TooManyRequestsException: too many requests')).toBe(EmailErrorCode.RATE_LIMIT);
		});
		it('maps SES AccountSendingPausedException to RATE_LIMIT', () => {
			expect(sesSendProvider.categorizeError('AccountSendingPausedException')).toBe(EmailErrorCode.RATE_LIMIT);
		});
		it('maps SES ServiceUnavailable / InternalFailure to SERVER_ERROR', () => {
			expect(sesSendProvider.categorizeError('ServiceUnavailable: try again')).toBe(EmailErrorCode.SERVER_ERROR);
			expect(sesSendProvider.categorizeError('InternalFailure')).toBe(EmailErrorCode.SERVER_ERROR);
		});
		it('maps SES MailFromDomainNotVerified to INVALID_SENDER', () => {
			expect(sesSendProvider.categorizeError('MailFromDomainNotVerified: example.com not verified')).toBe(EmailErrorCode.INVALID_SENDER);
		});
		it('maps SES InvalidClientTokenId / SignatureDoesNotMatch to AUTH_FAILED', () => {
			expect(sesSendProvider.categorizeError('InvalidClientTokenId: bad creds')).toBe(EmailErrorCode.AUTH_FAILED);
			expect(sesSendProvider.categorizeError('SignatureDoesNotMatch: oops')).toBe(EmailErrorCode.AUTH_FAILED);
		});
		it('maps SES MessageRejected to CONTENT_REJECTED', () => {
			expect(sesSendProvider.categorizeError('MessageRejected: spam content')).toBe(EmailErrorCode.CONTENT_REJECTED);
		});
		it('maps InvalidParameterValue + Destination to INVALID_RECIPIENT', () => {
			expect(sesSendProvider.categorizeError('InvalidParameterValue: Destination address is malformed')).toBe(EmailErrorCode.INVALID_RECIPIENT);
		});
		it('maps HTTP 429 to RATE_LIMIT', () => {
			expect(sesSendProvider.categorizeError('whatever', 429)).toBe(EmailErrorCode.RATE_LIMIT);
		});
		it('falls through to UNKNOWN for unrecognized errors', () => {
			expect(sesSendProvider.categorizeError('weird error')).toBe(EmailErrorCode.UNKNOWN);
		});
	});

	it('sendEmail returns AUTH_FAILED when AWS credentials are missing', async () => {
		vi.unstubAllEnvs();
		_resetSesClientCacheForTests();

		const result = await sesSendProvider.sendEmail({
			to: 'to@example.com',
			from: 'from@example.com',
			subject: 'hi',
			html: '<p>hi</p>',
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.errorCode).toBe(EmailErrorCode.AUTH_FAILED);
		}
	});

	// ────────────────────────────────────────────────────────────────────────
	// FIX PR-17: the no-attachment path must emit raw MIME when custom headers
	// are present, so List-Unsubscribe / List-Unsubscribe-Post (RFC 8058) are
	// not silently dropped by SES `SendEmailCommand`.
	// ────────────────────────────────────────────────────────────────────────
	describe('no-attachment send with custom headers (FIX PR-17)', () => {
		let sendSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			vi.stubEnv('AWS_SES_REGION', 'us-east-1');
			vi.stubEnv('AWS_SES_ACCESS_KEY_ID', 'AKIATEST');
			vi.stubEnv('AWS_SES_SECRET_ACCESS_KEY', 'secret');
			_resetSesClientCacheForTests();
			// Capture the command object passed to SESClient.send without making a
			// real AWS call. The real SendRawEmailCommand / SendEmailCommand
			// classes are still constructed by the adapter, so `instanceof` holds.
			sendSpy = vi
				.spyOn(SESClient.prototype, 'send')
				.mockResolvedValue({ MessageId: 'ses-msg-1' } as never);
		});

		afterEach(() => {
			sendSpy.mockRestore();
			vi.unstubAllEnvs();
			_resetSesClientCacheForTests();
		});

		it('emits SendRawEmailCommand whose RawMessage carries both List-Unsubscribe header lines', async () => {
			const result = await sesSendProvider.sendEmail({
				to: 'to@example.com',
				from: 'from@example.com',
				subject: 'hi',
				html: '<p>hi</p>',
				headers: {
					'List-Unsubscribe': '<https://example.com/u/abc>, <mailto:unsub@example.com>',
					'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
				},
				// NO attachments — this is the common campaign path.
			});

			expect(result).toEqual({ success: true, id: 'ses-msg-1' });
			expect(sendSpy).toHaveBeenCalledTimes(1);

			const command = sendSpy.mock.calls[0]![0];
			// Must be the raw path, not the plain SendEmailCommand (which drops headers).
			expect(command).toBeInstanceOf(SendRawEmailCommand);
			expect(command).not.toBeInstanceOf(SendEmailCommand);

			const rawData = (command as SendRawEmailCommand).input.RawMessage!.Data!;
			const decoded = Buffer.from(rawData as Uint8Array).toString('utf-8');

			expect(decoded).toContain(
				'List-Unsubscribe: <https://example.com/u/abc>, <mailto:unsub@example.com>',
			);
			expect(decoded).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
		});

		it('still uses plain SendEmailCommand when there are no headers and no attachments', async () => {
			const result = await sesSendProvider.sendEmail({
				to: 'to@example.com',
				from: 'from@example.com',
				subject: 'hi',
				html: '<p>hi</p>',
			});

			expect(result).toEqual({ success: true, id: 'ses-msg-1' });
			expect(sendSpy).toHaveBeenCalledTimes(1);
			expect(sendSpy.mock.calls[0]![0]).toBeInstanceOf(SendEmailCommand);
		});
	});

	// ────────────────────────────────────────────────────────────────────────
	// FIX: SES send is idempotent under dispatch retry (no double-delivery).
	// SES has no server-side dedup, so a post-dispatch timeout — where AWS may
	// already have accepted (and delivered) the message but the response was
	// lost — MUST be classified TERMINAL, so the dispatch helper does not
	// re-send and deliver a SECOND copy.
	// ────────────────────────────────────────────────────────────────────────
	describe('post-dispatch timeout is terminal (no double-delivery)', () => {
		let sendSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			vi.stubEnv('AWS_SES_REGION', 'us-east-1');
			vi.stubEnv('AWS_SES_ACCESS_KEY_ID', 'AKIATEST');
			vi.stubEnv('AWS_SES_SECRET_ACCESS_KEY', 'secret');
			_resetSesClientCacheForTests();
		});

		afterEach(() => {
			sendSpy.mockRestore();
			vi.unstubAllEnvs();
			_resetSesClientCacheForTests();
		});

		it('classifies an SDK TimeoutError as the non-retryable AMBIGUOUS_TIMEOUT code', async () => {
			const timeout = new Error('socket timed out');
			timeout.name = 'TimeoutError';
			sendSpy = vi.spyOn(SESClient.prototype, 'send').mockRejectedValue(timeout as never);

			const result = await sesSendProvider.sendEmail({
				to: 'to@example.com',
				from: 'from@example.com',
				subject: 'hi',
				html: '<p>hi</p>',
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.errorCode).toBe(EmailErrorCode.AMBIGUOUS_TIMEOUT);
			}
			// The dispatch helper only re-sends retryable codes — this one is not.
			expect(isRetryableErrorCode(EmailErrorCode.AMBIGUOUS_TIMEOUT)).toBe(false);
		});

		it('sendProviderDispatch does NOT re-send after a timeout (exactly one SES send call)', async () => {
			const timeout = new Error('socket timed out');
			timeout.name = 'TimeoutError';
			sendSpy = vi.spyOn(SESClient.prototype, 'send').mockRejectedValue(timeout as never);

			const ctx = { scheduler: { runAfter: vi.fn().mockResolvedValue(undefined) } };
			const dispatched = await sendProviderDispatch(
				// The dispatch helper only touches ctx.scheduler for health recording.
				ctx as unknown as Parameters<typeof sendProviderDispatch>[0],
				'ses',
				{ to: 'to@example.com', from: 'from@example.com', subject: 'hi', html: '<p>hi</p>' },
			);

			// A SECOND SES SendEmail would double-deliver. There must be exactly one.
			expect(sendSpy).toHaveBeenCalledTimes(1);
			expect(dispatched.attempts).toBe(1);
			expect(dispatched.result.success).toBe(false);
			if (!dispatched.result.success) {
				expect(dispatched.result.errorCode).toBe(EmailErrorCode.AMBIGUOUS_TIMEOUT);
			}
		});

		it('an explicit AWS ServiceUnavailable (not accepted) stays the retryable SERVER_ERROR', async () => {
			// Regression guard: only ambiguous timeouts become terminal. A real AWS
			// 5xx means the request was NOT accepted, so it stays retryable (the
			// dispatch loop will re-send) — we must not over-broaden the terminal
			// classification. Asserted at the adapter level to avoid the real
			// retry-backoff delays the dispatch loop would incur.
			const err = new Error('ServiceUnavailable: try again later');
			err.name = 'ServiceUnavailable';
			sendSpy = vi.spyOn(SESClient.prototype, 'send').mockRejectedValue(err as never);

			const result = await sesSendProvider.sendEmail({
				to: 'to@example.com',
				from: 'from@example.com',
				subject: 'hi',
				html: '<p>hi</p>',
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.errorCode).toBe(EmailErrorCode.SERVER_ERROR);
			}
			expect(isRetryableErrorCode(EmailErrorCode.SERVER_ERROR)).toBe(true);
		});
	});
});

// ──────────────────────────────────────────────────────────────────────────
// Resend adapter
// ──────────────────────────────────────────────────────────────────────────

describe('resendSendProvider', () => {
	it('kind discriminator matches the registry key', () => {
		expect(resendSendProvider.kind).toBe('resend');
	});

	it('declares the documented retry schedule', () => {
		expect([...resendSendProvider.retryDelays]).toEqual([1000, 5000, 30000]);
	});

	describe('categorizeError', () => {
		beforeEach(() => _resetResendClientCacheForTests());
		afterEach(() => _resetResendClientCacheForTests());

		it('maps rate_limit_exceeded to RATE_LIMIT', () => {
			expect(resendSendProvider.categorizeError('rate_limit_exceeded: Too many requests')).toBe(EmailErrorCode.RATE_LIMIT);
		});
		it('maps internal_server_error / application_error to SERVER_ERROR', () => {
			expect(resendSendProvider.categorizeError('internal_server_error: oops')).toBe(EmailErrorCode.SERVER_ERROR);
			expect(resendSendProvider.categorizeError('application_error: oops')).toBe(EmailErrorCode.SERVER_ERROR);
			expect(resendSendProvider.categorizeError('Resend API call timed out')).toBe(EmailErrorCode.SERVER_ERROR);
		});
		it('maps invalid_to_field to INVALID_RECIPIENT', () => {
			expect(resendSendProvider.categorizeError('invalid_to_field: address malformed')).toBe(EmailErrorCode.INVALID_RECIPIENT);
		});
		it('maps invalid_from_field / not_verified to INVALID_SENDER', () => {
			expect(resendSendProvider.categorizeError('invalid_from_field: domain not registered')).toBe(EmailErrorCode.INVALID_SENDER);
			expect(resendSendProvider.categorizeError('not_verified: example.com')).toBe(EmailErrorCode.INVALID_SENDER);
		});
		it('maps missing_api_key / invalid_api_key to AUTH_FAILED', () => {
			expect(resendSendProvider.categorizeError('missing_api_key: header absent')).toBe(EmailErrorCode.AUTH_FAILED);
			expect(resendSendProvider.categorizeError('invalid_api_key: bad token')).toBe(EmailErrorCode.AUTH_FAILED);
		});
		it('maps spam/blocked text to CONTENT_REJECTED', () => {
			expect(resendSendProvider.categorizeError('validation_error: content flagged as spam')).toBe(EmailErrorCode.CONTENT_REJECTED);
			expect(resendSendProvider.categorizeError('Recipient server blocked the message')).toBe(EmailErrorCode.CONTENT_REJECTED);
		});
		it('falls through to UNKNOWN for unrecognized errors', () => {
			expect(resendSendProvider.categorizeError('mystery error')).toBe(EmailErrorCode.UNKNOWN);
		});
	});

	it('sendEmail returns AUTH_FAILED when RESEND_API_KEY is missing', async () => {
		vi.unstubAllEnvs();
		_resetResendClientCacheForTests();

		const result = await resendSendProvider.sendEmail({
			to: 'to@example.com',
			from: 'from@example.com',
			subject: 'hi',
			html: '<p>hi</p>',
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.errorCode).toBe(EmailErrorCode.AUTH_FAILED);
		}
	});

	describe('idempotency-key forwarding (FIX H1)', () => {
		beforeEach(() => {
			vi.stubEnv('RESEND_API_KEY', 'test-key');
			_resetResendClientCacheForTests();
			resendSendMock.mockClear();
			resendSendMock.mockResolvedValue({ data: { id: 'resend-msg-1' }, error: null });
		});
		afterEach(() => {
			vi.unstubAllEnvs();
			_resetResendClientCacheForTests();
		});

		it('forwards the idempotencyKey extra as the Resend SDK Idempotency-Key option', async () => {
			const result = await resendSendProvider.sendEmail(
				{ to: 'to@example.com', from: 'from@example.com', subject: 'hi', html: '<p>hi</p>' },
				{ idempotencyKey: 'send_xyz789' },
			);

			expect(result).toEqual({ success: true, id: 'resend-msg-1' });
			expect(resendSendMock).toHaveBeenCalledTimes(1);
			// Second positional arg is the request options carrying idempotencyKey.
			expect(resendSendMock.mock.calls[0]![1]).toEqual({ idempotencyKey: 'send_xyz789' });
		});

		it('omits the options arg when no idempotencyKey is supplied (legacy path)', async () => {
			await resendSendProvider.sendEmail({
				to: 'to@example.com',
				from: 'from@example.com',
				subject: 'hi',
				html: '<p>hi</p>',
			});

			expect(resendSendMock).toHaveBeenCalledTimes(1);
			expect(resendSendMock.mock.calls[0]![1]).toBeUndefined();
		});
	});
});
