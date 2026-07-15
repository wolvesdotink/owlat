import { describe, it, expect } from 'vitest';
import { ensureSecrets, generateSecret } from '../setupSecrets';

describe('ensureSecrets', () => {
	it('generates a non-empty MAIL_SYNC_API_KEY on a fresh install', () => {
		// Regression: the external-mailbox feature (mail.external / apps/mail-sync)
		// crash-looped out of the box because setup never minted MAIL_SYNC_API_KEY,
		// so docker-compose passed an empty value and apps/mail-sync/src/config.ts
		// threw "MAIL_SYNC_API_KEY is required". It must be generated alongside the
		// other setup secrets, exactly like MTA_API_KEY.
		const out = ensureSecrets({});
		expect(out['MAIL_SYNC_API_KEY']).toBeTruthy();
		expect(typeof out['MAIL_SYNC_API_KEY']).toBe('string');
		expect(out['MAIL_SYNC_API_KEY']!.length).toBeGreaterThan(8);
		// Minted next to the MTA bearer token — both are required for a bootable
		// receiving stack.
		expect(out['MTA_API_KEY']).toBeTruthy();
	});

	it('mints a >= 32-byte hex MTA_SECRET so the MTA can seal secrets at rest', () => {
		// The MTA refuses to boot without a >= 32-byte MTA_SECRET (it seals DKIM
		// keys + relay credentials at rest). Setup must mint one so a fresh install
		// boots the sending stack without the operator hand-writing a key.
		const out = ensureSecrets({});
		expect(out['MTA_SECRET']).toBeTruthy();
		expect(out['MTA_SECRET']).toMatch(/^[0-9a-f]{64}$/);
		expect(Buffer.byteLength(out['MTA_SECRET']!, 'utf8')).toBeGreaterThanOrEqual(32);
	});

	it('preserves an operator-supplied MTA_SECRET (idempotent)', () => {
		const out = ensureSecrets({ MTA_SECRET: 'operator-provided-secret-value-32bytes!!' });
		expect(out['MTA_SECRET']).toBe('operator-provided-secret-value-32bytes!!');
	});

	it('is idempotent — preserves an operator-supplied MAIL_SYNC_API_KEY', () => {
		const out = ensureSecrets({ MAIL_SYNC_API_KEY: 'msk_existing' });
		expect(out['MAIL_SYNC_API_KEY']).toBe('msk_existing');
	});

	it('gives each install a distinct MAIL_SYNC_API_KEY', () => {
		expect(ensureSecrets({})['MAIL_SYNC_API_KEY']).not.toBe(ensureSecrets({})['MAIL_SYNC_API_KEY']);
	});

	it('generateSecret returns a non-empty URL-safe string of the requested length', () => {
		const s = generateSecret(40);
		expect(s).toHaveLength(40);
		expect(s).toMatch(/^[A-Za-z0-9]+$/);
	});
});
