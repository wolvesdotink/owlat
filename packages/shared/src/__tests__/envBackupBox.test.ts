import { describe, it, expect } from 'vitest';
import {
	ENV_BACKUP_SEALED_PREFIX,
	createEnvBackupBox,
	isEnvBackupSealedValue,
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
