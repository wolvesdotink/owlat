/**
 * The challenge state both sign-in surfaces share.
 *
 * The rules worth pinning are the ones that differ per factor: a TOTP field is
 * filtered to six digits and submits at exactly six, while a backup code is
 * whatever the user saved and goes to the server untouched. Everything else is
 * about not leaking a half-typed code across a method switch or a restart.
 */
import { describe, it, expect } from 'vitest';

import { useTwoFactorChallenge } from '../useTwoFactorChallenge';

describe('useTwoFactorChallenge', () => {
	it('starts on the credentials stage with nothing typed', () => {
		const c = useTwoFactorChallenge();

		expect(c.stage.value).toBe('credentials');
		expect(c.code.value).toBe('');
		expect(c.method.value).toBe('totp');
		expect(c.canSubmit.value).toBe(false);
	});

	it('moves to the challenge when the password leg asks for a factor', () => {
		const c = useTwoFactorChallenge();
		c.challenge();

		expect(c.stage.value).toBe('two-factor');
	});

	it('keeps only the digits of a TOTP code, and no more than six', () => {
		const c = useTwoFactorChallenge();
		c.onCodeInput('12 34-56');
		expect(c.code.value).toBe('123456');

		c.onCodeInput('1234567890');
		expect(c.code.value).toBe('123456');
	});

	it('submits at six digits, not before', () => {
		const c = useTwoFactorChallenge();
		c.onCodeInput('12345');
		expect(c.canSubmit.value).toBe(false);

		c.onCodeInput('123456');
		expect(c.canSubmit.value).toBe(true);
	});

	it('leaves a backup code alone but for surrounding space', () => {
		const c = useTwoFactorChallenge();
		c.switchMethod();
		c.onCodeInput('  MZ4T-9QQX  ');

		expect(c.method.value).toBe('backup-code');
		expect(c.code.value).toBe('MZ4T-9QQX');
		// Not six digits, and submittable anyway — length is the server's business.
		expect(c.canSubmit.value).toBe(true);
	});

	it('drops the half-typed code when the method changes', () => {
		const c = useTwoFactorChallenge();
		c.onCodeInput('1234');
		c.switchMethod();

		expect(c.code.value).toBe('');
		expect(c.canSubmit.value).toBe(false);
	});

	it('leaves nothing from the challenge behind on reset', () => {
		const c = useTwoFactorChallenge();
		c.challenge();
		c.switchMethod();
		c.onCodeInput('MZ4T-9QQX');
		c.reset();

		expect(c.stage.value).toBe('credentials');
		expect(c.code.value).toBe('');
		expect(c.method.value).toBe('totp');
	});

	it('re-entering the challenge starts from the authenticator again', () => {
		const c = useTwoFactorChallenge();
		c.challenge();
		c.switchMethod();
		c.onCodeInput('MZ4T-9QQX');
		c.reset();
		c.challenge();

		expect(c.stage.value).toBe('two-factor');
		expect(c.method.value).toBe('totp');
		expect(c.code.value).toBe('');
	});
});
