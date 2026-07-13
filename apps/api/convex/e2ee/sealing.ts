/**
 * The E2EE private-key secret box — the SINGLE source of truth for how Sealed
 * Mail seals OpenPGP private keys (per-address and the instance identity) at
 * rest.
 *
 * The context (`salt` + `info`) domain-separates this box from every other
 * consumer of `INSTANCE_SECRET` (external-mail creds, MTA transport, `.env`
 * backup), so a key sealed here can never open under another box — and, just as
 * important, so the sealing site (`e2ee/keysNode.ts`) and the opening site
 * (`e2ee/manifest.ts`) can never drift apart into two subtly-different literals.
 *
 * Convex-free pure helpers (no `query`/`mutation`/`action` exports): safe to
 * import from the `'use node'` action plane. Uses `node:crypto` via
 * `createSecretBox`, so only Node-runtime callers may import it.
 */

import { createSecretBox, type SecretBoxEnvelope } from '../lib/credentialCrypto';
import { getRequired } from '../lib/env';

/**
 * The E2EE private-key domain-separation context. Version-pinned; a change here
 * is a key-format break (existing sealed rows would no longer open).
 */
const E2EE_KEY_BOX = { salt: 'owlat:e2ee:keys:salt:v1', info: 'owlat:e2ee:keys:v1' } as const;

function e2eeKeyBox(): ReturnType<typeof createSecretBox> {
	return createSecretBox(getRequired('INSTANCE_SECRET'), E2EE_KEY_BOX);
}

/** Seal an armored OpenPGP private key at rest under the E2EE box. */
export function sealPrivateKey(privateKeyArmored: string): SecretBoxEnvelope {
	return e2eeKeyBox().seal(privateKeyArmored);
}

/** Open a sealed private-key envelope back to its armored OpenPGP private key. */
export function openPrivateKey(envelope: SecretBoxEnvelope): string {
	return e2eeKeyBox().open(envelope);
}
