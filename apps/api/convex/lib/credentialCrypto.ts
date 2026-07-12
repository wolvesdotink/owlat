'use node';

/**
 * AES-256-GCM encryption for external-mailbox credentials at rest.
 *
 * NODE-RUNTIME ONLY. This module imports `node:crypto`, so it must only be
 * imported from Convex `'use node'` action files (today: mail/externalAccountsActions.ts).
 * Importing it from a v8 query/mutation file breaks that file's deploy bundle.
 *
 * Key derivation: HKDF-SHA256 over INSTANCE_SECRET with a fixed, version-pinned
 * salt + context label, domain-separating this key from any other use of
 * INSTANCE_SECRET. The encrypted envelope is versioned by
 * CURRENT_EXTERNAL_MAIL_CRED_VERSION (lib/constants.ts) so the KDF/cipher can
 * rotate behind a one-shot re-encrypt migration.
 *
 * The plaintext we encrypt is a JSON blob (e.g. `{ imapPassword, smtpPassword? }`);
 * callers serialize/parse it. We return ciphertext/iv/authTag as base64 strings
 * for storage on the `externalMailAccounts` row. `decryptSecret` throws if the
 * GCM auth tag does not verify (tamper / wrong key).
 *
 * This module is also the home of the reusable `createSecretBox(secret, context)`
 * primitive: the same AES-256-GCM + HKDF-SHA256 core, parameterized by an
 * explicit domain-separation {@link SecretBoxContext} (salt + info). New
 * consumers (T6 MTA transport secrets, E1 keyVault private keys) MUST build
 * their own box with a DISTINCT salt/info pair so their keys stay
 * cryptographically isolated from these external-mail credentials and from each
 * other — never reuse another consumer's labels.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { getRequired } from './env';
import { CURRENT_EXTERNAL_MAIL_CRED_VERSION } from './constants';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // GCM standard 96-bit nonce
const AUTH_TAG_BYTES = 16; // GCM standard 128-bit auth tag (passed explicitly)

// Fixed HKDF salt + info — the version-pinned context that domain-separates
// this key. Changing either is a KDF change: bump
// CURRENT_EXTERNAL_MAIL_CRED_VERSION and add a re-encrypt migration.
const HKDF_SALT = 'owlat:external-mail:salt:v1';
const HKDF_INFO = 'owlat:external-mail:creds:v1';

export interface EncryptedEnvelope extends SecretBoxEnvelope {
	/** matches CURRENT_EXTERNAL_MAIL_CRED_VERSION at encrypt time */
	version: number;
}

/**
 * The domain-separation context for an HKDF-derived key. `salt` and `info` are
 * fed verbatim to HKDF-SHA256; two boxes with different labels derive
 * independent keys, so a payload sealed under one context can never open under
 * another (cross-context isolation).
 */
export interface SecretBoxContext {
	/** HKDF salt — the version-pinned separation label. */
	salt: string;
	/** HKDF info — the per-use separation label. */
	info: string;
}

/**
 * The authenticated ciphertext produced by a {@link SecretBox}. Version-free by
 * design: callers that need envelope versioning (external-mail creds) wrap this
 * with their own version field, while other consumers (MTA secrets, keyVault)
 * store the raw box.
 */
export interface SecretBoxEnvelope {
	/** base64-encoded ciphertext */
	ciphertext: string;
	/** base64-encoded 12-byte GCM nonce */
	iv: string;
	/** base64-encoded 16-byte GCM auth tag */
	authTag: string;
}

/**
 * A reusable AES-256-GCM + HKDF-SHA256 sealing primitive. The MTA (transport
 * secrets) and the keyVault (E2EE private keys) construct their own box with a
 * distinct {@link SecretBoxContext}, so every consumer shares the exact same
 * crypto core while staying cryptographically domain-separated.
 */
export interface SecretBox {
	/** Derive the 32-byte AES key from `secret` via HKDF-SHA256. */
	deriveKey(): Buffer;
	/** Encrypt a plaintext string into an authenticated envelope. */
	seal(plaintext: string): SecretBoxEnvelope;
	/** Decrypt an envelope back to plaintext. Throws on auth-tag mismatch (tamper). */
	open(envelope: SecretBoxEnvelope): string;
}

/**
 * Build a {@link SecretBox} that derives its key from `secret` under the given
 * HKDF salt/info context. Pure crypto — reads no env — so callers control the
 * secret source and the domain-separation labels.
 */
export function createSecretBox(secret: string, context: SecretBoxContext): SecretBox {
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

	return {
		deriveKey,
		seal(plaintext: string): SecretBoxEnvelope {
			const key = deriveKey();
			const iv = randomBytes(IV_BYTES);
			const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
			const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
			const authTag = cipher.getAuthTag();
			return {
				ciphertext: ciphertext.toString('base64'),
				iv: iv.toString('base64'),
				authTag: authTag.toString('base64'),
			};
		},
		open(envelope: SecretBoxEnvelope): string {
			const key = deriveKey();
			const iv = Buffer.from(envelope.iv, 'base64');
			const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
			decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
			const plaintext = Buffer.concat([
				decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
				decipher.final(),
			]);
			return plaintext.toString('utf8');
		},
	};
}

/** The external-mail credentials box: INSTANCE_SECRET under the pinned context. */
function externalMailBox(): SecretBox {
	return createSecretBox(getRequired('INSTANCE_SECRET'), { salt: HKDF_SALT, info: HKDF_INFO });
}

/** Derive the 32-byte AES key from INSTANCE_SECRET via HKDF-SHA256. */
export function deriveKey(): Buffer {
	return externalMailBox().deriveKey();
}

/** Encrypt a plaintext string into an authenticated, versioned envelope. */
export function encryptSecret(plaintext: string): EncryptedEnvelope {
	const box = externalMailBox().seal(plaintext);
	return { ...box, version: CURRENT_EXTERNAL_MAIL_CRED_VERSION };
}

/** Decrypt an envelope back to plaintext. Throws on auth-tag mismatch (tamper). */
export function decryptSecret(envelope: EncryptedEnvelope): string {
	return externalMailBox().open(envelope);
}
