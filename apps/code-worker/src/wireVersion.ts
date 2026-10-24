/**
 * The code-worker's wire contract version: what `maintenance/workerRegistry`
 * compares, per service, before a contract step removes something an older
 * worker still calls. The backend's own window for this service lives in
 * `@owlat/shared/workerWire`, which this image does not ship (it compiles a
 * filtered install without that package), so the number is kept here too and
 * `packages/shared/src/__tests__/workerWire.test.ts` keeps the two equal.
 *
 * Bump it in the PR that changes a function this worker calls (an argument or
 * result field added, removed or changing meaning, or a new function), together
 * with the `code-worker` entry in `@owlat/shared/workerWire`.
 *
 * - 1: reports its wire version.
 */
export const CODE_WORKER_WIRE_VERSION = 1;
