import { describe, it, expect } from 'vitest';
import { detectSecretLeak } from '../secretLeakScan';

describe('detectSecretLeak', () => {
	it('passes ordinary email prose', () => {
		expect(detectSecretLeak('Thanks for your order, it ships Tuesday. Tracking to follow.').detected).toBe(false);
		expect(detectSecretLeak('Our task-management board is at example.com').detected).toBe(false);
	});

	it('flags common API-key and token fingerprints', () => {
		expect(detectSecretLeak('key: sk-ant-api03-abcdefghij1234567890').kind).toBe('anthropic_key');
		expect(detectSecretLeak('OPENAI=sk-abcdefghijklmnopqrstuvwxyz12').kind).toBe('openai_key');
		expect(detectSecretLeak('ghp_0123456789abcdefghijklmnopqrstuvwxyz').kind).toBe('github_pat');
		expect(detectSecretLeak('AIzaSyA1234567890abcdefghijklmnopqrstuvw').kind).toBe('google_api_key');
		expect(detectSecretLeak('xoxb-1234567890-abcdef').kind).toBe('slack_token');
		expect(detectSecretLeak('AKIAIOSFODNN7EXAMPLE').kind).toBe('aws_access_key_id');
	});

	it('flags a PEM private-key header', () => {
		expect(detectSecretLeak('-----BEGIN RSA PRIVATE KEY-----\nMIIE...').kind).toBe('private_key');
		expect(detectSecretLeak('-----BEGIN OPENSSH PRIVATE KEY-----').detected).toBe(true);
	});

	it('prefers the more specific anthropic prefix over the generic openai one', () => {
		// sk-ant-... also matches the broad sk- pattern; anthropic must win.
		expect(detectSecretLeak('sk-ant-api03-zzzzzzzzzzzzzzzzzzzz').kind).toBe('anthropic_key');
	});

	it('flags one-time passcode / 2FA / verification codes handed out in a draft', () => {
		expect(detectSecretLeak('Your verification code is 481920.').kind).toBe('otp_code');
		expect(detectSecretLeak('Enter this one-time password: 74x is invalid but 749210 works').kind).toBe('otp_code');
		expect(detectSecretLeak('OTP 553201 expires in 5 minutes').kind).toBe('otp_code');
		expect(detectSecretLeak('123456 is your login code').kind).toBe('otp_code');
	});

	it('flags account-recovery / password-reset / magic links', () => {
		expect(detectSecretLeak('Reset: https://accounts.example.com/reset-password?reset_token=abc123').kind).toBe('recovery_link');
		expect(detectSecretLeak('Recover: https://app.example.com/account-recovery/step2').kind).toBe('recovery_link');
		expect(detectSecretLeak('Sign in: https://example.com/login?magic_token=zzzzzzzz').kind).toBe('recovery_link');
	});

	it('does not trip on ordinary prose containing bare numbers or plain links', () => {
		expect(detectSecretLeak('Your order 1234567 ships Tuesday; track at example.com/orders.').detected).toBe(false);
		expect(detectSecretLeak('We are open 9 to 5; call 5551234 for support.').detected).toBe(false);
		expect(detectSecretLeak('See our docs at https://example.com/help/getting-started').detected).toBe(false);
	});
});
