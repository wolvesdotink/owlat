/**
 * `mailThreads.briefTop`: the brief folded down for the rows that list
 * threads (Postbox list, Answer queue, Workbench). See
 * `lib/validators/briefTop.ts` for the stored shape.
 *
 *  - `refreshBriefTop` rewrites the projection with O(1) reads: the counts are
 *    the thread's maintained `itemCounts` (`counters.ts`, exact, no cap), and
 *    the top item is the first row of the thread's `forUs` list in due order
 *    (dated first), else in asking order, else the same for
 *    `waitingOnOthers`. The reducer calls it after every interpretation
 *    (passing the new first "Latest update" line); every other item writer
 *    calls it with no `latest`, which keeps the stored one.
 *  - `openBriefTop` unseals it at the list-read boundary.
 *
 * Isolate-safe; not a Convex function.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { BriefTop } from '../../lib/validators/briefTop';
import type { ItemResponsibility, InterpretMode } from '@owlat/shared/threadBrief';
import { openMessageBody, sealBodyAtWrite } from '../../lib/messageBody';
import { itemCountsOf } from './counters';

type SealedPair = { en: string; de: string };

/** The lists a list row's top item can come from, in order. */
const TOP_BUCKETS = ['forUs', 'waitingOnOthers'] as const;
type TopBucket = (typeof TOP_BUCKETS)[number];

/**
 * The first item of one of a thread's lists: soonest due among dated items,
 * else the earliest asked. Two indexed `first()` reads at most.
 */
export async function firstOfBucket(
	ctx: Pick<QueryCtx, 'db'>,
	mailThreadId: Id<'mailThreads'>,
	bucket: TopBucket
): Promise<Doc<'threadItems'> | null> {
	const dated = await ctx.db
		.query('threadItems')
		.withIndex('by_mail_thread_bucket_due', (q) =>
			q.eq('mailThreadId', mailThreadId).eq('listBucket', bucket).gte('due.at', 0)
		)
		.first();
	if (dated) return dated;
	return ctx.db
		.query('threadItems')
		.withIndex('by_mail_thread_bucket_asked', (q) =>
			q.eq('mailThreadId', mailThreadId).eq('listBucket', bucket)
		)
		.first();
}

/**
 * Rewrite `mailThreads.briefTop` from the thread's counters and the first row
 * of its lists.
 *
 * `latest`: the first "Latest update" line in both locales (plaintext; sealed
 * here), `null` to clear it, or omitted to keep the stored one. Actions-mode
 * briefs never carry a latest line. A thread with no brief row is left alone.
 */
export async function refreshBriefTop(
	ctx: MutationCtx,
	mailThreadId: Id<'mailThreads'>,
	opts: { latest?: { en: string; de: string } | null } = {}
): Promise<void> {
	const thread = await ctx.db.get(mailThreadId);
	if (!thread) return;
	const brief = await ctx.db
		.query('threadBriefs')
		.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', mailThreadId))
		.unique();
	if (!brief) return;
	const counts = itemCountsOf(brief);
	let top: BriefTop['top'];
	for (const bucket of TOP_BUCKETS) {
		const count = bucket === 'forUs' ? counts.us : counts.them;
		if (count === 0) continue;
		const item = await firstOfBucket(ctx, mailThreadId, bucket);
		if (!item) continue;
		top = {
			itemId: item._id,
			bucket,
			responsibility: item.responsibility,
			text: item.display,
			...(item.due?.at !== undefined ? { dueAt: item.due.at } : {}),
		};
		break;
	}
	const mode: InterpretMode = brief.mode;
	const latest = await nextLatest(mode, thread.briefTop?.latest, opts.latest);
	const next: BriefTop = {
		mode,
		forYou: counts.us,
		waiting: counts.them,
		...(top ? { top } : {}),
		...(latest ? { latest } : {}),
		revision: brief.interpretationRevision,
		updatedAt: Date.now(),
	};
	await ctx.db.patch(mailThreadId, { briefTop: next });
}

async function nextLatest(
	mode: InterpretMode,
	stored: SealedPair | undefined,
	given: { en: string; de: string } | null | undefined
): Promise<SealedPair | undefined> {
	if (mode === 'actions' || given === null) return undefined;
	if (given === undefined) return stored;
	return { en: await sealBodyAtWrite(given.en), de: await sealBodyAtWrite(given.de) };
}

/** `briefTop` as list reads return it: unsealed, both locales (the client picks one). */
export type BriefTopRow = {
	mode: InterpretMode;
	forYou: number;
	waiting: number;
	top?: {
		itemId: Id<'threadItems'>;
		/** The list it heads: `waitingOnOthers` is what the row calls "waiting". */
		bucket?: 'forUs' | 'waitingOnOthers';
		responsibility: ItemResponsibility;
		text: { en: string; de: string };
		dueAt?: number;
	};
	latest?: { en: string; de: string };
	/** The thread is in the Answer queue (`needsReply` set): "for you", not "to do". */
	isReplyNeeded: boolean;
};

async function openPair(pair: SealedPair): Promise<{ en: string; de: string }> {
	const [en, de] = await Promise.all([openMessageBody(pair.en), openMessageBody(pair.de)]);
	return { en, de };
}

/** Unseal the projection for a list row; undefined when the thread has none. */
export async function openBriefTop(
	thread: Pick<Doc<'mailThreads'>, 'briefTop' | 'needsReply'>
): Promise<BriefTopRow | undefined> {
	const stored = thread.briefTop;
	if (!stored) return undefined;
	const [topText, latest] = await Promise.all([
		stored.top ? openPair(stored.top.text) : Promise.resolve(undefined),
		stored.latest ? openPair(stored.latest) : Promise.resolve(undefined),
	]);
	return {
		mode: stored.mode,
		forYou: stored.forYou,
		waiting: stored.waiting,
		...(stored.top && topText
			? {
					top: {
						itemId: stored.top.itemId,
						...(stored.top.bucket ? { bucket: stored.top.bucket } : {}),
						responsibility: stored.top.responsibility,
						text: topText,
						...(stored.top.dueAt !== undefined ? { dueAt: stored.top.dueAt } : {}),
					},
				}
			: {}),
		...(latest ? { latest } : {}),
		isReplyNeeded: thread.needsReply !== undefined,
	};
}
