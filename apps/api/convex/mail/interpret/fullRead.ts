/**
 * Read on arrival (Sol r1 F2): "display-settled" is not "fully read".
 *
 * A message read as a gist or only counted is settled for the reader and the
 * Priority view (`purgeRepairs.briefCompleteness` reads it as complete). A
 * consumer that reasons over the WHOLE thread needs every message read in
 * full: response plans and their coverage check, Answer mode and the Answer
 * queue's drafting, draft on arrival, clarification. It asks
 * {@link prepareFullRead} first:
 *
 *   - `ready`: the thread has no upgradeable source (`isUpgradeable`), so every
 *     message was read in full, or is a terminal exclusion (security mail, a
 *     suppressed sender), which nothing ever reads;
 *   - `preparing`: the NEWEST upgradeable source is scheduled for a full read
 *     as an upgrade (`interpretMessage({depth: 'full', isUpgrade: true})`).
 *     That run is leased and admitted like any other (`arrivalAdmit.ts`), and
 *     it reads every older upgradeable source first, oldest first, through
 *     the predecessor loop (`defer.ts`), in bounded steps. Each recorded
 *     outcome discharges its source (`outstanding.ts`), so the thread reaches
 *     `ready` and stays there. A run already holding the newest source's
 *     lease is not scheduled twice.
 *
 * While preparing, a consumer calls NO model (Sol r2 F1). The background ones
 * reschedule themselves ({@link FULL_READ_RECHECK_MS}, bounded by
 * {@link MAX_FULL_READ_WAITS}): draft on arrival, the Answer queue starter,
 * the classifier before clarification (the thread stays pending). The
 * interactive ones (Answer mode, the coverage check) wait a little for the
 * upgrade (`fullReadPrepare.ts awaitFullRead`), then answer `preparing`. The
 * plan they read (`responsePlanState.ts`) reports `partial` with
 * `isFullyRead: false` meanwhile. The needs-reply projection needs no call: its run
 * reads the thread's upgradeable mail first, and its own message too (an
 * eager run of a gisted source reads it in full, `arrivalDecide.ts`).
 */

import type { Id } from '../../_generated/dataModel';
import { internalQuery, type MutationCtx, type QueryCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { internalMutation } from '../../lib/writeFence';
import { threadRefValidator, type ThreadRef } from '../../lib/validators/threadRef';
import { answerAskTargetValidator } from '../../lib/validators/answerAsk';

export type FullReadState = 'ready' | 'preparing';

/** How soon a background consumer that found the thread preparing looks again. */
export const FULL_READ_RECHECK_MS = 30_000;
/** How often it looks again before it gives up (draft) or goes on without (clarification). */
export const MAX_FULL_READ_WAITS = 10;

function newestUpgradeable(ctx: Pick<QueryCtx, 'db'>, mailThreadId: Id<'mailThreads'>) {
	return ctx.db
		.query('interpretSources')
		.withIndex('by_mail_thread_upgradeable_order', (q) =>
			q.eq('mailThreadId', mailThreadId).eq('isUpgradeable', true)
		)
		.order('desc')
		.first();
}

/** Whether every message of the thread was read in full (team threads always are). One indexed read. */
export async function isThreadFullyRead(
	ctx: Pick<QueryCtx, 'db'>,
	ref: ThreadRef
): Promise<boolean> {
	if (ref.kind !== 'mail') return true;
	return (await newestUpgradeable(ctx, ref.id)) === null;
}

/** Schedule the thread's upgrade when it is not fully read (see the module doc). */
export async function prepareFullRead(ctx: MutationCtx, ref: ThreadRef): Promise<FullReadState> {
	if (ref.kind !== 'mail') return 'ready';
	const newest = await newestUpgradeable(ctx, ref.id);
	if (!newest) return 'ready';
	const isLeased =
		newest.leaseToken !== undefined &&
		newest.leaseUntil !== undefined &&
		newest.leaseUntil > Date.now();
	if (!isLeased && newest.source.kind === 'mail') {
		await ctx.scheduler.runAfter(0, internal.mail.interpret.run.interpretMessage, {
			source: newest.source,
			depth: 'full',
			isUpgrade: true,
		});
	}
	return 'preparing';
}

/** {@link prepareFullRead} for a consumer's action. */
export const prepareThread = internalMutation({
	args: { threadRef: threadRefValidator },
	handler: (ctx, args): Promise<FullReadState> => prepareFullRead(ctx, args.threadRef),
});

/** {@link prepareFullRead} for an Answer mode ask target (a Postbox draft's thread). */
export const prepareAskTarget = internalMutation({
	args: { target: answerAskTargetValidator },
	handler: async (ctx, args): Promise<FullReadState> => {
		if (args.target.kind !== 'mailDraft') return 'ready';
		const draft = await ctx.db.get(args.target.draftId);
		return draft?.threadId ? prepareFullRead(ctx, { kind: 'mail', id: draft.threadId }) : 'ready';
	},
});

/** Whether the thread is fully read now (the consumers' wait polls it). */
export const fullyRead = internalQuery({
	args: { threadRef: threadRefValidator },
	handler: (ctx, args): Promise<boolean> => isThreadFullyRead(ctx, args.threadRef),
});

/** The same for an Answer mode ask target (a team thread always is). */
export const askTargetFullyRead = internalQuery({
	args: { target: answerAskTargetValidator },
	handler: async (ctx, args): Promise<boolean> => {
		if (args.target.kind !== 'mailDraft') return true;
		const draft = await ctx.db.get(args.target.draftId);
		return draft?.threadId ? isThreadFullyRead(ctx, { kind: 'mail', id: draft.threadId }) : true;
	},
});
