import { describe, it, expect } from 'vitest';
import { planTransportEnvChange, UnexpectedTransportEnvKeyError } from '../setupSendingPresets';

/**
 * `planTransportEnvChange` is the server-side clear-vs-preserve decision behind
 * `POST /api/delivery/apply-transport`. These tests pin the two invariants the
 * endpoint depends on:
 *   - only `PROVIDER_ENV_KEYS` may be patched (a browser request can never inject
 *     an unrelated env var); and
 *   - a blank/omitted From field PRESERVES the operator's configured From
 *     identity while credentials are still clear-then-set.
 */

function changesMap(changes: Array<[string, string]>): Map<string, string> {
	return new Map(changes);
}

describe('planTransportEnvChange — allowlist', () => {
	it('throws on any key outside PROVIDER_ENV_KEYS', () => {
		expect(() => planTransportEnvChange({}, { INSTANCE_SECRET: 'leak' })).toThrow(
			UnexpectedTransportEnvKeyError
		);
	});

	it('reports the offending key on the error', () => {
		try {
			planTransportEnvChange({}, { EMAIL_PROVIDER: 'resend', NODE_ENV: 'production' });
			expect.unreachable('should have thrown');
		} catch (e) {
			expect(e).toBeInstanceOf(UnexpectedTransportEnvKeyError);
			expect((e as UnexpectedTransportEnvKeyError).key).toBe('NODE_ENV');
		}
	});

	it('accepts a patch of only transport keys', () => {
		expect(() =>
			planTransportEnvChange({}, { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x' })
		).not.toThrow();
	});
});

describe('planTransportEnvChange — From identity is preserved on omission', () => {
	const existing = {
		EMAIL_PROVIDER: 'resend',
		RESEND_API_KEY: 're_old',
		DEFAULT_FROM_EMAIL: 'ops@acme.test',
		DEFAULT_FROM_NAME: 'Acme Ops',
	};

	it('keeps DEFAULT_FROM_* in .env when the patch rotates only a credential', () => {
		// The common flow: rotate the Resend key, leave From blank ⇒ From omitted.
		const { merged } = planTransportEnvChange(existing, {
			EMAIL_PROVIDER: 'resend',
			RESEND_API_KEY: 're_new',
		});
		expect(merged['RESEND_API_KEY']).toBe('re_new');
		expect(merged['DEFAULT_FROM_EMAIL']).toBe('ops@acme.test');
		expect(merged['DEFAULT_FROM_NAME']).toBe('Acme Ops');
	});

	it('does NOT push an empty From into the live env when the patch omits it', () => {
		const { changes } = planTransportEnvChange(existing, {
			EMAIL_PROVIDER: 'resend',
			RESEND_API_KEY: 're_new',
		});
		const m = changesMap(changes);
		// Preserve = never appear in the live push (an empty push would clear it).
		expect(m.has('DEFAULT_FROM_EMAIL')).toBe(false);
		expect(m.has('DEFAULT_FROM_NAME')).toBe(false);
		expect(m.get('RESEND_API_KEY')).toBe('re_new');
	});

	it('writes From identity when the patch supplies it', () => {
		const { merged, changes } = planTransportEnvChange(existing, {
			EMAIL_PROVIDER: 'resend',
			RESEND_API_KEY: 're_new',
			DEFAULT_FROM_EMAIL: 'noreply@acme.test',
		});
		const m = changesMap(changes);
		expect(merged['DEFAULT_FROM_EMAIL']).toBe('noreply@acme.test');
		expect(m.get('DEFAULT_FROM_EMAIL')).toBe('noreply@acme.test');
	});
});

describe('planTransportEnvChange — credentials are clear-then-set', () => {
	it('clears a dropped credential in both .env and the live push', () => {
		const existing = {
			EMAIL_PROVIDER: 'smtp',
			SMTP_RELAY_HOST: 'smtp.old.test',
			SMTP_RELAY_PASSWORD: 'old-secret',
			DEFAULT_FROM_EMAIL: 'ops@acme.test',
		};
		// Switch to Resend — no SMTP keys in the patch.
		const { merged, changes } = planTransportEnvChange(existing, {
			EMAIL_PROVIDER: 'resend',
			RESEND_API_KEY: 're_x',
		});
		const m = changesMap(changes);
		expect(merged['SMTP_RELAY_PASSWORD']).toBeUndefined();
		expect(merged['SMTP_RELAY_HOST']).toBeUndefined();
		// Dropped credentials are pushed as '' so nothing stale stays live.
		expect(m.get('SMTP_RELAY_PASSWORD')).toBe('');
		expect(m.get('SMTP_RELAY_HOST')).toBe('');
		expect(m.get('EMAIL_PROVIDER')).toBe('resend');
		expect(m.get('RESEND_API_KEY')).toBe('re_x');
		// From identity untouched (omitted).
		expect(merged['DEFAULT_FROM_EMAIL']).toBe('ops@acme.test');
	});
});
