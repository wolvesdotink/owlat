import { v } from 'convex/values';

// End-to-end encryption validators shared by the `keyVault` table
// (schema/e2ee.ts) and the key-management functions in e2ee/.

// Which kind of keypair a `keyVault` row holds: the singleton instance signing
// identity, or a per-address encryption identity.
export const keyVaultKindValidator = v.union(v.literal('instance'), v.literal('address'));

// The at-rest sealed private-key envelope (a `credentialCrypto` secret box).
export const sealedPrivateKeyValidator = v.object({
	ciphertext: v.string(),
	iv: v.string(),
	authTag: v.string(),
});
