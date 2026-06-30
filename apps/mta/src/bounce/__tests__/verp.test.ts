import { describe, expect, it, vi } from 'vitest';
import { buildVerpAddress, parseVerpAddress } from '../verp.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('VERP addresses', () => {
	describe('round-trip encode/decode', () => {
		it('handles a simple messageId', () => {
			const messageId = 'msg-001';
			const verp = buildVerpAddress(messageId, 'bounce.example.com');
			const decoded = parseVerpAddress(verp);
			expect(decoded).toBe(messageId);
		});

		it('handles a UUID-style messageId', () => {
			const messageId = '550e8400-e29b-41d4-a716-446655440000';
			const verp = buildVerpAddress(messageId, 'bounce.example.com');
			const decoded = parseVerpAddress(verp);
			expect(decoded).toBe(messageId);
		});

		it('handles special characters (slashes, plus, equals)', () => {
			const messageId = 'msg/with+special=chars';
			const verp = buildVerpAddress(messageId, 'bounce.example.com');
			const decoded = parseVerpAddress(verp);
			expect(decoded).toBe(messageId);
		});
	});

	describe('parseVerpAddress', () => {
		it('returns null for a non-VERP address', () => {
			expect(parseVerpAddress('user@example.com')).toBeNull();
		});

		it('returns null for an empty string', () => {
			expect(parseVerpAddress('')).toBeNull();
		});
	});

	describe('buildVerpAddress', () => {
		it('produces the correct format', () => {
			const verp = buildVerpAddress('test-id', 'returns.example.com');
			expect(verp).toMatch(/^bounce\+[A-Za-z0-9_-]+@returns\.example\.com$/);
		});
	});

	// Audit PR-74 (1) — property/fuzz lock for the VERP round-trip and the
	// null-rejection contract. The base64url alphabet (RFC 4648 §5) is `@`/`+`/`=`
	// -free, so an arbitrary `messageId` (including ones containing the SMTP-
	// significant `/`, `+`, `=`, or the worker's `send_<id>` convention) survives
	// the encode→address→decode trip byte-for-byte. If this drifts, a genuine
	// async DSN (RFC 3464) decodes to the wrong/no id and silently inflates the
	// unattributed-bounce rate past the Gmail/Yahoo suppression thresholds.
	describe('round-trip property test (PR-74)', () => {
		/** Build a pseudo-random id deterministically (seeded) for reproducibility. */
		function randomId(seed: number): string {
			// A mix of the SMTP-significant chars the audit calls out plus arbitrary
			// printable bytes, so the base64url alphabet boundary is exercised.
			const alphabet =
				"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/+=._-<>@:!#$%^&*()[]{} \t";
			let x = (seed * 2654435761) >>> 0; // Knuth multiplicative hash → 32-bit
			const len = 1 + (x % 40);
			let out = '';
			for (let i = 0; i < len; i++) {
				x = (x * 1103515245 + 12345) >>> 0; // LCG step
				out += alphabet[x % alphabet.length];
			}
			return out;
		}

		it('round-trips 100 random ids (incl. /, +, =, send_<id>) byte-for-byte', () => {
			// First three are the explicit audit cases; the rest are fuzz.
			const ids = [
				'a/b',
				'a+b',
				'a=b=',
				'send_jh7abcdef0123456789',
				...Array.from({ length: 96 }, (_unused, i) => randomId(i + 1)),
			];
			expect(ids).toHaveLength(100);

			for (const id of ids) {
				const verp = buildVerpAddress(id, 'bounces.example.com');
				expect(parseVerpAddress(verp)).toBe(id);
			}
		});

		it('returns null for an FBL address (fbl+…@ is NOT a bounce VERP token)', () => {
			// `parseVerpAddress` only decodes the `bounce+` grammar. An FBL/ARF
			// envelope (`fbl+…@`) is handled by the ARF parser, not here, so it must
			// NOT decode to a phantom messageId.
			expect(parseVerpAddress('fbl+bXNnLTAwMQ@bounces.example.com')).toBeNull();
		});

		it('returns null for a plain mailbox address', () => {
			expect(parseVerpAddress('user@x.com')).toBeNull();
		});

		it('returns null for a bounce token whose payload is malformed base64', () => {
			// `!!!` is outside the base64url alphabet, so the grammar regex never
			// matches → null (never a thrown error, never a garbage decode).
			expect(parseVerpAddress('bounce+!!!@bounces.example.com')).toBeNull();
		});

		it('returns null for a bounce token whose payload decodes to empty', () => {
			// The grammar matches but the decoded id is empty → not attributable.
			expect(parseVerpAddress('bounce+@bounces.example.com')).toBeNull();
		});
	});

	// Audit PR-03 — sign the VERP token (BATV/HMAC) so a forged DSN cannot poison
	// the suppression list. draft-levine-smtp-batv; RFC 5321 (anyone may submit a
	// DSN; null-sender DSNs skip SPF). The key is passed explicitly so these
	// assertions never depend on the ambient BOUNCE_VERP_KEY env.
	describe('signed VERP token (BATV/HMAC)', () => {
		const KEY = 'test-verp-signing-key-0123456789';
		const messageId = 'send_jh7abcdef0123456789';

		it('(c) signed token round-trips back to the messageId', () => {
			const verp = buildVerpAddress(messageId, 'bounces.test', KEY);
			// Signed form carries a second `+`-delimited segment (the MAC).
			expect(verp).toMatch(/^bounce\+[A-Za-z0-9_-]+\+[A-Za-z0-9_-]+@bounces\.test$/);
			expect(parseVerpAddress(verp, KEY)).toBe(messageId);
		});

		it('(a) parseVerpAddress accepts a correctly-signed token', () => {
			const verp = buildVerpAddress(messageId, 'bounces.test', KEY);
			expect(parseVerpAddress(verp, KEY)).toBe(messageId);
		});

		it('(a) returns null when the encoded id is tampered with (MAC no longer matches)', () => {
			const verp = buildVerpAddress(messageId, 'bounces.test', KEY);
			// Flip a character in the encoded-id segment, keep the original MAC.
			const m = verp.match(/^bounce\+([A-Za-z0-9_-]+)\+([A-Za-z0-9_-]+)@(.+)$/);
			expect(m).not.toBeNull();
			const [, encodedId, mac, domain] = m!;
			const flipped = (encodedId![0] === 'A' ? 'B' : 'A') + encodedId!.slice(1);
			const tampered = `bounce+${flipped}+${mac}@${domain}`;
			expect(parseVerpAddress(tampered, KEY)).toBeNull();
		});

		it('(a) returns null for a wrong MAC', () => {
			const verp = buildVerpAddress(messageId, 'bounces.test', KEY);
			const m = verp.match(/^bounce\+([A-Za-z0-9_-]+)\+([A-Za-z0-9_-]+)@(.+)$/);
			const [, encodedId, , domain] = m!;
			const forgedMac = 'deadbeefdead00';
			expect(parseVerpAddress(`bounce+${encodedId}+${forgedMac}@${domain}`, KEY)).toBeNull();
		});

		it('(a) returns null for a token signed with a DIFFERENT key', () => {
			const verp = buildVerpAddress(messageId, 'bounces.test', 'attacker-guessed-key');
			expect(parseVerpAddress(verp, KEY)).toBeNull();
		});

		it('(b) rejects an UNSIGNED token when a signing key is configured', () => {
			// Exactly the forged shape from the audit: a hand-crafted
			// `bounce+<validid>@` with no MAC. Build it in unsigned mode (no key),
			// then verify it against the configured key → unattributable.
			const unsigned = buildVerpAddress(messageId, 'bounces.test');
			expect(unsigned).not.toMatch(/\+[A-Za-z0-9_-]+\+/); // single segment, no MAC
			expect(parseVerpAddress(unsigned, KEY)).toBeNull();
		});

		it('verifies a token across the multi-day DSN delivery window', () => {
			const now = Date.UTC(2026, 0, 10, 12, 0, 0);
			const verp = buildVerpAddress(messageId, 'bounces.test', KEY, now);
			// A DSN that arrives 5 days later still verifies (retry horizon slack).
			const fiveDaysLater = now + 5 * 24 * 60 * 60 * 1000;
			expect(parseVerpAddress(verp, KEY, fiveDaysLater)).toBe(messageId);
			// But a token far past the acceptance window no longer verifies.
			const tenDaysLater = now + 10 * 24 * 60 * 60 * 1000;
			expect(parseVerpAddress(verp, KEY, tenDaysLater)).toBeNull();
		});

		it('stays backward-compatible: unsigned build + unsigned parse round-trips with no key', () => {
			const verp = buildVerpAddress(messageId, 'bounces.test');
			expect(parseVerpAddress(verp)).toBe(messageId);
		});
	});
});
