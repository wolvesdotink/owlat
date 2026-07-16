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

	it('fails closed when both provider selections are absent or invalid', () => {
		vi.stubEnv('EMAIL_PROVIDER', 'retired');
		expect(selectSendProviderKind(undefined)).toBeNull();
		vi.stubEnv('EMAIL_PROVIDER', '');
		expect(selectSendProviderKind(undefined)).toBeNull();
	});
});
