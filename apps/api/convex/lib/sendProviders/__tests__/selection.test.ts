import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectSendProviderKind } from '../types';

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('selectSendProviderKind', () => {
	it('uses a recognized explicit provider instead of EMAIL_PROVIDER', () => {
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		expect(selectSendProviderKind('resend')).toBe('resend');
	});

	it.each(['plugin.retired-mail.postmark', ''])(
		'fails closed for the explicit value %j even when EMAIL_PROVIDER is valid',
		(providerType) => {
			vi.stubEnv('EMAIL_PROVIDER', 'mta');
			expect(selectSendProviderKind(providerType)).toBeNull();
		}
	);

	it('uses EMAIL_PROVIDER only when the explicit provider is absent', () => {
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		expect(selectSendProviderKind(undefined)).toBe('mta');
	});

	it('recognises mandrill from both selection paths (P1.1)', () => {
		// The day-0 arrival shape from the activation matrix: `EMAIL_PROVIDER=mandrill`
		// with no route rows, everything relaying through the account they came with.
		vi.stubEnv('EMAIL_PROVIDER', 'mandrill');
		expect(selectSendProviderKind(undefined)).toBe('mandrill');
		// …and once routes exist, the producer's explicit choice is authoritative.
		expect(selectSendProviderKind('mandrill')).toBe('mandrill');
	});

	it('fails closed when both provider selections are absent or invalid', () => {
		vi.stubEnv('EMAIL_PROVIDER', 'retired');
		expect(selectSendProviderKind(undefined)).toBeNull();
		vi.stubEnv('EMAIL_PROVIDER', '');
		expect(selectSendProviderKind(undefined)).toBeNull();
	});
});
