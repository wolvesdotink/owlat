/**
 * Inbound PGP-SIGNED (unencrypted) mail — the PURE record vocabulary of the F1
 * signature-verification plane (adoption-gaps plan 2026-08-16, decision D9).
 *
 * This is the SIGNED-plaintext sibling of `e2ee/inboundSeal.ts`'s
 * `InboundEncryptionInfo`: a message that arrived as RFC 3156
 * `multipart/signed` or with an inline clearsigned body gets ONE honest record
 * of what we cryptographically checked at ingest. Deliberately NOT a third arm
 * on the sealed union (D9's rejected alternative) — the sealed arms carry
 * fail-closed sealed-mail semantics with their own honesty tests, and a signed
 * plaintext message makes no encryption claim at all.
 *
 * The record is persisted on `mailMessages.inboundSignatureInfo` and mirrored
 * as two display fields on `inboundMessages` (AI-inbox path). The `'use node'`
 * verifier that produces it lives in `e2ee/verifyInboundSignature.ts`; this
 * module stays free of `ctx`/db/network/`openpgp` so the vocabulary is
 * importable from `schema.ts`.
 */

import { v } from 'convex/values';

/**
 * Where the verification key came from:
 *   - `'pinned'`   — a cached TRUSTED TOFU pin was used directly (also the
 *     source on a `key_changed` refusal: the pin drove the decision);
 *   - `'wkd'` / `'manifest'` — fresh discovery found + pinned the key (same
 *     ladder sealed mail uses; F1 skips the instance-manifest fetch, so
 *     `'manifest'` only appears via a pin discovered by the sealed path);
 *   - `'not_found'` — no usable key anywhere ⇒ no verification was possible.
 */
export type InboundSignatureKeySource = 'pinned' | 'wkd' | 'manifest' | 'not_found';

/**
 * The honest inbound signature record. `isSignatureValid: true` ONLY when the
 * signature verified against the pinned/discovered sender key — every failure
 * (no key, bad signature, malformed structure, refused key change) stays
 * `false`, optionally annotated by `failure`:
 *   - `'key_changed'`          — the sender's observed key conflicts with the
 *     TOFU pin; verification is REFUSED until an admin resolves the pin
 *     (identical to sealed mail's fail-closed pin handling);
 *   - `'malformed_signature'`  — the message matched the structural gate but
 *     its signature part/armor could not be parsed;
 *   - `'verification_error'`   — the verifier itself failed; recorded honestly
 *     rather than blocking delivery.
 * A plain `false` with no `failure` means the crypto ran and did not verify
 * (tampered body or wrong key). The signer fields are present ONLY on a
 * verified signature.
 */
export type InboundSignatureInfo = {
	isSigned: true;
	isSignatureValid: boolean;
	/** Uppercase-hex fingerprint of the signing key — present only when verified. */
	signerFingerprint?: string;
	keySource: InboundSignatureKeySource;
	failure?: string;
};

/** Convex validator mirroring {@link InboundSignatureInfo} exactly (kept in lockstep). */
export const inboundSignatureInfoValidator = v.object({
	isSigned: v.literal(true),
	isSignatureValid: v.boolean(),
	signerFingerprint: v.optional(v.string()),
	keySource: v.union(
		v.literal('pinned'),
		v.literal('wkd'),
		v.literal('manifest'),
		v.literal('not_found')
	),
	failure: v.optional(v.string()),
});
