import { describe, expect, it } from 'vitest';
import { verificationEmailFor } from '../verificationEmail';

/** An unsigned JWT with the given payload; only the payload is read. */
function token(payload: Record<string, unknown>): string {
	const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${part({ alg: 'HS256' })}.${part(payload)}.signature`;
}

describe('verificationEmailFor', () => {
	it('asks a new account to confirm its address', () => {
		const mail = verificationEmailFor({
			user: { name: 'New Colleague', email: 'new@owlat.example' },
			url: 'https://owlat.example/api/auth/verify-email?token=t',
			token: token({ email: 'new@owlat.example' }),
		});
		expect(mail.subject).toBe('Confirm your email address — Owlat');
		expect(mail.html).toContain('Confirm email address');
		expect(mail.html).not.toContain('login email');
	});

	it('keeps the change-email copy for the final hop of an email change', () => {
		const mail = verificationEmailFor({
			user: { name: 'Owner', email: 'next@owlat.example' },
			url: 'https://owlat.example/api/auth/verify-email?token=t',
			token: token({
				email: 'owner@owlat.example',
				updateTo: 'next@owlat.example',
				requestType: 'change-email-verification',
			}),
		});
		expect(mail.subject).toBe('Verify your new login email — Owlat');
		expect(mail.html).toContain('Verify new email');
	});

	it('falls back to the account copy for a token it cannot read', () => {
		const mail = verificationEmailFor({
			user: { email: 'new@owlat.example' },
			url: 'https://owlat.example/api/auth/verify-email?token=t',
			token: 'not-a-jwt',
		});
		expect(mail.subject).toBe('Confirm your email address — Owlat');
	});
});
