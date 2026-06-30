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
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { getRequired } from './env';
import { CURRENT_EXTERNAL_MAIL_CRED_VERSION } from './constants';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // GCM standard 96-bit nonce

// Fixed HKDF salt + info — the version-pinned context that domain-separates
// this key. Changing either is a KDF change: bump
// CURRENT_EXTERNAL_MAIL_CRED_VERSION and add a re-encrypt migration.
const HKDF_SALT = 'owlat:external-mail:salt:v1';
const HKDF_INFO = 'owlat:external-mail:creds:v1';

export interface EncryptedEnvelope {
	/** base64-encoded ciphertext */
	ciphertext: string;
	/** base64-encoded 12-byte GCM nonce */
	iv: string;
	/** base64-encoded 16-byte GCM auth tag */
	authTag: string;
	/** matches CURRENT_EXTERNAL_MAIL_CRED_VERSION at encrypt time */
	version: number;
}

/** Derive the 32-byte AES key from INSTANCE_SECRET via HKDF-SHA256. */
export function deriveKey(): Buffer {
	const secret = getRequired('INSTANCE_SECRET');
	const derived = hkdfSync(
		'sha256',
		Buffer.from(secret, 'utf8'),
		Buffer.from(HKDF_SALT, 'utf8'),
		Buffer.from(HKDF_INFO, 'utf8'),
		KEY_BYTES,
	);
	return Buffer.from(derived);
}

/** Encrypt a plaintext string into an authenticated, versioned envelope. */
export function encryptSecret(plaintext: string): EncryptedEnvelope {
	const key = deriveKey();
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGORITHM, key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const authTag = cipher.getAuthTag();
	return {
		ciphertext: ciphertext.toString('base64'),
		iv: iv.toString('base64'),
		authTag: authTag.toString('base64'),
		version: CURRENT_EXTERNAL_MAIL_CRED_VERSION,
	};
}

/** Decrypt an envelope back to plaintext. Throws on auth-tag mismatch (tamper). */
export function decryptSecret(envelope: EncryptedEnvelope): string {
	const key = deriveKey();
	const iv = Buffer.from(envelope.iv, 'base64');
	const decipher = createDecipheriv(ALGORITHM, key, iv);
	decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
	const plaintext = Buffer.concat([
		decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
		decipher.final(),
	]);
	return plaintext.toString('utf8');
}
