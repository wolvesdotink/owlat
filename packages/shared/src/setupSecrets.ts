/**
 * Setup-time secret generation.
 *
 * NODE-ONLY: uses `node:crypto`. Shared by the `owlat-setup` CLI
 * (`apps/setup-cli`) and the web setup endpoint
 * (`apps/web/server/api/setup/apply.post.ts`) so both produce the SAME secret
 * formats — most notably the prefixed `mta_…` / `whsec_…` MTA credentials and
 * the hex `INSTANCE_SECRET`. Exposed via the `@owlat/shared/setupSecrets`
 * subpath ONLY — it must never be re-exported from the `.` barrel, which has to
 * stay browser-safe.
 *
 * `generateSecret` returns URL-safe-alphabet base62 (no padding) from
 * `crypto.getRandomValues` — stable across the Bun and Node runtimes.
 */

import { webcrypto } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const KNOWN_PLACEHOLDER_SECRETS = new Set([
	'change-me',
	'changeme',
	'replace-me',
	'replace-with-openssl-rand-base64-32',
	// The historical non-interactive install default. It is public (repo, tests,
	// old release artifacts), so an admin account still authenticating with it
	// is effectively unauthenticated. Bootstrap refuses it outright.
	'devpassword12345',
]);

/** Reject documentation placeholders wherever setup or runtime consumes secrets. */
export function isKnownPlaceholderSecret(value: string): boolean {
	return KNOWN_PLACEHOLDER_SECRETS.has(value.trim().toLowerCase());
}

// The largest multiple of the 62-char alphabet that fits in a byte (256). A raw
// `byte % 62` is biased because 256 is not a multiple of 62 — indices 0..7 would
// occur on 5 byte values while 8..61 occur on 4 — so bytes at or above this
// threshold are rejected and re-drawn (rejection sampling), giving a uniform
// distribution over the alphabet.
const REJECTION_THRESHOLD = 256 - (256 % ALPHABET.length); // 248 for a 62-char alphabet

// `crypto.getRandomValues` rejects a view longer than 65,536 bytes per call, so
// batches are capped well below that; real call sites request tens of bytes, so
// a single batch almost always suffices.
const CRYPTO_BATCH_BYTES = 4096;

/**
 * Generate a uniformly-distributed base62 secret of `length` characters.
 * `length` counts OUTPUT characters (one alphabet symbol each), preserving the
 * historical call sites that pass the desired character count.
 */
export function generateSecret(length = 32): string {
	let out = '';
	// Draw a bounded batch, keep the unbiased bytes, and refill only if rejection
	// (or a short cap) left us short — in expectation ~3% of bytes are rejected.
	const batch = new Uint8Array(Math.min(Math.max(length, 1), CRYPTO_BATCH_BYTES));
	while (out.length < length) {
		webcrypto.getRandomValues(batch);
		for (const b of batch) {
			if (b >= REJECTION_THRESHOLD) continue;
			out += ALPHABET[b % ALPHABET.length];
			if (out.length === length) break;
		}
	}
	return out;
}

/**
 * Generate a hex secret (lowercase, no prefix). Used where a downstream
 * consumer hex-DECODES the value — notably the self-hosted Convex backend,
 * which hex-decodes `INSTANCE_SECRET` and crashes on boot ("Couldn't hexdecode
 * key") if given a non-hex string. Mirrors the legacy installer's
 * `openssl rand -hex <byteLength>`.
 */
export function generateHexSecret(byteLength = 32): string {
	const bytes = new Uint8Array(byteLength);
	webcrypto.getRandomValues(bytes);
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}

/**
 * Generate the full set of secrets a fresh install needs, in one call.
 * Missing keys in the existing env are filled in; provided keys are preserved
 * (idempotent). The single source of truth for setup-time secret formats,
 * shared by the CLI wizard and the web setup endpoint.
 */
export function ensureSecrets(existing: Record<string, string>): Record<string, string> {
	const out = { ...existing };
	const required: Record<string, () => string> = {
		BETTER_AUTH_SECRET: () => generateSecret(48),
		// MUST be hex — the self-hosted Convex backend hex-decodes INSTANCE_SECRET
		// and crashes on boot otherwise. 32 bytes → 64 hex chars (matches the
		// legacy installer's `openssl rand -hex 32`).
		INSTANCE_SECRET: () => generateHexSecret(32),
		UNSUBSCRIBE_SECRET: () => generateSecret(48),
		// Prefixed for human readability. The prefix is cosmetic: the MTA
		// validates MTA_API_KEY by constant-time equality and uses
		// MTA_WEBHOOK_SECRET as a raw HMAC key — neither strips the prefix.
		MTA_API_KEY: () => `mta_${generateSecret(40)}`,
		MTA_WEBHOOK_SECRET: () => `whsec_${generateSecret(40)}`,
		// Seals the MTA's transport secrets at rest (DKIM private keys, relay
		// credentials) via the MTA secret box. Boot-validated to be >= 32 bytes;
		// hex (64 chars) so it is copy-paste safe and comfortably over the floor.
		// Keep it STABLE across restarts — rotating it strands already-sealed values.
		MTA_SECRET: () => generateHexSecret(32),
		// Bearer token the Convex runtime presents to the mail-sync worker
		// (apps/mail-sync) on its internal /send + /test API. Generated alongside
		// MTA_API_KEY so enabling the external-mailbox feature (mail.external) boots
		// without the operator hand-writing a key: apps/mail-sync/src/config.ts
		// throws on an empty MAIL_SYNC_API_KEY and the container crash-loops. Used
		// only as a constant-time bearer token (server.ts), so the prefix is
		// cosmetic — any high-entropy string works.
		MAIL_SYNC_API_KEY: () => `msk_${generateSecret(40)}`,
		// Signs the VERP return-path token (BATV/HMAC) so a forged DSN cannot
		// poison the suppression list (RFC 5321: anyone may submit a DSN). Used
		// only as a raw HMAC key by the MTA, so any high-entropy string works.
		BOUNCE_VERP_KEY: () => generateSecret(40),
		REDIS_PASSWORD: () => generateSecret(32),
		// NOTE: CONVEX_ADMIN_KEY is intentionally NOT generated here. A
		// self-hosted Convex admin key must be MINTED BY THE RUNNING BACKEND
		// (`docker compose exec convex ./generate_admin_key.sh`) — a fabricated
		// random value is rejected by the backend for deploy/env-set. It is
		// generated and written to .env by the quickstart deploy step
		// (lib/convexDeploy.ts:generateConvexAdminKey).
	};
	for (const [key, gen] of Object.entries(required)) {
		if (!out[key] || (key === 'BOUNCE_VERP_KEY' && isKnownPlaceholderSecret(out[key]))) {
			out[key] = gen();
		}
	}
	return out;
}
