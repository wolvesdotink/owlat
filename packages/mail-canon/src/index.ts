/**
 * `@owlat/mail-canon` — the single, dependency-free home of the RFC 6376 §3.4
 * DKIM canonicalizer (unification decision U4).
 *
 * Extracted into its own leaf package so BOTH the inbound verifier
 * (`@owlat/mail-auth`, which re-exports it via its `./canon` subpath) and the
 * outbound signer (`@owlat/mail-message`) can consume the SAME bytes without
 * forming a build cycle (`mail-message → mail-auth → shared → mail-message`).
 * The module imports nothing but `node:` builtins, so it stays Convex-`'use
 * node'` safe by construction — there is no second copy of these rules anywhere.
 */
export {
	canonicalizeBody,
	canonicalizeBodyRelaxed,
	canonicalizeBodySimple,
	canonicalizeHeaderField,
	parseCanonicalization,
	stripSignatureValue,
} from './canon.js';
export type { Canonicalization } from './canon.js';
