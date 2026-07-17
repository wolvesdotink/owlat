/**
 * Per-domain VERP return-path host validation.
 *
 * The strict validator now lives in `@owlat/shared` so the MTA (this D1
 * register-endpoint gate) and the Convex backend (the `setReturnPathHost`
 * mutation + the atomic add-domain path) share ONE acceptance definition and can
 * never drift. Re-exported here so the existing MTA import sites are unchanged.
 */

export { normalizeReturnPathHost, isValidReturnPathHost } from '@owlat/shared/returnPathHost';
