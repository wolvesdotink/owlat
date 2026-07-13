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
		// Primary key algorithm label, e.g. `eddsaLegacy` (the GnuPG-compatible
		// LEGACY curve25519 profile: EdDSA-legacy sign primary + ECDH encryption
		// subkey — what every OpenPGP implementation accepts; per locked decision
		// D1 the message/signature format is unchanged, only the key profile).
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
		// when the key-directory digest, instance key, or rotation-feed URL
		// (derived from SITE_URL) changes (no per-request OpenPGP signing for
		// anonymous callers). Absent until first published.
		cachedManifest: v.optional(
			v.object({
				keyDirectoryDigest: v.string(),
				instanceFingerprint: v.string(),
				rotationFeedUrl: v.string(),
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

	/**
	 * Discovered + TOFU-pinned public keys of OTHER instances' recipients (Sealed
	 * Mail key discovery, `e2ee/discovery.ts` + `e2ee/pinning.ts`). One row per
	 * remote address we have tried to seal to.
	 *
	 * This is a discovery CACHE plus a trust ledger:
	 *   - `outcome: 'trusted'` — we hold a pinned key usable to seal to `address`;
	 *     `pinnedFingerprint`/`pinnedPublicKeyArmored` are the trusted material and
	 *     equal the observed material.
	 *   - `outcome: 'keyChanged'` — discovery observed a fingerprint DIFFERENT from
	 *     the pin with no valid signed rotation. The pin is UNCHANGED (never
	 *     silently re-pinned); the conflicting key rides along in the `observed*`
	 *     fields so an explicit operator re-accept can adopt it.
	 *   - `outcome: 'notFound'` — negative cache: the address published no usable
	 *     key (short TTL so a newly-published key is picked up quickly).
	 *
	 * `expiresAt` drives the cache: a positive hit is refreshed after ~24h, a
	 * negative one re-checked after ~1h. Only PUBLIC key material is stored — there
	 * is no private key here — so this holds no secrets, but it IS trust state, so
	 * a re-pin only happens via a signed rotation or an explicit re-accept.
	 *
	 * Instance discovery infrastructure, not per-org business data (classified in
	 * `lib/tenantTables.ts` NON_TENANT_TABLES alongside `keyVault` / caches):
	 * regenerable by re-discovery. Written only by `e2ee/recipientKeys.ts`.
	 */
	recipientKeys: defineTable({
		// Full, lowercased recipient email (`localpart@domain`).
		address: v.string(),
		// Lowercased domain of `address` — the host discovery fetched from.
		domain: v.string(),
		// Last discovery outcome / current trust state (see the header).
		outcome: v.union(v.literal('trusted'), v.literal('keyChanged'), v.literal('notFound')),
		// The TOFU-pinned fingerprint (uppercase hex) — the key we will seal to.
		// Absent only when we have never successfully discovered a key.
		pinnedFingerprint: v.optional(v.string()),
		// ASCII-armored PUBLIC key of `pinnedFingerprint` (safe to store — public).
		pinnedPublicKeyArmored: v.optional(v.string()),
		// The fingerprint observed on the most recent discovery. Equals
		// `pinnedFingerprint` when `outcome === 'trusted'`; differs (the conflicting
		// key) when `outcome === 'keyChanged'`.
		observedFingerprint: v.optional(v.string()),
		// ASCII-armored PUBLIC key observed on the most recent discovery — retained
		// for a `keyChanged` conflict so an explicit re-accept can adopt it.
		observedPublicKeyArmored: v.optional(v.string()),
		// How the address key was obtained (`'wkd'` today; `'manifest'` reserved for
		// a future manifest-embedded directory).
		source: v.optional(v.union(v.literal('wkd'), v.literal('manifest'))),
		// The remote instance's signing-identity fingerprint, from its verified
		// `/.well-known/owlat.json` manifest (TOFU on the instance identity). Absent
		// when the manifest was missing/unverifiable and the key came from WKD alone.
		instanceFingerprint: v.optional(v.string()),
		// Cache expiry: re-discover once `Date.now() >= expiresAt` (24h positive /
		// 1h negative). Indexed so the refresh cron can page the soon-to-expire rows.
		expiresAt: v.number(),
		// First successful/attempted discovery for this address.
		discoveredAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_address', ['address'])
		.index('by_expiresAt', ['expiresAt']),
};
