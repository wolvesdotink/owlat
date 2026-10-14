/**
 * The thread-level stale fence (#1320): a coarse "do not use this thread's AI
 * interpretation" marker on the mail thread.
 *
 * A re-verified signature verdict can narrow what one of a thread's messages
 * may be read for (a clearsigned scope: only the signed block). What the old
 * read took from the rest of that message is spread over the thread's items,
 * facts, "latest" lines, overview, plans and caches, and the reducer is
 * monotone, so no later read takes it back. Instead of reconciling row by row
 * (a follow-up), the whole thread's interpretation is fenced off in the
 * transaction that applies the narrower scope (`mailThreads.
 * interpretationStaleSince`), whatever the `ai` flag or the spend hold say.
 *
 * A fenced thread has no interpretation for every machine consumer: the brief
 * shows its items (the human state on them, never deleted) under a neutral
 * note and nothing the model derived; no new read runs; the model, reply
 * plans, team actions, the to-do list, "elsewhere", "Latest update", the list
 * projection and the needs-reply summary (and with it the Daily Brief) leave
 * it out. Each consumer reads {@link isInterpretationFenced} (or the field on
 * a thread it already holds) at its one shared entry point.
 *
 * There is no path that re-reads a thread from scratch while keeping what
 * people set on its items (order-aware transitions replaced the old rebuild,
 * `fold.ts`), so the fence stays until an operator lifts it with
 * {@link release}. Lifting it shows the interpretation as it stands, the
 * narrowed message's old contributions included.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import { internalQuery, type MutationCtx, type QueryCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { interpretationSourceValidator } from '../../lib/validators/threadBrief';

/** Is the thread's interpretation fenced off? Only mail threads can be. */
export async function isInterpretationFenced(
	ctx: Pick<QueryCtx, 'db'>,
	ref: ThreadRef
): Promise<boolean> {
	if (ref.kind !== 'mail') return false;
	return isFencedThread(await ctx.db.get(ref.id));
}

/** Is the thread of an interpretation source fenced off? For a run, before it reads anything. */
export const isSourceFenced = internalQuery({
	args: { source: interpretationSourceValidator },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const { source } = args;
		if (source.kind !== 'mail' && source.kind !== 'outboundMail') return false;
		const message = await ctx.db.get(source.id);
		return message ? isInterpretationFenced(ctx, { kind: 'mail', id: message.threadId }) : false;
	},
});

/** The same, for a thread row already loaded. */
export function isFencedThread(
	thread: Pick<Doc<'mailThreads'>, 'interpretationStaleSince'> | null
): boolean {
	return thread?.interpretationStaleSince !== undefined;
}

/** A needs-reply flag without the model's one-line summary of the ask. Pure. */
export function withoutAskSummary<T extends { askSummary?: string }>(
	flag: T
): Omit<T, 'askSummary'> {
	const { askSummary: _summary, ...rest } = flag;
	return rest;
}

/**
 * Fence the thread off, and drop the caches it carries that the model
 * derived: the list projection and the needs-reply summary. Idempotent.
 */
export async function fenceThreadInterpretation(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (!thread || isFencedThread(thread)) return;
	// The flag stays (it is the Reply Queue's own); only the model's summary goes.
	const needsReply = thread.needsReply ? { needsReply: withoutAskSummary(thread.needsReply) } : {};
	await ctx.db.patch(threadId, {
		interpretationStaleSince: Date.now(),
		briefTop: undefined,
		...needsReply,
	});
}

/**
 * OPERATOR: lift the fence of one thread, once its interpretation as it
 * stands may be used again (see the module doc). Nothing else changes; the
 * list projection fills in again with the thread's next interpretation write.
 *
 *   npx convex run mail/interpret/staleFence:release '{"threadId":"…"}'
 */
export const release = internalMutation({
	args: { threadId: v.id('mailThreads') },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread || !isFencedThread(thread)) return false;
		await ctx.db.patch(args.threadId, { interpretationStaleSince: undefined });
		return true;
	},
});
