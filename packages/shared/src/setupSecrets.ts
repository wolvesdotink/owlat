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

export function generateSecret(byteLength = 32): string {
	const bytes = new Uint8Array(byteLength);
	webcrypto.getRandomValues(bytes);
	let out = '';
	for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
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
		if (!out[key]) out[key] = gen();
	}
	return out;
}
