/**
 * The MTA_SECRET strength floor, shared by the boot validation in config.ts and
 * the secret box that seals under the key. It lives outside secretBox.ts because
 * the box imports config.ts (for its lazy MTA_SECRET read), so config.ts must
 * not import the box back.
 */

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
