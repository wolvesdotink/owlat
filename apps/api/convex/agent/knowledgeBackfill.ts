/**
 * Compatibility shim: the message knowledge backfill moved to
 * `knowledge/messageBackfill.ts`.
 *
 * Everything the previous release reached at this path is re-exported, with
 * unchanged arguments and results (CONVENTIONS.md, "Old clients and workers
 * against new functions"):
 *  - `runChunk`: a chunk already scheduled under the old path still runs the
 *    moved walker, and its follow-up chunks are scheduled under the new path;
 *  - `loadJob`, `isAgentEnabled`, `nextChunk`, `hasExtraction`,
 *    `patchProgress`, `finalizeJob`: an old `runChunk` action still running
 *    when the move deploys makes each of these calls by its old path;
 *  - `getStatus`, `cancel`: the previous web app's backfill card, in tabs
 *    opened before the deploy.
 * `hasAnyJob` and `createJob` are not here: the old `setFeatureFlag` called them
 * from inside its own mutation, so no call can be in flight across a deploy.
 *
 * Remove after release N+1: delete this file one release after the move.
 */

export {
	cancel,
	finalizeJob,
	getStatus,
	hasExtraction,
	isAgentEnabled,
	loadJob,
	nextChunk,
	patchProgress,
	runChunk,
} from '../knowledge/messageBackfill';
