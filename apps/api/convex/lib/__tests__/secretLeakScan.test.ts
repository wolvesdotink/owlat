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
});
