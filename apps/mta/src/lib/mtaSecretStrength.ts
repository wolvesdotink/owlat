/**
 * The MTA_SECRET strength floor, shared by the boot validation in config.ts and
 * the secret box that seals under the key. It lives outside secretBox.ts because
 * the box imports config.ts (for its lazy MTA_SECRET read), so config.ts must
 * not import the box back.
 */

import { isKnownPlaceholderSecret } from '@owlat/shared/setupSecrets';

/**
 * The minimum MTA_SECRET length. A 32-byte key is the floor for AES-256-derived
 * material; a shorter secret is refused at boot so we never seal under a weak key.
 */
export const MTA_SECRET_MIN_BYTES = 32;

/**
 * Assert an MTA_SECRET is present and strong enough (>= 32 bytes). Called at
 * config load so a weak/absent secret fails the boot fast rather than sealing
 * transport secrets under a guessable key.
 *
 * @throws Error when the secret is missing or shorter than {@link MTA_SECRET_MIN_BYTES}.
 */
export function assertMtaSecretStrength(secret: string | undefined): asserts secret is string {
	if (!secret) {
		throw new Error(
			'MTA_SECRET is required — it seals DKIM keys and transport credentials at rest.'
		);
	}
	if (Buffer.byteLength(secret, 'utf8') < MTA_SECRET_MIN_BYTES) {
		throw new Error(
			`MTA_SECRET must be at least ${MTA_SECRET_MIN_BYTES} bytes; got ${Buffer.byteLength(secret, 'utf8')}.`
		);
	}
}

/**
 * The floor for the two secrets the MTA shares with Convex: `MTA_API_KEY`
 * (bearer for every control call) and `MTA_WEBHOOK_SECRET` (HMAC key for every
 * event the MTA reports). Setup generates both far above it; only a hand-edited
 * `.env` reaches this check.
 */
export const SHARED_SECRET_MIN_BYTES = 32;

/**
 * Refuse a placeholder or short shared secret when the MTA runs as a
 * production install (`NODE_ENV=production`, which both shipped compose files
 * set). Tests and a local `bun dev` run with short fixed values and are left
 * alone.
 *
 * @throws Error naming the variable when `enforce` is set and the value is weak.
 */
export function assertSharedSecretStrength(name: string, value: string, enforce: boolean): void {
	if (!enforce) return;
	const fix = 'Generate one with: openssl rand -hex 32, and set the same value in the backend.';
	if (isKnownPlaceholderSecret(value)) {
		throw new Error(`${name} is a documentation placeholder, not a secret. ${fix}`);
	}
	const bytes = Buffer.byteLength(value, 'utf8');
	if (bytes < SHARED_SECRET_MIN_BYTES) {
		throw new Error(
			`${name} must be at least ${SHARED_SECRET_MIN_BYTES} bytes; got ${bytes}. ${fix}`
		);
	}
}
