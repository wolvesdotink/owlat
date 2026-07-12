/**
 * AES-256-GCM credential envelope — round-trip, non-determinism, and tamper
 * detection. Pure unit test (no convex-test); INSTANCE_SECRET is stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encryptSecret, decryptSecret, createSecretBox } from '../credentialCrypto';

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

describe('createSecretBox', () => {
	const CONTEXT_A = { salt: 'owlat:test:salt:a', info: 'owlat:test:info:a' };
	const CONTEXT_B = { salt: 'owlat:test:salt:b', info: 'owlat:test:info:b' };
	const SECRET = 'shared-box-secret-value';

	it('round-trips plaintext of varied shapes', () => {
		const box = createSecretBox(SECRET, CONTEXT_A);
		const cases = ['hello', '', 'ünïcödé 🔐 пароль', 'x'.repeat(8192)];
		for (const plain of cases) {
			expect(box.open(box.seal(plain))).toBe(plain);
		}
	});

	it('produces non-deterministic ciphertext (random IV) for the same input', () => {
		const box = createSecretBox(SECRET, CONTEXT_A);
		const a = box.seal('same-input');
		const b = box.seal('same-input');
		expect(a.ciphertext).not.toBe(b.ciphertext);
		expect(a.iv).not.toBe(b.iv);
	});

	it('detects tampering via the GCM auth tag', () => {
		const box = createSecretBox(SECRET, CONTEXT_A);
		const env = box.seal('secret');
		const flipped = Buffer.from(env.authTag, 'base64');
		flipped[0] = (flipped[0] ?? 0) ^ 0x01;
		const tampered = { ...env, authTag: flipped.toString('base64') };
		expect(() => box.open(tampered)).toThrow();
	});

	it('detects a tampered ciphertext body', () => {
		const box = createSecretBox(SECRET, CONTEXT_A);
		const env = box.seal('secret');
		const bad = { ...env, ciphertext: Buffer.from('not the real bytes').toString('base64') };
		expect(() => box.open(bad)).toThrow();
	});

	it('isolates boxes across info/salt strings (domain separation)', () => {
		const boxA = createSecretBox(SECRET, CONTEXT_A);
		const boxB = createSecretBox(SECRET, CONTEXT_B);
		const sealedByA = boxA.seal('cross-context payload');
		// A box built with a different context derives a different key, so opening
		// A's envelope with B must fail rather than silently return plaintext.
		expect(() => boxB.open(sealedByA)).toThrow();
		expect(boxA.open(sealedByA)).toBe('cross-context payload');
	});

	it('derives independent keys per context', () => {
		const keyA = createSecretBox(SECRET, CONTEXT_A).deriveKey();
		const keyB = createSecretBox(SECRET, CONTEXT_B).deriveKey();
		expect(keyA.equals(keyB)).toBe(false);
		expect(keyA.length).toBe(32);
	});
});
