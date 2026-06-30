/**
 * BetterAuth-compatible password hashing — the canonical, shared implementation.
 *
 * Reproduces the algorithm from `@better-auth/utils/password.node`:
 *   - random 16-byte salt (hex-encoded)
 *   - scrypt(N=16384, r=16, p=1, dkLen=64) over `password.normalize('NFKC')`
 *   - hash format: `{salt-hex}:{key-hex}`
 *
 * Re-implemented (rather than importing `@better-auth/utils`) so the setup CLI
 * and the web setup wizard can both produce BetterAuth-loginnable password
 * hashes without taking on that transitive dependency. Round-trip compatibility
 * with the real library is verified by passwordHash.test.ts.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_CONFIG = {
	N: 16384,
	r: 16,
	p: 1,
	dkLen: 64,
} as const;

function derive(password: string, saltHex: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(
			password.normalize('NFKC'),
			saltHex,
			SCRYPT_CONFIG.dkLen,
			{
				N: SCRYPT_CONFIG.N,
				r: SCRYPT_CONFIG.r,
				p: SCRYPT_CONFIG.p,
				maxmem: 128 * SCRYPT_CONFIG.N * SCRYPT_CONFIG.r * 2,
			},
			(err, key) => {
				if (err) reject(err);
				else resolve(key);
			},
		);
	});
}

export async function hashPassword(password: string): Promise<string> {
	const saltHex = randomBytes(16).toString('hex');
	const key = await derive(password, saltHex);
	return `${saltHex}:${key.toString('hex')}`;
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
	const [saltHex, keyHex] = hash.split(':');
	if (!saltHex || !keyHex) return false;
	const target = await derive(password, saltHex);
	// Constant-time comparison (matching mail/appPasswords.ts) so a verify can't
	// leak how many leading bytes matched via early-exit string ===. A malformed
	// or wrong-length keyHex yields a buffer whose length won't match target's,
	// so the (non-secret) length gate short-circuits before timingSafeEqual —
	// which itself throws on unequal lengths.
	const stored = Buffer.from(keyHex, 'hex');
	if (stored.length !== target.length) return false;
	return timingSafeEqual(target, stored);
}
