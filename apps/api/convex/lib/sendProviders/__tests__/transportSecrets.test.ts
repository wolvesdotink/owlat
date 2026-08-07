/**
 * P2-2 (d) — sealed config never leaves the adapter that resolved it.
 *
 * A transport RECORD is a routing artefact: ids, labels, retry schedules and
 * the NAMES of the variables the config lives in. The values behind those names
 * are resolved inside the adapter at send time and must never appear on a
 * dispatch result, in an error message, or in anything written to the console.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { resendSendMock, smtpSendMock, pluginSendMock } = vi.hoisted(() => ({
	resendSendMock: vi.fn(),
	smtpSendMock: vi.fn(),
	pluginSendMock: vi.fn(),
}));

/**
 * A BUNDLED PLUGIN TRANSPORT WITH A CREDENTIAL OF ITS OWN (the seams plan's
 * P3.1) — the sharpest case in this file after Mandrill's body-borne key.
 *
 * The plugin tier is the one place a resolved credential VALUE leaves the host
 * and enters third-party code, so "sealed config never leaves the adapter that
 * resolved it" has to hold with a wider blast radius: the value must not reach
 * the transport record, the dispatch result, the console, or any transport but
 * the instance it was resolved for.
 */
vi.mock('../../../plugins/sendTransportCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.mail-pack.sendbird',
			pluginId: 'mail-pack',
			localId: 'sendbird',
			label: 'Sendbird',
			retryDelays: Object.freeze([0]),
			requiredEnvVars: Object.freeze(['PLUGIN_SENDBIRD_TOKEN']),
			instanceEnvVars: Object.freeze(['PLUGIN_SENDBIRD_TOKEN']),
			requiredCapability: 'send:transport',
		}),
	]),
}));

vi.mock('../../../plugins/sendTransportModules.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_MODULES: Object.freeze([
		Object.freeze({
			kind: 'plugin.mail-pack.sendbird',
			pluginId: 'mail-pack',
			module: {
				parseExtras: (input: unknown) => input,
				send: (_params: unknown, _extras: unknown, config: unknown) => pluginSendMock(config),
			},
		}),
	]),
}));

vi.mock('../../../plugins/plugins.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@acme/mail-pack',
			manifest: Object.freeze({
				id: 'mail-pack',
				version: '1.0.0',
				capabilities: Object.freeze(['send:transport']),
				flag: Object.freeze({ default: false, requiredEnvVars: Object.freeze([]) }),
			}),
		}),
	]),
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
	// The plugin tier's credential, which is the only one the host hands to code
	// it did not write.
	'sendbird-super-secret',
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
	vi.stubEnv('PLUGIN_SENDBIRD_TOKEN', 'sendbird-super-secret');

	pluginSendMock.mockReset();
	pluginSendMock.mockResolvedValue({ success: true, id: 'plugin-1' });
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

	it('keeps a BUNDLED PLUGIN credential to the module it was resolved for', async () => {
		// The host hands this value to third-party code by design (the seams plan's
		// P3.1), which makes every OTHER surface the interesting one: the record the
		// router holds, the result the Send row is written from, and the failure text.
		const dispatched = await sendProviderDispatch(fakeCtx(), 'plugin.mail-pack.sendbird', params);

		expect(dispatched.transportId).toBe('plugin.mail-pack.sendbird');
		expectNoSecret(JSON.stringify(dispatched));
		expectNoSecret(JSON.stringify(resolveSendTransport('plugin.mail-pack.sendbird')));
		// It DID reach the module, under the base name — otherwise this test would
		// pass on a transport that simply never got its credential.
		expect(pluginSendMock.mock.calls[0]?.[0]).toEqual({
			instanceKey: null,
			env: { PLUGIN_SENDBIRD_TOKEN: 'sendbird-super-secret' },
		});
	});

	it('keeps a plugin credential out of a FAILED dispatch, whatever the module threw', async () => {
		// A plugin's throw is untrusted text that may quote its own configuration.
		// The host answers with its own generic failure rather than the module's
		// message, so nothing a plugin says can reach the Send row.
		pluginSendMock.mockImplementation((config: { env: Record<string, string> }) => {
			throw new Error(`upstream rejected ${JSON.stringify(config.env)}`);
		});

		const dispatched = await sendProviderDispatch(fakeCtx(), 'plugin.mail-pack.sendbird', params);

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
		await sendProviderDispatch(fakeCtx(), 'plugin.mail-pack.sendbird', params);

		expectNoSecret(written.join('\n'));
	});
});
