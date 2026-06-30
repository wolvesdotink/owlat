/**
 * AES-256-GCM credential envelope — round-trip, non-determinism, and tamper
 * detection. Pure unit test (no convex-test); INSTANCE_SECRET is stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encryptSecret, decryptSecret } from '../credentialCrypto';

describe('credentialCrypto', () => {
	beforeEach(() => {
		vi.stubEnv('INSTANCE_SECRET', 'unit-test-instance-secret-value');
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('round-trips plaintext of varied shapes', () => {
		const cases = [
			'hello',
			'',
			'ünïcödé 🔐 пароль',
			'x'.repeat(8192),
			JSON.stringify({ imapPassword: 'p@ss w0rd', smtpPassword: 's3cr3t!' }),
		];
		for (const plain of cases) {
			expect(decryptSecret(encryptSecret(plain))).toBe(plain);
		}
	});

	it('produces non-deterministic ciphertext (random IV) for the same input', () => {
		const a = encryptSecret('same-input');
		const b = encryptSecret('same-input');
		expect(a.ciphertext).not.toBe(b.ciphertext);
		expect(a.iv).not.toBe(b.iv);
		expect(decryptSecret(a)).toBe('same-input');
		expect(decryptSecret(b)).toBe('same-input');
	});

	it('stamps the envelope version', () => {
		expect(encryptSecret('x').version).toBe(1);
	});

	it('throws when the ciphertext is tampered (GCM integrity)', () => {
		const env = encryptSecret('secret');
		const tampered = { ...env, ciphertext: Buffer.from('not the real bytes').toString('base64') };
		expect(() => decryptSecret(tampered)).toThrow();
	});

	it('throws when the auth tag is wrong', () => {
		const env = encryptSecret('secret');
		const badTag = { ...env, authTag: Buffer.alloc(16).toString('base64') };
		expect(() => decryptSecret(badTag)).toThrow();
	});

	it('fails to decrypt under a different INSTANCE_SECRET', () => {
		const env = encryptSecret('secret');
		vi.stubEnv('INSTANCE_SECRET', 'a-completely-different-secret');
		expect(() => decryptSecret(env)).toThrow();
	});
});
