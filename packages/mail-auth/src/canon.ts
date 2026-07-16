/**
 * RFC 6376 §3.4 DKIM canonicalization — a PUBLIC API (locked decisions D4 / U4).
 *
 * The implementation now lives in the dependency-free leaf package
 * `@owlat/mail-canon` so the outbound signer (`@owlat/mail-message`) can consume
 * the SAME bytes without forming the build cycle
 * `mail-message → mail-auth → shared → mail-message` (mail-auth transitively
 * deps shared; shared deps mail-message for the parse tree). `@owlat/mail-auth`
 * re-publishes it verbatim here so the `@owlat/mail-auth/canon` subpath (U4) and
 * every existing importer keep working unchanged, and so signer and verifier
 * still canonicalize through the ONE module. There is no second copy of these
 * rules anywhere — this file only re-exports.
 */
export {
	canonicalizeBody,
	canonicalizeBodyRelaxed,
	canonicalizeBodySimple,
	canonicalizeHeaderField,
	parseCanonicalization,
	stripSignatureValue,
} from '@owlat/mail-canon';
export type { Canonicalization } from '@owlat/mail-canon';
