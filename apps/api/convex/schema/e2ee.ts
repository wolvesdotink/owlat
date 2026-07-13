import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * End-to-end encryption key material (Sealed Mail, plan 2026-07-11).
 *
 * Spread into `defineSchema()` from schema.ts via `...e2eeTables`.
 *
 * `keyVault` holds the OpenPGP keypairs this instance controls:
 *   - one `'instance'` row: the instance identity keypair, minted once, used to
 *     SIGN the published `/.well-known/owlat.json` manifest;
 *   - one `'address'` row per sendable Postbox address (mailbox canonical
 *     address + every alias), whose PUBLIC key is published over WKD so other
 *     Owlat instances (and any WKD-aware client, e.g. Thunderbird) can seal mail
 *     to it.
 *
 * The PRIVATE key never leaves the instance in the clear: it is sealed at rest
 * with `createSecretBox(INSTANCE_SECRET, owlat:e2ee:keys)` (AES-256-GCM +
 * HKDF-SHA256, domain-separated from every other secret box). Only the
 * `'use node'` action plane (`e2ee/keysNode.ts`, `e2ee/manifest.ts`) ever opens
 * it; no public query returns `sealedPrivateKey`.
 *
 * The public material (`publicKeyArmored`, `publicKeyBinaryBase64`) is safe to
 * serve to the world by design — that is the whole point of key discovery.
 *
 * Instance crypto infrastructure, not per-org business data — see
 * `lib/tenantTables.ts` NON_TENANT_TABLES (classified alongside `aiProviderConfig`
 * / `tlsReports`). Written only by `e2ee/keys.ts:storeKeypair`.
 */
export const e2eeTables = {
	keyVault: defineTable({
		// Which kind of keypair this row holds. `'instance'` is the singleton
		// signing identity; `'address'` is a per-address encryption identity.
		kind: v.union(v.literal('instance'), v.literal('address')),
		// Full, lowercased email address (`localpart@domain`) for `'address'`
		// rows; absent for the `'instance'` identity.
		address: v.optional(v.string()),
		// Lowercased domain of `address` — the host a WKD lookup must match
		// (direct method, draft-koch-openpgp-webkey-service). Absent for instance.
		domain: v.optional(v.string()),
		// WKD local-part hash: zbase32(SHA-1(lowercase(localpart))) — the `hu/<hash>`
		// path segment. Stored so the WKD query is a pure indexed lookup with no
		// hashing in the request path. Absent for the instance identity.
		wkdHash: v.optional(v.string()),
		// Uppercase-hex OpenPGP v4 primary-key fingerprint (identity of the key).
		fingerprint: v.string(),
		// Primary key algorithm label, e.g. `ed25519` (Ed25519 sign primary with
		// an X25519 encryption subkey, per locked decision D1).
		algorithm: v.string(),
		// ASCII-armored transferable PUBLIC key (safe to serve).
		publicKeyArmored: v.string(),
		// The same transferable PUBLIC key in BINARY form, base64-encoded — the
		// exact `application/octet-stream` body a WKD `hu/<hash>` fetch returns.
		publicKeyBinaryBase64: v.string(),
		// The armored PRIVATE key sealed with the E2EE secret box (never returned
		// by any public query). `SecretBoxEnvelope` from lib/credentialCrypto.ts.
		sealedPrivateKey: v.object({
			ciphertext: v.string(),
			iv: v.string(),
			authTag: v.string(),
		}),
		// Whether this keypair is the current active key for its subject. Key
		// rotation (a later Sealed-Mail piece) flips old rows to `false`.
		isActive: v.boolean(),
		// INSTANCE row only: the last signed `/.well-known/owlat.json` manifest,
		// cached so the public route serves byte-stable bytes and re-signs only
		// when the key-directory digest or instance key changes (no per-request
		// OpenPGP signing for anonymous callers). Absent until first published.
		cachedManifest: v.optional(
			v.object({
				keyDirectoryDigest: v.string(),
				instanceFingerprint: v.string(),
				signedManifestJson: v.string(),
			})
		),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_address', ['address'])
		.index('by_fingerprint', ['fingerprint'])
		.index('by_kind', ['kind'])
		// Direct-method WKD lookup: match a stored address key by its domain +
		// local-part hash in one indexed read.
		.index('by_wkd', ['domain', 'wkdHash']),
};
