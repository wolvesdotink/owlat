'use node';

/**
 * Connected-app hook-signing secret — sealing primitive (Tier 2).
 *
 * NODE-RUNTIME ONLY. This module builds on `lib/credentialCrypto`'s
 * `createSecretBox`, which imports `node:crypto`, so it must only be imported
 * from Convex `'use node'` action files (today: `connectedApps/actions.ts`).
 * Importing it from a v8 query/mutation file breaks that file's deploy bundle.
 *
 * A connected app is issued one high-entropy shared secret at registration. That
 * secret is the HMAC key both sides use to sign and verify synchronous hooks
 * (PP-24). Owlat only ever needs it inside the Node action that seals it (at
 * register/rotate) and, later, the Node action that signs an outbound hook, so
 * it is stored ONLY as an AES-256-GCM envelope, never in plaintext, and is
 * returned to the client exactly once — at the moment it is minted.
 *
 * Key derivation: HKDF-SHA256 over INSTANCE_SECRET under a fixed, version-pinned
 * salt + info pair that is DISTINCT from every other consumer (external-mail
 * creds, MTA secrets, keyVault). Two boxes with different labels derive
 * independent keys, so a connected-app secret can never open under another
 * consumer's context and vice-versa. Changing either label is a KDF change: bump
 * CURRENT_CONNECTED_APP_SECRET_VERSION and add a re-seal migration.
 */

import { randomBytes } from 'node:crypto';
import { createSecretBox, type SecretBoxEnvelope, type SecretBox } from '../lib/credentialCrypto';
import { getRequired } from '../lib/env';
import { CURRENT_CONNECTED_APP_SECRET_VERSION } from '../lib/constants';

// Version-pinned domain-separation labels. DISTINCT from external-mail creds.
const HKDF_SALT = 'owlat:connected-app:salt:v1';
const HKDF_INFO = 'owlat:connected-app:hook-secret:v1';

/** Bytes of entropy in a minted secret; base64url-encoded for a URL-safe token. */
const SECRET_ENTROPY_BYTES = 32;

/** Human-recognizable prefix so a leaked secret is greppable in incident review. */
const SECRET_PREFIX = 'cah_';

/** A sealed connected-app secret: the raw box plus the KDF/cipher version. */
export interface ConnectedAppSecretEnvelope extends SecretBoxEnvelope {
	/** matches CURRENT_CONNECTED_APP_SECRET_VERSION at seal time */
	version: number;
}

/** The connected-app box: INSTANCE_SECRET under the pinned, distinct context. */
function connectedAppBox(): SecretBox {
	return createSecretBox(getRequired('INSTANCE_SECRET'), { salt: HKDF_SALT, info: HKDF_INFO });
}

/**
 * Mint a fresh, cryptographically-random shared secret. 256 bits of entropy,
 * base64url-encoded (no padding), with a recognizable prefix. This is the only
 * value ever shown to the operator, and only once.
 */
export function generateConnectedAppSecret(): string {
	return SECRET_PREFIX + randomBytes(SECRET_ENTROPY_BYTES).toString('base64url');
}

/** Seal a plaintext secret into a versioned, authenticated envelope. */
export function sealConnectedAppSecret(plaintext: string): ConnectedAppSecretEnvelope {
	const box = connectedAppBox().seal(plaintext);
	return { ...box, version: CURRENT_CONNECTED_APP_SECRET_VERSION };
}

/** Open a sealed envelope back to the plaintext secret. Throws on tamper. */
export function openConnectedAppSecret(envelope: ConnectedAppSecretEnvelope): string {
	return connectedAppBox().open(envelope);
}
