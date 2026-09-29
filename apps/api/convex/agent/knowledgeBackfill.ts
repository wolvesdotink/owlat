/**
 * Compatibility shim: the message knowledge backfill moved to
 * `knowledge/messageBackfill.ts`.
 *
 * A chunk already scheduled under the old path when the move deploys still
 * resolves here and runs the moved walker; its follow-up chunks are scheduled
 * under the new path. Only `runChunk` is re-exported, because it is the only
 * function the scheduler can hold a reference to.
 *
 * Remove this file one release after the move.
 */

export { runChunk } from '../knowledge/messageBackfill';
