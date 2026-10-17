/**
 * Local adapter for lane arrival's `refreshArrivalProjection(ctx, threadId)`
 * (`mail/arrival/projection.ts`, SPEC §2.8).
 *
 * Lane senders landed before lane arrival, so the export does not exist on
 * this branch yet. Every sender-status change calls the projection through
 * this one function, so wiring it is a one-line change here: replace the body
 * with a call to the real export (or re-export it). Until then a status change
 * still writes every input the projection reads (profile status, folders), and
 * the next input change on each thread recomputes it.
 *
 * Isolate-safe; not a Convex function.
 */

import type { Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';

export async function refreshArrivalProjection(
	_ctx: MutationCtx,
	_threadId: Id<'mailThreads'>
): Promise<void> {}
