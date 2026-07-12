/**
 * Sealing for credential values in the `.env` BACKUP copy (secrets at rest).
 *
 * NODE-ONLY: uses `node:crypto`. Exposed via the `@owlat/shared/envBackupBox`
 * subpath ONLY — it must never be re-exported from the `.` barrel, which has to
 * stay browser-safe.
 *
 * Why this exists: the LIVE source for transport credentials is the Convex
 * deployment's env store (already encrypted; written by `apply-transport` /
 * setup via `pushConvexRuntimeEnv` or `convex env set`). The `.env` file on
 * disk is only the BACKUP copy that survives a container recreate — but it held
 * the SMTP relay password in plaintext, so a filesystem/backup dump leaked it.
 * This box seals that backup copy while the live store keeps working plaintext.
 *
 * This is the `.env`-backup twin of the Convex `createSecretBox` primitive
 * (apps/api/convex/lib/credentialCrypto.ts): the SAME AES-256-GCM + HKDF-SHA256
 * core, parameterized by an explicit domain-separation context. It is
 * re-implemented rather than imported because the Convex module is a
 * `'use node'` action file importing Convex-only helpers (`./env`,
 * `./constants`) — importing it here would drag in the Convex runtime and cross
 * the package boundary the cross-package-import guard forbids.
 *
 * The box is keyed by INSTANCE_SECRET (present in every install's `.env`; the
 * same secret the Convex external-mail box derives from) under HKDF context
 * labels DISTINCT from every other consumer (external-mail creds, MTA transport
 * secrets, keyVault), so a value sealed here can never open under another box —
 * and vice versa.
 *
 * Sealed tokens are self-describing via {@link ENV_BACKUP_SEALED_PREFIX}, so a
 * reader (the deploy-time reseed in `selectRuntimeEnvVars`) can distinguish a
 * sealed value from a legacy plaintext one: plaintext passes through untouched
 * (legacy `.env` files keep deploying fine), sealed tokens are unsealed before
 * being pushed to the live deployment env store, and a tampered/unopenable
 * token FAILS CLOSED — ciphertext is never pushed as a live credential.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // GCM standard 96-bit nonce
const AUTH_TAG_BYTES = 16; // GCM standard 128-bit auth tag (passed explicitly)

/**
 * The HKDF domain-separation context for the `.env`-backup box. Changing either
 * label is a KDF change that would strand every value already sealed under the
 * old labels — bump the `:v1` suffix and add a re-seal migration.
 */
const ENV_BACKUP_SALT = 'owlat:env-backup:salt:v1';
const ENV_BACKUP_INFO = 'owlat:env-backup:values:v1';

/**
 * The prefix every sealed `.env`-backup value carries. It lets the deploy-time
 * reseed distinguish a sealed token from a plain value (legacy `.env` files),
 * and makes sealed values recognizable to an operator reading the file. The
 * `:v1:` marks the envelope layout.
 */
export const ENV_BACKUP_SEALED_PREFIX = 'envsealed:v1:';

/** Whether a stored `.env` value is a sealed token produced by {@link EnvBackupBox.seal}. */
export function isEnvBackupSealedValue(value: string): boolean {
	return value.startsWith(ENV_BACKUP_SEALED_PREFIX);
}

/** An AES-256-GCM + HKDF-SHA256 sealing primitive for `.env`-backup values. */
export interface EnvBackupBox {
	/** Seal a plaintext string into a self-describing sealed token (with prefix). */
	seal(plaintext: string): string;
	/** Open a sealed token back to plaintext. Throws on a bad prefix or auth-tag mismatch (tamper / wrong key). */
	open(sealed: string): string;
	/** Whether a stored value is a sealed token produced by {@link seal}. */
	isSealed(value: string): boolean;
}

/**
 * Build the `.env`-backup box keyed by `instanceSecret` under the pinned
 * env-backup context. Pure crypto — reads no env — so callers pass the
 * INSTANCE_SECRET they already hold (it lives in the same `.env` map).
 *
 * @throws Error when `instanceSecret` is empty — sealing under an absent key
 * would produce tokens nothing can ever open.
 */
export function createEnvBackupBox(instanceSecret: string): EnvBackupBox {
	if (!instanceSecret) {
		throw new Error('createEnvBackupBox: INSTANCE_SECRET is required to seal/unseal .env values.');
	}

	const deriveKey = (): Buffer => {
		const derived = hkdfSync(
			'sha256',
			Buffer.from(instanceSecret, 'utf8'),
			Buffer.from(ENV_BACKUP_SALT, 'utf8'),
			Buffer.from(ENV_BACKUP_INFO, 'utf8'),
			KEY_BYTES
		);
		return Buffer.from(derived);
	};

	return {
		isSealed: isEnvBackupSealedValue,
		seal(plaintext: string): string {
			const key = deriveKey();
			const iv = randomBytes(IV_BYTES);
			const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
			const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
			const authTag = cipher.getAuthTag();
			return (
				ENV_BACKUP_SEALED_PREFIX +
				`${iv.toString('base64')}.${authTag.toString('base64')}.${ciphertext.toString('base64')}`
			);
		},
		open(sealed: string): string {
			if (!isEnvBackupSealedValue(sealed)) {
				throw new Error('envBackupBox.open: value is not a sealed token');
			}
			const body = sealed.slice(ENV_BACKUP_SEALED_PREFIX.length);
			const parts = body.split('.');
			if (parts.length !== 3) {
				throw new Error('envBackupBox.open: malformed sealed token');
			}
			const [ivB64, tagB64, ctB64] = parts as [string, string, string];
			const key = deriveKey();
			const iv = Buffer.from(ivB64, 'base64');
			const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
			decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
			const plaintext = Buffer.concat([
				decipher.update(Buffer.from(ctB64, 'base64')),
				decipher.final(),
			]);
			return plaintext.toString('utf8');
		},
	};
}
