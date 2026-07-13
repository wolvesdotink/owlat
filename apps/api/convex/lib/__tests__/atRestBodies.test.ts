/**
 * atRestBodies — the body-at-rest cipher (Sealed Mail E8b).
 *
 * Proves the core sealing contract the migration and the reader shim depend on:
 * a sealed value round-trips, a legacy-plaintext value passes through untouched
 * (mixed-tolerance), sealing is idempotent, and tamper / wrong-key is rejected.
 */

import { describe, it, expect } from 'vitest';
import { sealAtRest, openAtRest, isSealedAtRest } from '../atRestBodies';

const SECRET = 'unit-test-instance-secret-value';
const CANARY = 'CANARY-body-plaintext-9f3a-do-not-leak';

describe('atRestBodies cipher', () => {
	it('round-trips a plaintext body through seal → open', async () => {
		const sealed = await sealAtRest(SECRET, CANARY);
		expect(sealed).not.toBe(CANARY);
		expect(sealed).not.toContain(CANARY);
		expect(isSealedAtRest(sealed)).toBe(true);
		expect(await openAtRest(SECRET, sealed)).toBe(CANARY);
	});

	it('round-trips multi-line unicode / html bodies', async () => {
		const body = '<p>Héllo — wörld 🌍</p>\nLine two\tTabbed';
		const sealed = await sealAtRest(SECRET, body);
		expect(sealed).not.toContain('Héllo');
		expect(await openAtRest(SECRET, sealed)).toBe(body);
	});

	it('passes a legacy-plaintext value through open() verbatim (mixed tolerance)', async () => {
		// A pre-E8b row / an unmigrated row is NOT a sealed envelope.
		expect(isSealedAtRest(CANARY)).toBe(false);
		expect(await openAtRest(SECRET, CANARY)).toBe(CANARY);
	});

	it('treats the empty string as a no-op in both directions', async () => {
		expect(await sealAtRest(SECRET, '')).toBe('');
		expect(await openAtRest(SECRET, '')).toBe('');
	});

	it('is idempotent — sealing an already-sealed value returns it unchanged', async () => {
		const once = await sealAtRest(SECRET, CANARY);
		const twice = await sealAtRest(SECRET, once);
		expect(twice).toBe(once);
		expect(await openAtRest(SECRET, twice)).toBe(CANARY);
	});

	it('produces a fresh nonce per seal (ciphertext differs, plaintext matches)', async () => {
		const a = await sealAtRest(SECRET, CANARY);
		const b = await sealAtRest(SECRET, CANARY);
		expect(a).not.toBe(b);
		expect(await openAtRest(SECRET, a)).toBe(CANARY);
		expect(await openAtRest(SECRET, b)).toBe(CANARY);
	});

	it('rejects a value sealed under a different secret (wrong key)', async () => {
		const sealed = await sealAtRest(SECRET, CANARY);
		await expect(openAtRest('a-totally-different-secret', sealed)).rejects.toThrow();
	});

	it('rejects a tampered ciphertext (GCM auth-tag mismatch)', async () => {
		const sealed = await sealAtRest(SECRET, CANARY);
		const parts = sealed.split(':');
		// Flip a character in the ciphertext segment.
		const ct = parts[3]!;
		const flipped = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
		const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${flipped}`;
		await expect(openAtRest(SECRET, tampered)).rejects.toThrow();
	});

	it('treats an unknown envelope version as plaintext (forward-safe passthrough)', async () => {
		// A future-version envelope is not one THIS reader can open, so strict
		// detection classifies it as plaintext and returns it verbatim rather than
		// crashing — the v2 reader that ships alongside v2 data is what opens it.
		const sealed = await sealAtRest(SECRET, CANARY);
		const parts = sealed.split(':');
		const bumped = `${parts[0]}:99:${parts[2]}:${parts[3]}`;
		expect(isSealedAtRest(bumped)).toBe(false);
		expect(await openAtRest(SECRET, bumped)).toBe(bumped);
	});

	// ── Prefix-collision safety (attacker-controlled bodies) ───────────────────

	it('reads an attacker plaintext that merely starts with "atrest:" verbatim', async () => {
		// Not a structurally valid envelope (wrong part count / non-base64), so it
		// is plaintext: never decrypted, never a crash.
		for (const body of ['atrest:', 'atrest:hello world', 'atrest:1:not-base64:nope']) {
			expect(isSealedAtRest(body)).toBe(false);
			expect(await openAtRest(SECRET, body)).toBe(body);
		}
	});

	it('seals an envelope-shaped plaintext for real (never skipped as already-sealed)', async () => {
		// Craft a value that is structurally a valid envelope but was NOT produced
		// by this instance (random IV + ciphertext bytes). The keyed idempotency
		// check must decline to treat it as sealed and encrypt it.
		const fakeIv = 'A'.repeat(16); // base64 of 12 zero-ish bytes, valid length
		const fakeCt = 'A'.repeat(24); // ≥ 16 bytes decoded
		const shaped = `atrest:1:${fakeIv}:${fakeCt}`;
		const sealed = await sealAtRest(SECRET, shaped);
		expect(sealed).not.toBe(shaped);
		expect(await openAtRest(SECRET, sealed)).toBe(shaped);
	});
});
