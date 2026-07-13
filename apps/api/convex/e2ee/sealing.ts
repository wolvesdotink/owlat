'use node';

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
 * Free of any `query`/`mutation`/`action` exports (pure helpers). It wraps
 * `createSecretBox` from the Node-runtime `lib/credentialCrypto.ts`, which uses
 * `node:crypto`, so — like that module — it runs in the Node runtime
 * (`'use node'`) and may be imported only by other Node-runtime modules.
 */

import { createSecretBox, type SecretBoxEnvelope } from '../lib/credentialCrypto';
import { getOptional, getRequired } from '../lib/env';

/**
 * The E2EE private-key domain-separation context. Version-pinned; a change here
 * is a key-format break (existing sealed rows would no longer open).
 */
export const E2EE_KEY_BOX = {
	salt: 'owlat:e2ee:keys:salt:v1',
	info: 'owlat:e2ee:keys:v1',
} as const;

/** The E2EE box keyed by an explicit secret — the reusable core the two below share. */
function e2eeKeyBoxFor(secret: string): ReturnType<typeof createSecretBox> {
	return createSecretBox(secret, E2EE_KEY_BOX);
}

function e2eeKeyBox(): ReturnType<typeof createSecretBox> {
	return e2eeKeyBoxFor(getRequired('INSTANCE_SECRET'));
}

/** Seal an armored OpenPGP private key at rest under the E2EE box (current secret). */
export function sealPrivateKey(privateKeyArmored: string): SecretBoxEnvelope {
	return e2eeKeyBox().seal(privateKeyArmored);
}

/**
 * Open a sealed private-key envelope back to its armored OpenPGP private key.
 *
 * INSTANCE_SECRET-ROTATION AWARE (E6): decryption is attempted under the CURRENT
 * `INSTANCE_SECRET` first and, only if that fails the GCM auth-tag check, under
 * `INSTANCE_SECRET_PREVIOUS` when it is set. That is what lets a MIXED-VERSION
 * vault (some rows still sealed under the old secret, some already re-sealed
 * under the new one) read correctly WHILE `reSealPrivateKey` migrates every row
 * — mirroring the credentialCrypto version-pinning pattern, but keyed on the
 * secret value rather than a numeric envelope version. When
 * `INSTANCE_SECRET_PREVIOUS` is unset (the normal steady state) this is exactly
 * the single-secret open with no behavior change.
 */
export function openPrivateKey(envelope: SecretBoxEnvelope): string {
	try {
		return e2eeKeyBox().open(envelope);
	} catch (err) {
		const previous = getOptional('INSTANCE_SECRET_PREVIOUS');
		if (!previous) throw err;
		return e2eeKeyBoxFor(previous).open(envelope);
	}
}

/**
 * Re-seal a private-key envelope under the CURRENT `INSTANCE_SECRET`. Opens with
 * the rotation-aware {@link openPrivateKey} (so a row still on the previous
 * secret is accepted) and re-seals under the current secret. Idempotent up to the
 * random GCM nonce: re-sealing an already-current row simply re-encrypts it. The
 * per-row unit of the E6 INSTANCE_SECRET re-seal migration
 * (`e2ee/lifecycleNode.ts:reSealVault`).
 */
export function reSealPrivateKey(envelope: SecretBoxEnvelope): SecretBoxEnvelope {
	return sealPrivateKey(openPrivateKey(envelope));
}
