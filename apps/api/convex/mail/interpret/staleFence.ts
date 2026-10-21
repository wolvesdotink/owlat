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
import { internal } from '../../_generated/api';
import { internalMutation } from '../../lib/writeFence';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { interpretationSourceValidator } from '../../lib/validators/threadBrief';

/**
 * THE fence check: is this mail thread's interpretation fenced off? Every
 * machine consumer asks this (or {@link isFencedThread} for a thread row it
 * already holds, {@link isInterpretationFenced} for a thread reference).
 */
export async function isThreadInterpretationFenced(
	ctx: Pick<QueryCtx, 'db'>,
	threadId: Id<'mailThreads'>
): Promise<boolean> {
	return isFencedThread(await ctx.db.get(threadId));
}

/** The same, for a thread reference. Only mail threads can be fenced. */
export async function isInterpretationFenced(
	ctx: Pick<QueryCtx, 'db'>,
	ref: ThreadRef
): Promise<boolean> {
	return ref.kind === 'mail' && (await isThreadInterpretationFenced(ctx, ref.id));
}

/** Is the thread of an interpretation source fenced off? For a run, before it reads anything. */
export const isSourceFenced = internalQuery({
	args: { source: interpretationSourceValidator },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const { source } = args;
		if (source.kind !== 'mail' && source.kind !== 'outboundMail') return false;
		const message = await ctx.db.get(source.id);
		return message ? isThreadInterpretationFenced(ctx, message.threadId) : false;
	},
});

/** The same, for a thread row already loaded. */
export function isFencedThread(
	thread: Pick<Doc<'mailThreads'>, 'interpretationStaleSince'> | null
): boolean {
	return thread?.interpretationStaleSince !== undefined;
}

/**
 * A needs-reply flag without what the model derived from its read of the
 * thread: the summary of the ask, the deadline and meeting hints, the arrival
 * draft and the clarification's draft. The flag itself (urgency, trigger) and
 * the clarification's questions, answers and files, which are the person's,
 * stay. Pure.
 */
export function withoutInterpretationCache<
	T extends {
		askSummary?: string;
		dueHint?: string;
		meetingIntent?: unknown;
		draftSlot?: unknown;
		clarification?: { draft?: string } | undefined;
	},
>(flag: T): Omit<T, 'askSummary' | 'dueHint' | 'meetingIntent' | 'draftSlot'> {
	const { askSummary: _a, dueHint: _d, meetingIntent: _m, draftSlot: _s, ...rest } = flag;
	if (rest.clarification?.draft === undefined) return rest;
	const { draft: _draft, ...clarification } = rest.clarification;
	return { ...rest, clarification };
}

/**
 * A needs-reply result written while the thread is fenced: none of the model
 * fields, and no clarification (the questions were asked from the old
 * reading). Pure.
 */
export function withoutModelClarification<
	T extends Parameters<typeof withoutInterpretationCache>[0],
>(flag: T) {
	const { clarification: _asked, ...rest } = withoutInterpretationCache(flag);
	return rest;
}

/**
 * Fence the thread off, and drop the caches it carries that the model
 * derived: the list projection and the needs-reply flag's model fields
 * ({@link withoutInterpretationCache}). Idempotent.
 */
export async function fenceThreadInterpretation(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (!thread || isFencedThread(thread)) return;
	// The flag stays (it is the Reply Queue's own); only what the model derived goes.
	const needsReply = thread.needsReply
		? { needsReply: withoutInterpretationCache(thread.needsReply) }
		: {};
	await ctx.db.patch(threadId, {
		interpretationStaleSince: Date.now(),
		briefTop: undefined,
		...needsReply,
	});
}

/**
 * OPERATOR: lift the fence of one thread, once its interpretation as it
 * stands may be used again (see the module doc). Nothing else changes; the
 * list projection fills in again with the thread's next interpretation write,
 * and the arrival projection is recomputed right after.
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
		// The arrival projection reads the fence (a cold-pitch verdict, #1381):
		// re-place the thread. Scheduled, as the projection imports this module.
		await ctx.scheduler.runAfter(0, internal.mail.senders.resortChain.continueResort, {
			threadIds: [args.threadId],
		});
		return true;
	},
});
