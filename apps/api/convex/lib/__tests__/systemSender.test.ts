import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	SystemSenderNotConfiguredError,
	requireSystemSenderAddress,
	systemSenderAddress,
} from '../systemSender';

afterEach(() => {
	vi.unstubAllEnvs();
});

function stubSender(env: { DEFAULT_FROM_DOMAIN?: string; DEFAULT_FROM_EMAIL?: string }) {
	vi.stubEnv('DEFAULT_FROM_DOMAIN', env.DEFAULT_FROM_DOMAIN ?? '');
	vi.stubEnv('DEFAULT_FROM_EMAIL', env.DEFAULT_FROM_EMAIL ?? '');
}

describe('the system mail sender', () => {
	it('is noreply@ the configured domain, as system mail has always been sent', () => {
		stubSender({ DEFAULT_FROM_DOMAIN: 'mail.example.com', DEFAULT_FROM_EMAIL: 'news@example.com' });
		expect(systemSenderAddress()).toBe('noreply@mail.example.com');
		expect(requireSystemSenderAddress()).toBe('noreply@mail.example.com');
	});

	it('is the configured address when only an address is set', () => {
		stubSender({ DEFAULT_FROM_EMAIL: 'system@example.com' });
		expect(systemSenderAddress()).toBe('system@example.com');
	});

	it('is absent when nothing is configured, never a domain the operator does not own', () => {
		stubSender({ DEFAULT_FROM_DOMAIN: '  ' });
		expect(systemSenderAddress()).toBeNull();
		expect(() => requireSystemSenderAddress()).toThrow(SystemSenderNotConfiguredError);
		expect(() => requireSystemSenderAddress()).toThrow(/DEFAULT_FROM_DOMAIN/);
	});
});
