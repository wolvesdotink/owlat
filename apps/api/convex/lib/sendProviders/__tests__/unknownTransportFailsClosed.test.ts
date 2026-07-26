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

const { smtpSendMock } = vi.hoisted(() => ({ smtpSendMock: vi.fn() }));

vi.mock('resend', () => ({
	Resend: class {
		emails = { send: vi.fn() };
	},
}));

vi.mock('@owlat/smtp-client', () => ({
	sendMessage: (input: unknown) => smtpSendMock(input),
	isSmtpError: () => false,
}));

import { sendProviderDispatch } from '../dispatch';
import {
	SendTransportResolutionError,
	_resetSendTransportCacheForTests,
	resolveSendTransport,
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
		['plugin.mail-pack.postmark', 'unknown_kind'],
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

	it('ignores malformed declarations rather than crashing, and still fails closed', () => {
		vi.stubEnv('SEND_TRANSPORT_INSTANCES', 'not-a-kind#x,,mta#,  ,smtp#BACKUP');
		_resetSendTransportCacheForTests();
		expect(reasonFor('smtp#backup')).toBe('unregistered_instance');
		expect(() => resolveSendTransport('smtp')).not.toThrow();
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
		await expect(sendProviderDispatch(ctx, 'postmark', params)).rejects.toBeInstanceOf(
			SendTransportResolutionError
		);

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
