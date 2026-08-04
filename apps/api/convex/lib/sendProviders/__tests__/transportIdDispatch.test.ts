/**
 * P2-2 (a) — dispatch BY TRANSPORT ID.
 *
 * `sendProviderDispatch` takes a transport id, not a bare provider kind. For
 * every shipped kind the id must resolve to that kind's adapter, that adapter
 * must resolve its own sealed config from the record it is handed, and the
 * result must report both the kind and the transport it went through.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SESClient } from '@aws-sdk/client-ses';

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
import { _resetSesClientCacheForTests } from '../ses';
import { _resetSmtpConfigCacheForTests } from '../smtp';
import {
	_resetSendTransportCacheForTests,
	defaultSendTransportId,
	resolveSendTransport,
} from '../transports';

interface ScheduledCall {
	readonly args: Record<string, unknown>;
}

function fakeCtx(): {
	scheduled: ScheduledCall[];
	ctx: Parameters<typeof sendProviderDispatch>[0];
} {
	const scheduled: ScheduledCall[] = [];
	const ctx = {
		runMutation: vi.fn(async () => true),
		scheduler: {
			runAfter: vi.fn(async (_delay: number, _ref: unknown, args: Record<string, unknown>) => {
				scheduled.push({ args });
			}),
		},
	};
	return { scheduled, ctx: ctx as unknown as Parameters<typeof sendProviderDispatch>[0] };
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
	_resetSesClientCacheForTests();
	_resetSmtpConfigCacheForTests();
	resendKeys.length = 0;
	resendSendMock.mockReset();
	resendSendMock.mockResolvedValue({ data: { id: 'resend-1' }, error: null });
	smtpSendMock.mockReset();
	smtpSendMock.mockResolvedValue(undefined);
	vi.stubEnv('MTA_API_URL', 'https://mta.test');
	vi.stubEnv('MTA_API_KEY', 'mta-key');
	vi.stubEnv('RESEND_API_KEY', 'resend-key');
	vi.stubEnv('AWS_SES_REGION', 'eu-central-1');
	vi.stubEnv('AWS_SES_ACCESS_KEY_ID', 'ses-access');
	vi.stubEnv('AWS_SES_SECRET_ACCESS_KEY', 'ses-secret');
	vi.stubEnv('SMTP_RELAY_HOST', 'smtp.primary.test');
	vi.stubEnv('SMTP_RELAY_USERNAME', 'primary-user');
	vi.stubEnv('SMTP_RELAY_PASSWORD', 'primary-pass');
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	global.fetch = originalFetch;
	_resetSendTransportCacheForTests();
	_resetResendClientCacheForTests();
	_resetSesClientCacheForTests();
	_resetSmtpConfigCacheForTests();
});

describe('transport-id dispatch — the default instance of every shipped kind', () => {
	it('resolves the record for each kind with the unsuffixed variables', () => {
		for (const kind of ['mta', 'ses', 'resend', 'smtp'] as const) {
			const transport = resolveSendTransport(defaultSendTransportId(kind));
			expect(transport.kind).toBe(kind);
			expect(transport.id).toBe(kind);
			expect(transport.instanceKey).toBeNull();
			for (const name of transport.requiredEnvVars) {
				expect(name).not.toContain('__');
			}
		}
	});

	it('dispatches the mta id through the MTA adapter with the MTA config', async () => {
		const fetchSpy = vi.fn().mockImplementation(
			async () =>
				new Response(JSON.stringify({ success: true, id: 'mta-1' }), {
					status: 200,
				})
		);
		global.fetch = fetchSpy as unknown as typeof fetch;
		const { ctx, scheduled } = fakeCtx();

		const dispatched = await sendProviderDispatch(ctx, defaultSendTransportId('mta'), params);

		expect(dispatched.result).toEqual({ success: true, id: 'mta-1' });
		expect(dispatched.providerType).toBe('mta');
		expect(dispatched.transportId).toBe('mta');
		expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://mta.test/send');
		expect(scheduled[0]!.args['providerType']).toBe('mta');
	});

	it('dispatches the resend id through the Resend adapter with the Resend key', async () => {
		const { ctx } = fakeCtx();

		const dispatched = await sendProviderDispatch(ctx, defaultSendTransportId('resend'), params);

		expect(dispatched.result).toEqual({ success: true, id: 'resend-1' });
		expect(dispatched.providerType).toBe('resend');
		expect(dispatched.transportId).toBe('resend');
		expect(resendKeys).toEqual(['resend-key']);
	});

	it('dispatches the ses id through the SES adapter', async () => {
		const sendSpy = vi
			.spyOn(SESClient.prototype, 'send')
			.mockResolvedValue({ MessageId: 'ses-1' } as never);
		const { ctx } = fakeCtx();

		const dispatched = await sendProviderDispatch(ctx, defaultSendTransportId('ses'), params);

		expect(dispatched.result).toEqual({ success: true, id: 'ses-1' });
		expect(dispatched.providerType).toBe('ses');
		expect(dispatched.transportId).toBe('ses');
		expect(sendSpy).toHaveBeenCalledTimes(1);
	});

	it('dispatches the smtp id through the relay adapter with the relay config', async () => {
		const { ctx } = fakeCtx();

		const dispatched = await sendProviderDispatch(ctx, defaultSendTransportId('smtp'), params);

		expect(dispatched.result.success).toBe(true);
		expect(dispatched.providerType).toBe('smtp');
		expect(dispatched.transportId).toBe('smtp');
		const input = smtpSendMock.mock.calls[0]![0] as {
			connect: { host: string };
			auth: { credentials: { username: string; password: string } };
		};
		expect(input.connect.host).toBe('smtp.primary.test');
		expect(input.auth.credentials).toEqual({ username: 'primary-user', password: 'primary-pass' });
	});
});
