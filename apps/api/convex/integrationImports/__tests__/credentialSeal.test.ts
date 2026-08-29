import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	sealImportCredential,
	openImportCredential,
	isSealedImportCredential,
} from '../credentialSeal';

/**
 * Plan L9 — the walker threads a Mailchimp/Stripe API key through
 * `_scheduled_functions` args across every hop of an import. Sealing keeps the
 * live credential out of that table: the persisted value must be ciphertext, and
 * only the in-memory open call recovers the plaintext for the outbound HTTP call.
 */
describe('integration-import credential sealing', () => {
	beforeEach(() => {
		vi.stubEnv('INSTANCE_SECRET', 'integration-import-seal-test-secret');
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('round-trips a credential through seal → open', async () => {
		const secret = 'mc_live_supersecretkey-123';
		const sealed = await sealImportCredential(secret);
		expect(sealed).not.toBe(secret);
		expect(sealed).not.toContain(secret); // plaintext never appears in the envelope
		expect(isSealedImportCredential(sealed)).toBe(true);
		expect(await openImportCredential(sealed)).toBe(secret);
	});

	it('produces a fresh nonce per seal (distinct ciphertext for the same input)', async () => {
		const a = await sealImportCredential('same-key');
		const b = await sealImportCredential('same-key');
		expect(a).not.toBe(b);
		expect(await openImportCredential(a)).toBe('same-key');
		expect(await openImportCredential(b)).toBe('same-key');
	});

	it('leaves the empty string untouched (no envelope, nothing to hide)', async () => {
		expect(await sealImportCredential('')).toBe('');
		expect(await openImportCredential('')).toBe('');
	});

	it('treats a non-envelope value as plaintext on open (mixed tolerance)', async () => {
		// A raw provider key is not our envelope shape, so open returns it verbatim.
		expect(await openImportCredential('sk_live_plain')).toBe('sk_live_plain');
		expect(isSealedImportCredential('sk_live_plain')).toBe(false);
	});

	it('fails to open a sealed value under a different INSTANCE_SECRET (fail closed)', async () => {
		const sealed = await sealImportCredential('rotate-me');
		vi.stubEnv('INSTANCE_SECRET', 'a-completely-different-secret');
		await expect(openImportCredential(sealed)).rejects.toThrow();
	});

	it('with no INSTANCE_SECRET, seal is a no-op and open throws on a sealed value', async () => {
		const sealed = await sealImportCredential('will-be-sealed');
		// Now drop the secret entirely.
		vi.stubEnv('INSTANCE_SECRET', '');
		// A plaintext key just passes through (behaviour identical to pre-L9).
		expect(await sealImportCredential('plain-key')).toBe('plain-key');
		// A value sealed while a secret existed can no longer be opened — fail closed.
		await expect(openImportCredential(sealed)).rejects.toThrow(/INSTANCE_SECRET/);
	});
});
