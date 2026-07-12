import { describe, it, expect } from 'vitest';
import {
	ENV_BACKUP_SEALED_PREFIX,
	createEnvBackupBox,
	isEnvBackupSealedValue,
	sealRelayPasswordForBackup,
} from '../envBackupBox';

const SECRET = 'a'.repeat(64); // installer-style 32-byte hex INSTANCE_SECRET

describe('createEnvBackupBox', () => {
	it('round-trips a relay password and produces a recognizable sealed token', () => {
		const box = createEnvBackupBox(SECRET);
		const sealed = box.seal('hunter2-relay-password');
		expect(sealed.startsWith(ENV_BACKUP_SEALED_PREFIX)).toBe(true);
		expect(isEnvBackupSealedValue(sealed)).toBe(true);
		expect(box.isSealed(sealed)).toBe(true);
		expect(sealed).not.toContain('hunter2-relay-password');
		expect(box.open(sealed)).toBe('hunter2-relay-password');
	});

	it('produces a distinct token per seal (fresh nonce) that still opens', () => {
		const box = createEnvBackupBox(SECRET);
		const a = box.seal('same-plaintext');
		const b = box.seal('same-plaintext');
		expect(a).not.toBe(b);
		expect(box.open(a)).toBe('same-plaintext');
		expect(box.open(b)).toBe('same-plaintext');
	});

	it('treats plaintext (legacy .env values) as not sealed', () => {
		expect(isEnvBackupSealedValue('hunter2')).toBe(false);
		expect(isEnvBackupSealedValue('')).toBe(false);
		expect(() => createEnvBackupBox(SECRET).open('hunter2')).toThrow(/not a sealed token/);
	});

	it('fails closed on a tampered token (auth-tag mismatch)', () => {
		const box = createEnvBackupBox(SECRET);
		const sealed = box.seal('hunter2');
		// Flip a character inside the ciphertext segment.
		const parts = sealed.slice(ENV_BACKUP_SEALED_PREFIX.length).split('.');
		const ct = parts[2]!;
		const flipped = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
		const tampered = ENV_BACKUP_SEALED_PREFIX + [parts[0], parts[1], flipped].join('.');
		expect(() => box.open(tampered)).toThrow();
	});

	it('fails closed on a malformed token body', () => {
		const box = createEnvBackupBox(SECRET);
		expect(() => box.open(`${ENV_BACKUP_SEALED_PREFIX}not-three-parts`)).toThrow(/malformed/);
	});

	it('cannot open a token sealed under a different INSTANCE_SECRET', () => {
		const sealed = createEnvBackupBox(SECRET).seal('hunter2');
		const otherBox = createEnvBackupBox('b'.repeat(64));
		expect(() => otherBox.open(sealed)).toThrow();
	});

	it('refuses to build a box without an INSTANCE_SECRET', () => {
		expect(() => createEnvBackupBox('')).toThrow(/INSTANCE_SECRET/);
	});
});

describe('sealRelayPasswordForBackup', () => {
	it('seals a plaintext relay password in the returned map', () => {
		const sealedMap = sealRelayPasswordForBackup({
			INSTANCE_SECRET: SECRET,
			SMTP_RELAY_PASSWORD: 'hunter2-relay-password',
		});
		const stored = sealedMap['SMTP_RELAY_PASSWORD']!;
		expect(isEnvBackupSealedValue(stored)).toBe(true);
		expect(stored).not.toContain('hunter2-relay-password');
		expect(createEnvBackupBox(SECRET).open(stored)).toBe('hunter2-relay-password');
	});

	it('is idempotent: an already-sealed password passes through unchanged (no double-seal)', () => {
		const alreadySealed = createEnvBackupBox(SECRET).seal('hunter2-relay-password');
		const env = { INSTANCE_SECRET: SECRET, SMTP_RELAY_PASSWORD: alreadySealed };
		const result = sealRelayPasswordForBackup(env);
		// Same token, byte-for-byte — never wrapped a second time.
		expect(result['SMTP_RELAY_PASSWORD']).toBe(alreadySealed);
		// The reseed unseals exactly one layer, so it must still open to the
		// original plaintext (a double-seal would strand the inner token).
		expect(createEnvBackupBox(SECRET).open(result['SMTP_RELAY_PASSWORD']!)).toBe(
			'hunter2-relay-password'
		);
	});

	it('passes through unchanged when there is no relay password', () => {
		const env = { INSTANCE_SECRET: SECRET };
		expect(sealRelayPasswordForBackup(env)).toBe(env);
	});

	it('passes through unchanged when there is no INSTANCE_SECRET (bare dev .env)', () => {
		const env = { SMTP_RELAY_PASSWORD: 'hunter2-relay-password' };
		const result = sealRelayPasswordForBackup(env);
		expect(result).toBe(env);
		expect(result['SMTP_RELAY_PASSWORD']).toBe('hunter2-relay-password');
		expect(isEnvBackupSealedValue(result['SMTP_RELAY_PASSWORD']!)).toBe(false);
	});
});
