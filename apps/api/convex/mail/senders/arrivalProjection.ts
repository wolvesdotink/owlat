/**
 * Local adapter for lane arrival's `refreshArrivalProjection(ctx, threadId)`
 * (`mail/arrival/projection.ts`, SPEC §2.8).
 *
 * Every sender-status change calls the projection through this one export,
 * which is lane arrival's `refreshArrivalProjection` (`mail/arrival/projection.ts`).
 *
 * Isolate-safe; not a Convex function.
 */

export { refreshArrivalProjection } from '../arrival/projection';
