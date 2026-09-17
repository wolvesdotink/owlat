/**
 * Phase index — re-exports every Bounce intake phase and the composed main
 * pipeline.
 *
 * The bounce server imports `mainPipeline` only; individual phase files
 * are imported here exclusively. Reordering a phase in this file is a
 * TypeScript error if it violates the ctx-chain — e.g., `attachmentMetaPhase`
 * cannot run before `resolveRoutePhase` because it consumes `route`.
 */

import { compose } from '../pipeline.js';
import { parseFblOrDsnPhase } from './parseFblOrDsn.js';
import { resolveRoutePhase } from './resolveRoute.js';
import { attachmentMetaPhase } from './attachmentMeta.js';

export { attachmentMetaPhase, parseFblOrDsnPhase, resolveRoutePhase };

/**
 * The main bounce intake pipeline composed in the order the pre-deepening
 * onData handler ran its check blocks. Type-checking enforces the chain:
 * `resolveRoutePhase` must precede `attachmentMetaPhase` (which consumes
 * the `route` it produces for the accept branch).
 */
export const mainPipeline = compose(parseFblOrDsnPhase, resolveRoutePhase, attachmentMetaPhase);
