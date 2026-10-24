/**
 * Read on arrival: the dispatch of a delivered message that is
 * no Reply Queue candidate. There is no new ladder: the interpretation run is
 * the coordinator, and it decides how deep to read once it has the message
 * (`interpret/arrivalDecide.ts`).
 *
 *   - Read on arrival OFF (or not a personal mailbox): screen-only work waits for the screen.
 *     A display-only source is deferred until the thread is opened
 *     (`interpret/defer.ts deferIfDisplayOnly`).
 *   - Otherwise the source is read now: its run picks full, gist, count or
 *     none (`@owlat/shared/arrivalDepth`).
 *
 * Called where `interpret/enqueue.ts` and `mail/ai/needsReplyClassify.ts`
 * decide a non-candidate today.
 *
 * Isolate-safe; not a Convex function.
 */

import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { deferIfDisplayOnly } from '../interpret/defer';

export type ArrivalDispatch = 'deferred' | 'read';

/** Defer it (the preference off) or read it now (see the module doc). */
export async function arrivalDispatchOf(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>
): Promise<ArrivalDispatch> {
	return (await deferIfDisplayOnly(ctx, message)) ? 'deferred' : 'read';
}

/** {@link arrivalDispatchOf}, and the run scheduled when it is read now. */
export async function scheduleArrivalRead(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>
): Promise<ArrivalDispatch> {
	const dispatch = await arrivalDispatchOf(ctx, message);
	if (dispatch === 'read') {
		await ctx.scheduler.runAfter(0, internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: message._id },
		});
	}
	return dispatch;
}
