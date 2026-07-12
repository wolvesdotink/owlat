import { describe, it, expect, afterEach } from 'vitest';
import {
	createSecretBox,
	getMtaSecretBox,
	initMtaSecretBox,
	resetMtaSecretBoxForTests,
	assertMtaSecretStrength,
	MTA_SECRET_MIN_BYTES,
} from '../secretBox.js';

const CTX = { salt: 'test:salt:v1', info: 'test:info:v1' };
const SECRET = 'a'.repeat(MTA_SECRET_MIN_BYTES);

describe('secretBox', () => {
	afterEach(() => {
		resetMtaSecretBoxForTests();
	});

	describe('round-trip', () => {
		it('seals and opens back to the identical plaintext', () => {
			const box = createSecretBox(SECRET, CTX);
			const plaintext = '-----BEGIN PRIVATE KEY-----\nMIIabc123\n-----END PRIVATE KEY-----';
			const sealed = box.seal(plaintext);
			expect(box.open(sealed)).toBe(plaintext);
		});

		it('round-trips unicode and empty strings', () => {
			const box = createSecretBox(SECRET, CTX);
			for (const p of ['', 'ünïcodé — 秘密', 'x']) {
				expect(box.open(box.seal(p))).toBe(p);
			}
		});

		it('produces a distinct ciphertext each time (random nonce) that both open', () => {
			const box = createSecretBox(SECRET, CTX);
			const a = box.seal('same');
			const b = box.seal('same');
			expect(a).not.toBe(b);
			expect(box.open(a)).toBe('same');
			expect(box.open(b)).toBe('same');
		});

		it('marks its output as sealed and rejects a non-sealed value', () => {
			const box = createSecretBox(SECRET, CTX);
			const sealed = box.seal('hello');
			expect(box.isSealed(sealed)).toBe(true);
			expect(box.isSealed('-----BEGIN PRIVATE KEY-----')).toBe(false);
			expect(() => box.open('plain-not-sealed')).toThrow(/not a sealed token/);
		});
	});

	describe('tamper', () => {
		it('throws when the ciphertext is altered (auth-tag mismatch)', () => {
			const box = createSecretBox(SECRET, CTX);
			const sealed = box.seal('confidential');
			// Flip the last base64 char of the ciphertext segment.
			const flipped = sealed.slice(0, -1) + (sealed.at(-1) === 'A' ? 'B' : 'A');
			expect(() => box.open(flipped)).toThrow();
		});

		it('throws on a malformed sealed token', () => {
			const box = createSecretBox(SECRET, CTX);
			expect(() => box.open('mtasealed:v1:only.two')).toThrow(/malformed/);
		});
	});

	describe('wrong key', () => {
		it('cannot open a payload sealed under a different secret', () => {
			const sealed = createSecretBox(SECRET, CTX).seal('secret');
			const other = createSecretBox('b'.repeat(MTA_SECRET_MIN_BYTES), CTX);
			expect(() => other.open(sealed)).toThrow();
		});

		it('cannot open a payload sealed under a different context (domain separation)', () => {
			const sealed = createSecretBox(SECRET, CTX).seal('secret');
			const other = createSecretBox(SECRET, { salt: 'other:salt', info: 'other:info' });
			expect(() => other.open(sealed)).toThrow();
		});
	});

	describe('assertMtaSecretStrength', () => {
		it('accepts a >= 32-byte secret', () => {
			expect(() => assertMtaSecretStrength(SECRET)).not.toThrow();
		});

		it('rejects an absent secret', () => {
			expect(() => assertMtaSecretStrength(undefined)).toThrow(/required/);
		});

		it('rejects a too-short secret', () => {
			expect(() => assertMtaSecretStrength('short')).toThrow(/at least 32 bytes/);
		});
	});

	describe('getMtaSecretBox', () => {
		it('builds a working box from MTA_SECRET (set by the vitest setup)', () => {
			const box = getMtaSecretBox();
			expect(box.open(box.seal('via-env'))).toBe('via-env');
		});
	});

	describe('initMtaSecretBox', () => {
		it('binds the shared box to an explicit secret (config-supplied source)', () => {
			initMtaSecretBox(SECRET);
			const box = getMtaSecretBox();
			const sealed = box.seal('via-config');
			expect(box.open(sealed)).toBe('via-config');
			// The bound box uses the SAME secret + pinned MTA context: a box built
			// independently with that secret + context opens its output.
			const twin = createSecretBox(SECRET, {
				salt: 'owlat:mta-secrets:salt:v1',
				info: 'owlat:mta-secrets:secrets:v1',
			});
			expect(twin.open(sealed)).toBe('via-config');
		});

		it('rejects a weak secret before binding', () => {
			expect(() => initMtaSecretBox('short')).toThrow(/at least 32 bytes/);
		});
	});
});
