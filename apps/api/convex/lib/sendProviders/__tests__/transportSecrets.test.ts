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
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	global.fetch = originalFetch;
	_resetSendTransportCacheForTests();
	_resetResendClientCacheForTests();
	_resetSmtpConfigCacheForTests();
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
		global.fetch = vi.fn().mockImplementation(
			async () =>
				new Response(JSON.stringify({ success: true, id: 'x' }), {
					status: 200,
				})
		) as unknown as typeof fetch;

		await sendProviderDispatch(fakeCtx(), 'mta', params);
		await sendProviderDispatch(fakeCtx(), 'resend', params);
		await sendProviderDispatch(fakeCtx(), 'smtp', params);
		await sendProviderDispatch(fakeCtx(), namedSendTransportId('smtp', 'backup'), params);

		expectNoSecret(written.join('\n'));
	});
});
