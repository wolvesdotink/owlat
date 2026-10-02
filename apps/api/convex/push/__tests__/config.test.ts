/**
 * The VAPID identity (push/config): both halves or nothing, and a contact
 * subject push services accept (RFC 8292 allows only `mailto:` and `https:`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readVapidKeys, vapidPublicKey } from '../config';
import { VAPID_ENV } from './pushFixtures';

function stubKeys(extra: Record<string, string> = {}) {
	for (const [key, value] of Object.entries({ ...VAPID_ENV, ...extra })) vi.stubEnv(key, value);
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('push config', () => {
	it('reads as off unless both halves of the pair are set', () => {
		vi.stubEnv('VAPID_PUBLIC_KEY', VAPID_ENV.VAPID_PUBLIC_KEY);
		vi.stubEnv('VAPID_PRIVATE_KEY', '');
		expect(vapidPublicKey()).toBeNull();
		expect(readVapidKeys()).toBeNull();
	});

	it('prefers the configured subject', () => {
		stubKeys({ VAPID_SUBJECT: 'mailto:ops@example.com', SITE_URL: 'https://mail.example.com' });
		expect(readVapidKeys()?.subject).toBe('mailto:ops@example.com');
	});

	it('falls back to an https site URL', () => {
		stubKeys({ VAPID_SUBJECT: '', SITE_URL: 'https://mail.example.com' });
		expect(readVapidKeys()?.subject).toBe('https://mail.example.com');
	});

	it('never sends a plain http site URL as the subject', () => {
		stubKeys({ VAPID_SUBJECT: '', SITE_URL: 'http://localhost:3000' });
		expect(readVapidKeys()?.subject).toBe('mailto:postmaster@localhost');
	});
});
