/**
 * Round-trip the CLI's password hash through BetterAuth's actual verifier.
 *
 * This is the load-bearing test for `quickstart`: if the scrypt parameters
 * drift from `@better-auth/utils/password.node`, the bootstrap-org flow
 * succeeds but sign-in afterwards fails silently. Verifying against the real
 * library catches that the moment it happens.
 */

import { describe, expect, it } from 'vitest';
import { verifyPassword as betterAuthVerify } from '@better-auth/utils/password';
import { hashPassword, verifyPassword } from '../passwordHash';

describe('passwordHash', () => {
	it('round-trips with its own verifier', async () => {
		const hash = await hashPassword('correct-horse-battery-staple');
		expect(await verifyPassword(hash, 'correct-horse-battery-staple')).toBe(true);
		expect(await verifyPassword(hash, 'wrong-password')).toBe(false);
	});

	it('produces a hash that BetterAuth itself can verify', async () => {
		const hash = await hashPassword('hunter2!secure-password');
		const ok = await betterAuthVerify(hash, 'hunter2!secure-password');
		expect(ok).toBe(true);

		const bad = await betterAuthVerify(hash, 'wrong');
		expect(bad).toBe(false);
	});

	it('NFKC-normalises so unicode equivalents match', async () => {
		// "café" composed (U+00E9) vs decomposed (e + U+0301) should hash the same.
		const composed = 'café';
		const decomposed = 'café';
		const hash = await hashPassword(composed);
		expect(await verifyPassword(hash, decomposed)).toBe(true);
	});

	it('uses the BetterAuth `{salt}:{key}` format', async () => {
		const hash = await hashPassword('whatever');
		const parts = hash.split(':');
		expect(parts).toHaveLength(2);
		// Salt is 16 bytes hex → 32 chars; key is 64 bytes hex → 128 chars.
		expect(parts[0]).toMatch(/^[0-9a-f]{32}$/);
		expect(parts[1]).toMatch(/^[0-9a-f]{128}$/);
	});
});
