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
 *
 * Also home to the byte-exact RFC 3156 `multipart/signed` first-part
 * extraction (`rfc3156.ts`) — same byte-preservation doctrine, same
 * dependency-free constraint, consumed by the inbound signature verifier.
 *
 * And home to the raw header splitter (`rawMessage.ts`): where the header
 * section ends and how fields fold, shared by the DKIM signer and verifier so
 * the two cannot disagree. It imports nothing, so the Convex isolate reaches
 * it through the `@owlat/mail-canon/rawMessage` subpath without this index.
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
export { extractRfc3156SignedPart } from './rfc3156.js';
export type { Rfc3156SignedParts } from './rfc3156.js';
export { findRawHeader, parseRawHeaderFields, splitRawHeaderBlock } from './rawMessage.js';
export type { RawHeaderField } from './rawMessage.js';
