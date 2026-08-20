/**
 * @owlat/ostr-core — Open Sender Trust Registry primitives.
 *
 * Root barrel. Submodules are also importable directly via the subpath
 * exports `@owlat/ostr-core/{attestation,merkle,scoring}`.
 */
export * from './types.js';
export * from './crypto.js';
export * from './jcs.js';
export * from './distribution.js';
export * from './attestation/index.js';
export * from './merkle/index.js';
export * from './scoring/index.js';
