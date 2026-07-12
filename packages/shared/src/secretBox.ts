/**
 * The shared AES-256-GCM + HKDF-SHA256 sealing primitive (secrets at rest).
 *
 * NODE-ONLY: uses `node:crypto`. Exposed via the `@owlat/shared/secretBox`
 * subpath ONLY — it must never be re-exported from the `.` barrel, which has to
 * stay browser-safe.
 *
 * This is the one parameterized envelope every "seal a secret on disk" consumer
 * binds to, so the crypto surface a future fix (KDF change, envelope-format
 * bump) must touch lives in exactly one place:
 *   - the MTA transport-secret box  (`apps/mta/src/lib/secretBox.ts`), keyed by
 *     MTA_SECRET under the `owlat:mta-secrets:*` context / `mtasealed:v1:` prefix;
 *   - the `.env`-backup box          (`envBackupBox.ts`), keyed by INSTANCE_SECRET
 *     under the `owlat:env-backup:*` context / `envsealed:v1:` prefix.
 *
 * It mirrors the Convex `createSecretBox` primitive
 * (apps/api/convex/lib/credentialCrypto.ts): the SAME core, parameterized by an
 * explicit domain-separation context. The Convex copy stays separate because it
 * is a `'use node'` action file importing Convex-only helpers — importing it
 * here would drag in the Convex runtime.
 *
 * Each consumer passes a DISTINCT salt/info/prefix triple, so a value sealed by
 * one box can never open under another (the derived key differs, and a differing
 * prefix is rejected before decryption is even attempted).
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // GCM standard 96-bit nonce
const AUTH_TAG_BYTES = 16; // GCM standard 128-bit auth tag (passed explicitly)

/**
 * The domain-separation context for a {@link SecretBox}. Two boxes with any
 * differing field produce values that cannot open under one another: `salt`/
 * `info` change the derived key, and `prefix` gates recognition of a sealed
 * token before decryption.
 */
export interface SecretBoxContext {
	/** HKDF salt — the version-pinned separation label. */
	salt: string;
	/** HKDF info — the per-use separation label. */
	info: string;
	/**
	 * The literal prefix every sealed token carries. Lets a reader distinguish a
	 * sealed token from a legacy plaintext value; the trailing `:v1:` marks the
	 * envelope layout.
	 */
	prefix: string;
}

/** A reusable AES-256-GCM + HKDF-SHA256 sealing primitive. */
export interface SecretBox {
	/** Seal a plaintext string into a self-describing sealed token (with prefix). */
	seal(plaintext: string): string;
	/** Open a sealed token back to plaintext. Throws on a bad prefix or auth-tag mismatch (tamper / wrong key). */
	open(sealed: string): string;
	/** Whether a stored value is a sealed token produced by {@link seal}. */
	isSealed(value: string): boolean;
}

/**
 * Build a {@link SecretBox} that derives its key from `secret` under the given
 * HKDF salt/info context and tags its output with `prefix`. Pure crypto — reads
 * no env — so callers control the secret source and the domain-separation labels.
 */
export function createSecretBox(secret: string, context: SecretBoxContext): SecretBox {
	const { prefix } = context;

	const deriveKey = (): Buffer => {
		const derived = hkdfSync(
			'sha256',
			Buffer.from(secret, 'utf8'),
			Buffer.from(context.salt, 'utf8'),
			Buffer.from(context.info, 'utf8'),
			KEY_BYTES
		);
		return Buffer.from(derived);
	};

	const isSealed = (value: string): boolean => value.startsWith(prefix);

	return {
		isSealed,
		seal(plaintext: string): string {
			const key = deriveKey();
			const iv = randomBytes(IV_BYTES);
			const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
			const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
			const authTag = cipher.getAuthTag();
			return (
				prefix +
				`${iv.toString('base64')}.${authTag.toString('base64')}.${ciphertext.toString('base64')}`
			);
		},
		open(sealed: string): string {
			if (!isSealed(sealed)) {
				throw new Error('secretBox.open: value is not a sealed token');
			}
			const body = sealed.slice(prefix.length);
			const parts = body.split('.');
			if (parts.length !== 3) {
				throw new Error('secretBox.open: malformed sealed token');
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
