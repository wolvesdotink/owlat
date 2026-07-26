/**
 * P2-2 (e) — an unknown or revoked transport id FAILS CLOSED.
 *
 * This is the security property of the piece. Silently falling back to
 * "whatever else is configured" would send mail through a transport nobody
 * asked for, with credentials that were never granted for that send — a
 * routing AND an authorization regression. Resolution therefore throws a typed
 * error before any attempt, any authorization call and any health write.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { smtpSendMock, pluginSendMock } = vi.hoisted(() => ({
	smtpSendMock: vi.fn(),
	pluginSendMock: vi.fn(),
}));

vi.mock('resend', () => ({
	Resend: class {
		emails = { send: vi.fn() };
	},
}));

vi.mock('@owlat/smtp-client', () => ({
	sendMessage: (input: unknown) => smtpSendMock(input),
	isSmtpError: () => false,
}));

// A bundled plugin transport, with the EMPTY `requiredEnvVars` a plugin catalog
// entry legitimately has (its configuration lives in the plugin's own
// deployment-wide environment, not in per-instance variables). That shape is
// exactly what a vacuous "every required variable is present" check would wave
// through, so it is the shape this file pins.
vi.mock('../../../plugins/sendTransportCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.mail-pack.postmark',
			pluginId: 'mail-pack',
			localId: 'postmark',
			label: 'Postmark',
			retryDelays: Object.freeze([0]),
			requiredEnvVars: Object.freeze([]),
			requiredCapability: 'send:transport',
		}),
	]),
}));

vi.mock('../../../plugins/sendTransportModules.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_MODULES: Object.freeze([
		Object.freeze({
			kind: 'plugin.mail-pack.postmark',
			pluginId: 'mail-pack',
			module: {
				parseExtras: (input: unknown) => input,
				send: () => pluginSendMock(),
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

import { sendProviderDispatch } from '../dispatch';
import {
	SendTransportResolutionError,
	_resetSendTransportCacheForTests,
	listSendTransports,
	resolveSendTransport,
	type SendTransportId,
} from '../transports';

const params = {
	to: 'to@example.com',
	from: 'from@example.com',
	subject: 'Subject',
	html: '<p>Hello</p>',
};

const originalFetch = global.fetch;

function reasonFor(transportId: string): string {
	try {
		resolveSendTransport(transportId);
	} catch (error) {
		expect(error).toBeInstanceOf(SendTransportResolutionError);
		return (error as SendTransportResolutionError).reason;
	}
	throw new Error(`expected ${transportId} to fail closed`);
}

beforeEach(() => {
	_resetSendTransportCacheForTests();
	smtpSendMock.mockReset();
	vi.stubEnv('MTA_API_URL', 'https://mta.test');
	vi.stubEnv('MTA_API_KEY', 'mta-key');
	vi.stubEnv('SMTP_RELAY_HOST', 'smtp.primary.test');
	vi.stubEnv('SMTP_RELAY_USERNAME', 'primary-user');
	vi.stubEnv('SMTP_RELAY_PASSWORD', 'primary-pass');
});

afterEach(() => {
	vi.unstubAllEnvs();
	global.fetch = originalFetch;
	_resetSendTransportCacheForTests();
});

describe('resolution failure modes', () => {
	it.each([
		['', 'malformed_id'],
		['mta#', 'malformed_id'],
		['mta#UPPER', 'malformed_id'],
		['mta#has space', 'malformed_id'],
		['mta#a#b', 'malformed_id'],
		['#secondary', 'malformed_id'],
		[`mta#${'a'.repeat(200)}`, 'malformed_id'],
		['postmark', 'unknown_kind'],
		['MTA', 'unknown_kind'],
		[' mta', 'unknown_kind'],
		['plugin.mail-pack.mailgun', 'unknown_kind'],
	])('%s fails closed with reason %s', (transportId, reason) => {
		expect(reasonFor(transportId)).toBe(reason);
	});

	it('rejects a well-formed instance id that nothing declared', () => {
		expect(reasonFor('mta#secondary')).toBe('unregistered_instance');
	});

	it('rejects a declared instance whose configuration was removed (revoked)', () => {
		vi.stubEnv('SEND_TRANSPORT_INSTANCES', 'smtp#backup');
		vi.stubEnv('SMTP_RELAY_HOST__BACKUP', 'smtp.backup.test');
		vi.stubEnv('SMTP_RELAY_USERNAME__BACKUP', 'backup-user');
		vi.stubEnv('SMTP_RELAY_PASSWORD__BACKUP', 'backup-pass');
		_resetSendTransportCacheForTests();
		expect(resolveSendTransport('smtp#backup').instanceKey).toBe('backup');

		// Revoke by removing the credential.
		vi.stubEnv('SMTP_RELAY_PASSWORD__BACKUP', '');
		expect(reasonFor('smtp#backup')).toBe('revoked');

		// Revoke by undeclaring the instance.
		vi.stubEnv('SMTP_RELAY_PASSWORD__BACKUP', 'backup-pass');
		vi.stubEnv('SEND_TRANSPORT_INSTANCES', '');
		expect(reasonFor('smtp#backup')).toBe('unregistered_instance');
	});

	it('resolves the DEFAULT instance of a plugin-contributed kind', () => {
		expect(resolveSendTransport('plugin.mail-pack.postmark')).toMatchObject({
			kind: 'plugin.mail-pack.postmark',
			instanceKey: null,
			pluginId: 'mail-pack',
		});
	});

	it('rejects a NAMED instance of a plugin kind instead of borrowing the default plugin credentials', () => {
		// Declaring it changes nothing: a plugin transport's configuration comes
		// from the plugin's own deployment-wide environment, which no `__ALT`
		// suffix reaches, so `plugin.mail-pack.postmark#alt` could only ever send
		// with the DEFAULT instance's credentials. Two ids, one credential set is
		// precisely the silent borrow this module forbids.
		vi.stubEnv('SEND_TRANSPORT_INSTANCES', 'plugin.mail-pack.postmark#alt');
		_resetSendTransportCacheForTests();
		expect(reasonFor('plugin.mail-pack.postmark#alt')).toBe('instances_unsupported');
		expect(listSendTransports().map((transport) => transport.id)).not.toContain(
			'plugin.mail-pack.postmark#alt'
		);
	});

	it('fails closed for a named instance whose kind declares no variables of its own', async () => {
		// A transport with nothing of its own to read can only be reading somebody
		// else's configuration, so an EMPTY requirement list must not be vacuously
		// "configured". Pinned against a stand-in catalog because every shipped
		// core kind declares at least one variable.
		vi.resetModules();
		const entry = Object.freeze({
			kind: 'smtp',
			label: 'SMTP relay',
			retryDelays: Object.freeze([0]),
			requiredEnvVars: Object.freeze([]),
		});
		vi.doMock('../catalog', () => ({
			SEND_PROVIDER_CATALOG: Object.freeze([entry]),
			isSendProviderKind: (kind: string) => kind === 'smtp',
			sendProviderCatalogEntry: (kind: string) => {
				if (kind !== 'smtp') throw new TypeError('Unknown send provider kind');
				return entry;
			},
		}));
		try {
			const transports = await import('../transports');
			vi.stubEnv('SEND_TRANSPORT_INSTANCES', 'smtp#backup');
			transports._resetSendTransportCacheForTests();
			expect(() => transports.resolveSendTransport('smtp#backup')).toThrow(
				transports.SendTransportResolutionError
			);
			expect(transports.listSendTransports().map((transport) => transport.id)).not.toContain(
				'smtp#backup'
			);
		} finally {
			vi.doUnmock('../catalog');
			vi.resetModules();
		}
	});

	it('ignores malformed declarations rather than crashing, and still fails closed', () => {
		vi.stubEnv('SEND_TRANSPORT_INSTANCES', 'not-a-kind#x,,mta#,  ,smtp#BACKUP');
		_resetSendTransportCacheForTests();
		expect(reasonFor('smtp#backup')).toBe('unregistered_instance');
		expect(() => resolveSendTransport('smtp')).not.toThrow();
	});

	it('drops a second declaration that would alias the variables of the first', () => {
		// `a-b` and `a_b` both derive the suffix `__A_B`. Honouring both would give
		// two transport ids one credential set — and two separate client caches.
		vi.stubEnv('SEND_TRANSPORT_INSTANCES', 'smtp#a-b,smtp#a_b');
		vi.stubEnv('SMTP_RELAY_HOST__A_B', 'smtp.alias.test');
		vi.stubEnv('SMTP_RELAY_USERNAME__A_B', 'alias-user');
		vi.stubEnv('SMTP_RELAY_PASSWORD__A_B', 'alias-pass');
		_resetSendTransportCacheForTests();

		expect(resolveSendTransport('smtp#a-b').instanceKey).toBe('a-b');
		expect(reasonFor('smtp#a_b')).toBe('unregistered_instance');
		const ids = listSendTransports().map((transport) => transport.id);
		expect(ids).toContain('smtp#a-b');
		expect(ids).not.toContain('smtp#a_b');
	});
});

describe('the enumeration contract', () => {
	it('lists only ids that resolve, omitting a declared-but-unconfigured instance', () => {
		vi.stubEnv('SEND_TRANSPORT_INSTANCES', 'smtp#backup,resend#trial');
		vi.stubEnv('SMTP_RELAY_HOST__BACKUP', 'smtp.backup.test');
		vi.stubEnv('SMTP_RELAY_USERNAME__BACKUP', 'backup-user');
		vi.stubEnv('SMTP_RELAY_PASSWORD__BACKUP', 'backup-pass');
		// `resend#trial` is declared but never given a key.
		_resetSendTransportCacheForTests();

		const ids = listSendTransports().map((transport) => transport.id);
		expect(ids).toContain('smtp#backup');
		expect(ids).not.toContain('resend#trial');
		for (const id of ids) expect(() => resolveSendTransport(id)).not.toThrow();
	});
});

describe('dispatch never borrows another transport', () => {
	it('throws before any send, authorization or health write', async () => {
		const fetchSpy = vi.fn();
		global.fetch = fetchSpy as unknown as typeof fetch;
		const runMutation = vi.fn(async () => true);
		const runAfter = vi.fn(async () => undefined);
		const ctx = {
			runMutation,
			scheduler: { runAfter },
		} as unknown as Parameters<typeof sendProviderDispatch>[0];

		await expect(sendProviderDispatch(ctx, 'mta#secondary', params)).rejects.toBeInstanceOf(
			SendTransportResolutionError
		);
		// `SendTransportId` rejects an unknown KIND at compile time, which is the
		// point of narrowing it; the cast is what lets this test reach the runtime
		// guard that a persisted or operator-supplied id would hit.
		await expect(
			sendProviderDispatch(ctx, 'postmark' as SendTransportId, params)
		).rejects.toBeInstanceOf(SendTransportResolutionError);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(smtpSendMock).not.toHaveBeenCalled();
		expect(runMutation).not.toHaveBeenCalled();
		expect(runAfter).not.toHaveBeenCalled();
	});

	it('carries the offending id and a machine reason on the thrown error', async () => {
		const ctx = {
			runMutation: vi.fn(async () => true),
			scheduler: { runAfter: vi.fn(async () => undefined) },
		} as unknown as Parameters<typeof sendProviderDispatch>[0];

		await expect(sendProviderDispatch(ctx, 'resend#trial', params)).rejects.toMatchObject({
			name: 'SendTransportResolutionError',
			code: 'SEND_TRANSPORT_UNRESOLVED',
			reason: 'unregistered_instance',
			transportId: 'resend#trial',
		});
	});
});
