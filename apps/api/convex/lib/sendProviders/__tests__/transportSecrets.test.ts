/**
 * P2-2 (d) — sealed config never leaves the adapter that resolved it.
 *
 * A transport RECORD is a routing artefact: ids, labels, retry schedules and
 * the NAMES of the variables the config lives in. The values behind those names
 * are resolved inside the adapter at send time and must never appear on a
 * dispatch result, in an error message, or in anything written to the console.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { resendSendMock, smtpSendMock } = vi.hoisted(() => ({
	resendSendMock: vi.fn(),
	smtpSendMock: vi.fn(),
}));

vi.mock('resend', () => ({
	Resend: class {
		emails = { send: resendSendMock };
		constructor(apiKey: string) {
			void apiKey;
		}
	},
}));

vi.mock('@owlat/smtp-client', () => ({
	sendMessage: (input: unknown) => smtpSendMock(input),
	isSmtpError: () => false,
}));

import { sendProviderDispatch } from '../dispatch';
import { _resetResendClientCacheForTests } from '../resend';
import { _resetSmtpConfigCacheForTests } from '../smtp';
import { _resetMandrillConfigCacheForTests } from '../mandrill';
import {
	_resetSendTransportCacheForTests,
	listSendTransports,
	namedSendTransportId,
	resolveSendTransport,
} from '../transports';

const SECRETS = [
	'mta-super-secret',
	'resend-super-secret',
	'relay-super-secret',
	'backup-super-secret',
	// Mandrill's key is the sharpest case in this file: it travels in the REQUEST
	// BODY (Mandrill convention), so it sits one `JSON.stringify` away from any
	// error path that echoes what was sent.
	'mandrill-super-secret',
];

function expectNoSecret(text: string): void {
	for (const secret of SECRETS) {
		expect(text).not.toContain(secret);
	}
}

function fakeCtx(): Parameters<typeof sendProviderDispatch>[0] {
	return {
		runMutation: vi.fn(async () => true),
		scheduler: { runAfter: vi.fn(async () => undefined) },
	} as unknown as Parameters<typeof sendProviderDispatch>[0];
}

const params = {
	to: 'to@example.com',
	from: 'from@example.com',
	subject: 'Subject',
	html: '<p>Hello</p>',
};

const originalFetch = global.fetch;

beforeEach(() => {
	_resetSendTransportCacheForTests();
	_resetResendClientCacheForTests();
	_resetSmtpConfigCacheForTests();
	_resetMandrillConfigCacheForTests();
	resendSendMock.mockReset();
	resendSendMock.mockResolvedValue({ data: { id: 'resend-1' }, error: null });
	smtpSendMock.mockReset();
	smtpSendMock.mockResolvedValue(undefined);

	vi.stubEnv('SEND_TRANSPORT_INSTANCES', 'smtp#backup');
	vi.stubEnv('MTA_API_URL', 'https://mta.test');
	vi.stubEnv('MTA_API_KEY', 'mta-super-secret');
	vi.stubEnv('RESEND_API_KEY', 'resend-super-secret');
	vi.stubEnv('SMTP_RELAY_HOST', 'smtp.primary.test');
	vi.stubEnv('SMTP_RELAY_USERNAME', 'primary-user');
	vi.stubEnv('SMTP_RELAY_PASSWORD', 'relay-super-secret');
	vi.stubEnv('SMTP_RELAY_HOST__BACKUP', 'smtp.backup.test');
	vi.stubEnv('SMTP_RELAY_USERNAME__BACKUP', 'backup-user');
	vi.stubEnv('SMTP_RELAY_PASSWORD__BACKUP', 'backup-super-secret');
	vi.stubEnv('MANDRILL_API_KEY', 'mandrill-super-secret');
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	global.fetch = originalFetch;
	_resetSendTransportCacheForTests();
	_resetResendClientCacheForTests();
	_resetSmtpConfigCacheForTests();
	_resetMandrillConfigCacheForTests();
});

describe('transport records carry names, never values', () => {
	it('exposes only variable names on every listed transport', () => {
		for (const transport of listSendTransports()) {
			expectNoSecret(JSON.stringify(transport));
		}
		const backup = resolveSendTransport(namedSendTransportId('smtp', 'backup'));
		expect(backup.requiredEnvVars).toContain('SMTP_RELAY_PASSWORD__BACKUP');
		expectNoSecret(JSON.stringify(backup));
	});

	it('has no property whose value is a resolved credential', () => {
		const record = resolveSendTransport('smtp') as unknown as Record<string, unknown>;
		for (const value of Object.values(record)) {
			expectNoSecret(JSON.stringify(value ?? null));
		}
	});
});

describe('dispatch results and errors carry no sealed config', () => {
	it('keeps the MTA api key out of a successful dispatch result', async () => {
		global.fetch = vi.fn().mockImplementation(
			async () =>
				new Response(JSON.stringify({ success: true, id: 'x' }), {
					status: 200,
				})
		) as unknown as typeof fetch;

		const dispatched = await sendProviderDispatch(fakeCtx(), 'mta', params);

		expect(dispatched.transportId).toBe('mta');
		expectNoSecret(JSON.stringify(dispatched));
	});

	it('keeps the MTA api key out of a FAILED dispatch result, including the upstream body', async () => {
		global.fetch = vi
			.fn()
			.mockImplementation(
				async () => new Response('upstream rejected the request', { status: 400 })
			) as unknown as typeof fetch;

		const dispatched = await sendProviderDispatch(fakeCtx(), 'mta', params);

		expect(dispatched.result.success).toBe(false);
		expectNoSecret(JSON.stringify(dispatched));
	});

	it('keeps the Mandrill key out of a failed dispatch even when the upstream echoes the request', async () => {
		// Mandrill takes its credential in the JSON BODY, so an upstream that echoes
		// what it received hands the key straight back on the error path. The
		// adapter must classify from that body without ever copying it — or the key
		// lands in `emailSends.errorMessage` and every log sink downstream.
		global.fetch = vi.fn().mockImplementation(
			async (_url: string, init: RequestInit) =>
				// The worst realistic case: the error body IS the request body.
				new Response(init.body as string, { status: 400 })
		) as unknown as typeof fetch;

		const dispatched = await sendProviderDispatch(fakeCtx(), 'mandrill', params);

		expect(dispatched.result.success).toBe(false);
		expectNoSecret(JSON.stringify(dispatched));
	});

	it('names the variable, never the value, when a named instance is misconfigured', () => {
		vi.stubEnv('SMTP_RELAY_PASSWORD__BACKUP', '');
		_resetSendTransportCacheForTests();
		let message = '';
		try {
			resolveSendTransport(namedSendTransportId('smtp', 'backup'));
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain('Unresolvable send transport');
		expectNoSecret(message);
	});

	it('writes nothing containing a credential to the console during a dispatch', async () => {
		const written: string[] = [];
		for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				written.push(args.map((arg) => String(arg)).join(' '));
			});
		}
		// Two HTTP transports share `fetch` here and their success bodies differ, so
		// answer each in its own dialect — otherwise the Mandrill dispatch reads the
		// MTA's body as a malformed response and burns the whole retry schedule.
		global.fetch = vi
			.fn()
			.mockImplementation(async (url: string) =>
				String(url).includes('mandrillapp.com')
					? new Response(
							JSON.stringify([{ email: 'to@example.com', status: 'sent', _id: 'mandrill-1' }]),
							{ status: 200 }
						)
					: new Response(JSON.stringify({ success: true, id: 'x' }), { status: 200 })
			) as unknown as typeof fetch;

		await sendProviderDispatch(fakeCtx(), 'mta', params);
		await sendProviderDispatch(fakeCtx(), 'resend', params);
		await sendProviderDispatch(fakeCtx(), 'smtp', params);
		await sendProviderDispatch(fakeCtx(), namedSendTransportId('smtp', 'backup'), params);
		await sendProviderDispatch(fakeCtx(), 'mandrill', params);

		expectNoSecret(written.join('\n'));
	});
});
