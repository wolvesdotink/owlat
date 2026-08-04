/**
 * P2-2 (b) — THE POINT OF THE PIECE.
 *
 * Two transports of the SAME kind, with different configuration, coexist and
 * dispatch independently. Under the old kind-keyed dispatch this was
 * impossible: one kind meant one deployment-wide configuration, so a
 * deployment could not keep a warm fallback while trialling a second relay and
 * the ramp had no way to name "the reference transport for this cell".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { resendKeys, resendSendMock, smtpSendMock } = vi.hoisted(() => ({
	resendKeys: [] as string[],
	resendSendMock: vi.fn(),
	smtpSendMock: vi.fn(),
}));

vi.mock('resend', () => ({
	Resend: class {
		emails = { send: resendSendMock };
		constructor(apiKey: string) {
			resendKeys.push(apiKey);
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
	resendKeys.length = 0;
	resendSendMock.mockReset();
	resendSendMock.mockResolvedValue({ data: { id: 'resend-1' }, error: null });
	smtpSendMock.mockReset();
	smtpSendMock.mockResolvedValue(undefined);

	vi.stubEnv('SEND_TRANSPORT_INSTANCES', 'mta#secondary, smtp#backup ,resend#trial');

	vi.stubEnv('MTA_API_URL', 'https://mta-primary.test');
	vi.stubEnv('MTA_API_KEY', 'mta-primary-key');
	vi.stubEnv('MTA_API_URL__SECONDARY', 'https://mta-secondary.test');
	vi.stubEnv('MTA_API_KEY__SECONDARY', 'mta-secondary-key');

	vi.stubEnv('SMTP_RELAY_HOST', 'smtp.primary.test');
	vi.stubEnv('SMTP_RELAY_USERNAME', 'primary-user');
	vi.stubEnv('SMTP_RELAY_PASSWORD', 'primary-pass');
	vi.stubEnv('SMTP_RELAY_HOST__BACKUP', 'smtp.backup.test');
	vi.stubEnv('SMTP_RELAY_PORT__BACKUP', '465');
	vi.stubEnv('SMTP_RELAY_SECURE__BACKUP', 'true');
	vi.stubEnv('SMTP_RELAY_USERNAME__BACKUP', 'backup-user');
	vi.stubEnv('SMTP_RELAY_PASSWORD__BACKUP', 'backup-pass');

	vi.stubEnv('RESEND_API_KEY', 'resend-primary-key');
	vi.stubEnv('RESEND_API_KEY__TRIAL', 'resend-trial-key');
});

afterEach(() => {
	vi.unstubAllEnvs();
	global.fetch = originalFetch;
	_resetSendTransportCacheForTests();
	_resetResendClientCacheForTests();
	_resetSmtpConfigCacheForTests();
});

describe('two transports of the same kind', () => {
	it('lists the default instance plus each declared named instance', () => {
		const ids = listSendTransports().map((transport) => transport.id);
		expect(ids).toContain('mta');
		expect(ids).toContain('mta#secondary');
		expect(ids).toContain('smtp');
		expect(ids).toContain('smtp#backup');
		expect(ids).toContain('resend');
		expect(ids).toContain('resend#trial');
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('resolves distinct records that read distinct variables for the same kind', () => {
		const primary = resolveSendTransport('smtp');
		const backup = resolveSendTransport(namedSendTransportId('smtp', 'backup'));

		expect(primary.kind).toBe('smtp');
		expect(backup.kind).toBe('smtp');
		expect(primary.id).not.toBe(backup.id);
		expect(primary.instanceKey).toBeNull();
		expect(backup.instanceKey).toBe('backup');
		expect(primary.requiredEnvVars).toContain('SMTP_RELAY_HOST');
		expect(backup.requiredEnvVars).toContain('SMTP_RELAY_HOST__BACKUP');
		expect(backup.requiredEnvVars).not.toContain('SMTP_RELAY_HOST');
	});

	it('dispatches two mta transports to two different endpoints with their own keys', async () => {
		const fetchSpy = vi.fn().mockImplementation(
			async () =>
				new Response(JSON.stringify({ success: true, id: 'ok' }), {
					status: 200,
				})
		);
		global.fetch = fetchSpy as unknown as typeof fetch;

		const primary = await sendProviderDispatch(fakeCtx(), 'mta', params);
		const secondary = await sendProviderDispatch(
			fakeCtx(),
			namedSendTransportId('mta', 'secondary'),
			params
		);

		expect(primary.providerType).toBe('mta');
		expect(secondary.providerType).toBe('mta');
		expect(primary.transportId).toBe('mta');
		expect(secondary.transportId).toBe('mta#secondary');

		expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://mta-primary.test/send');
		expect(String(fetchSpy.mock.calls[1]![0])).toBe('https://mta-secondary.test/send');
		const firstInit = fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> };
		const secondInit = fetchSpy.mock.calls[1]![1] as { headers: Record<string, string> };
		expect(JSON.stringify(firstInit.headers)).toContain('mta-primary-key');
		expect(JSON.stringify(secondInit.headers)).toContain('mta-secondary-key');
	});

	it('dispatches two smtp transports to two different relays, caches kept separate', async () => {
		await sendProviderDispatch(fakeCtx(), 'smtp', params);
		await sendProviderDispatch(fakeCtx(), namedSendTransportId('smtp', 'backup'), params);
		// Send through the primary again: a per-kind cache would have been
		// overwritten by the backup's config by now.
		await sendProviderDispatch(fakeCtx(), 'smtp', params);

		const inputs = smtpSendMock.mock.calls.map(
			(call) =>
				call[0] as {
					connect: { host: string; port: number; tlsMode: string };
					auth: { credentials: { username: string; password: string } };
				}
		);
		expect(inputs.map((input) => input.connect.host)).toEqual([
			'smtp.primary.test',
			'smtp.backup.test',
			'smtp.primary.test',
		]);
		expect(inputs[1]!.connect.port).toBe(465);
		expect(inputs[1]!.connect.tlsMode).toBe('implicit');
		expect(inputs[0]!.connect.tlsMode).toBe('starttls');
		expect(inputs[1]!.auth.credentials.password).toBe('backup-pass');
		expect(inputs[2]!.auth.credentials.password).toBe('primary-pass');
	});

	it('builds one Resend client per transport, each with its own API key', async () => {
		await sendProviderDispatch(fakeCtx(), 'resend', params);
		await sendProviderDispatch(fakeCtx(), namedSendTransportId('resend', 'trial'), params);
		await sendProviderDispatch(fakeCtx(), 'resend', params);

		expect(resendKeys).toEqual(['resend-primary-key', 'resend-trial-key']);
	});
});
