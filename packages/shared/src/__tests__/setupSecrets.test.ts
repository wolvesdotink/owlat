import { describe, it, expect } from 'vitest';
import { ensureSecrets, generateSecret } from '../setupSecrets';

describe('ensureSecrets', () => {
	it('generates a non-empty MAIL_SYNC_API_KEY on a fresh install', () => {
		// Regression: the external-mailbox feature (mail.external / apps/mail-sync)
		// crash-looped out of the box because setup never minted MAIL_SYNC_API_KEY,
		// so docker-compose passed an empty value and apps/mail-sync/src/config.ts
		// threw "MAIL_SYNC_API_KEY is required". It must be generated alongside the
		// other setup secrets, exactly like MTA_API_KEY.
		const out = ensureSecrets({});
		expect(out['MAIL_SYNC_API_KEY']).toBeTruthy();
		expect(typeof out['MAIL_SYNC_API_KEY']).toBe('string');
		expect(out['MAIL_SYNC_API_KEY']!.length).toBeGreaterThan(8);
		// Minted next to the MTA bearer token — both are required for a bootable
		// receiving stack.
		expect(out['MTA_API_KEY']).toBeTruthy();
	});

	it('mints a >= 32-byte hex MTA_SECRET so the MTA can seal secrets at rest', () => {
		// The MTA refuses to boot without a >= 32-byte MTA_SECRET (it seals DKIM
		// keys + relay credentials at rest). Setup must mint one so a fresh install
		// boots the sending stack without the operator hand-writing a key.
		const out = ensureSecrets({});
		expect(out['MTA_SECRET']).toBeTruthy();
		expect(out['MTA_SECRET']).toMatch(/^[0-9a-f]{64}$/);
		expect(Buffer.byteLength(out['MTA_SECRET']!, 'utf8')).toBeGreaterThanOrEqual(32);
	});

	it('mints a VERP key and replaces the documentation placeholder', () => {
		const fresh = ensureSecrets({});
		expect(fresh['BOUNCE_VERP_KEY']).toMatch(/^[A-Za-z0-9]{40}$/);
		const repaired = ensureSecrets({
			BOUNCE_VERP_KEY: 'replace-with-openssl-rand-base64-32',
		});
		expect(repaired['BOUNCE_VERP_KEY']).toMatch(/^[A-Za-z0-9]{40}$/);
		expect(repaired['BOUNCE_VERP_KEY']).not.toBe('replace-with-openssl-rand-base64-32');
	});

	it('preserves an operator-supplied MTA_SECRET (idempotent)', () => {
		const out = ensureSecrets({ MTA_SECRET: 'operator-provided-secret-value-32bytes!!' });
		expect(out['MTA_SECRET']).toBe('operator-provided-secret-value-32bytes!!');
	});

	it('mints a matching Web Push VAPID key pair on a fresh install', async () => {
		const out = ensureSecrets({});
		const publicKey = Buffer.from(out['VAPID_PUBLIC_KEY']!, 'base64url');
		const privateKey = Buffer.from(out['VAPID_PRIVATE_KEY']!, 'base64url');
		// Uncompressed P-256 point and a raw 32-byte scalar, base64url unpadded.
		expect(publicKey).toHaveLength(65);
		expect(publicKey[0]).toBe(0x04);
		expect(privateKey).toHaveLength(32);
		expect(out['VAPID_PUBLIC_KEY']).toMatch(/^[A-Za-z0-9_-]+$/);
		// The two halves belong together: a signature made with the private half
		// verifies under the public half.
		const subtle = globalThis.crypto.subtle;
		const signingKey = await subtle.importKey(
			'jwk',
			{
				kty: 'EC',
				crv: 'P-256',
				d: out['VAPID_PRIVATE_KEY'],
				x: publicKey.subarray(1, 33).toString('base64url'),
				y: publicKey.subarray(33).toString('base64url'),
			},
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['sign']
		);
		const verifyKey = await subtle.importKey(
			'raw',
			publicKey,
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['verify']
		);
		const data = new TextEncoder().encode('owlat');
		const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, data);
		expect(
			await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, signature, data)
		).toBe(true);
	});

	it('never replaces half of an existing VAPID pair', () => {
		const kept = ensureSecrets({ VAPID_PUBLIC_KEY: 'operator-public' });
		expect(kept['VAPID_PUBLIC_KEY']).toBe('operator-public');
		expect(kept['VAPID_PRIVATE_KEY']).toBeUndefined();
		const both = ensureSecrets({ VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b' });
		expect(both['VAPID_PUBLIC_KEY']).toBe('a');
		expect(both['VAPID_PRIVATE_KEY']).toBe('b');
	});

	it('is idempotent — preserves an operator-supplied MAIL_SYNC_API_KEY', () => {
		const out = ensureSecrets({ MAIL_SYNC_API_KEY: 'msk_existing' });
		expect(out['MAIL_SYNC_API_KEY']).toBe('msk_existing');
	});

	it('gives each install a distinct MAIL_SYNC_API_KEY', () => {
		expect(ensureSecrets({})['MAIL_SYNC_API_KEY']).not.toBe(ensureSecrets({})['MAIL_SYNC_API_KEY']);
	});

	it('generateSecret returns a non-empty URL-safe string of the requested length', () => {
		const s = generateSecret(40);
		expect(s).toHaveLength(40);
		expect(s).toMatch(/^[A-Za-z0-9]+$/);
	});

	it('generateSecret honours varied lengths, including 0', () => {
		expect(generateSecret(0)).toBe('');
		expect(generateSecret(1)).toHaveLength(1);
		expect(generateSecret(100)).toHaveLength(100);
	});

	it('generateSecret is unbiased across the base62 alphabet (rejection sampling)', () => {
		// A biased `byte % 62` over-weights the first 8 symbols (indices 0..7 map
		// from 5 byte values, 8..61 from 4). Sample a large secret and assert the
		// per-symbol counts do not split into a "5/62 vs 4/62" high/low band — the
		// max-count / min-count ratio stays well below the ~1.25 a modulo bias
		// would force. Rejection sampling makes the draw uniform.
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		const N = 620_000;
		const s = generateSecret(N);
		const counts = new Map<string, number>();
		for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
		// Every symbol appears; none is systematically starved or favoured.
		expect(counts.size).toBe(alphabet.length);
		const values = [...counts.values()];
		const expected = N / alphabet.length; // 10_000
		const max = Math.max(...values);
		const min = Math.min(...values);
		// A modulo bias would push max/min toward 5/4 = 1.25; uniform sampling keeps
		// the spread tight around ±5% of expectation.
		expect(max / min).toBeLessThan(1.1);
		expect(max).toBeLessThan(expected * 1.06);
		expect(min).toBeGreaterThan(expected * 0.94);
	});
});
