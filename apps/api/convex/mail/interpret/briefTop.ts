/**
 * `mailThreads.briefTop`: the brief folded down for the rows that list
 * threads (Postbox list, Answer queue, Workbench). See
 * `lib/validators/briefTop.ts` for the stored shape.
 *
 *  - `deriveBriefTop` is the pure fold: counts plus the first item by
 *    `compareForYou` (a for-you item when one is open, else a waiting one).
 *    Unconfirmed proposals ("Check this") are not counted: they are not
 *    tracked until someone confirms them.
 *  - `refreshBriefTop` rewrites the projection from the thread's open items.
 *    The reducer calls it after every interpretation (passing the new first
 *    "Latest update" line), and every reaction that moves an item calls it
 *    with no `latest`, which keeps the stored one.
 *  - `openBriefTop` unseals it at the list-read boundary.
 *
 * Isolate-safe; not a Convex function.
 */

import { compareForYou } from '@owlat/shared/threadBriefRules';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { BriefTop } from '../../lib/validators/briefTop';
import type { ItemResponsibility, InterpretMode } from '@owlat/shared/threadBrief';
import { openMessageBody, sealBodyAtWrite } from '../../lib/messageBody';

type SealedPair = { en: string; de: string };

/** The item fields the fold reads. */
export type BriefTopItem = Pick<
	Doc<'threadItems'>,
	'_id' | 'responsibility' | 'status' | 'verify' | 'due' | 'facets' | 'askedAt' | 'display'
>;

/** Counts and the top item, before the brief's mode, latest line and stamps are added. */
export type BriefTopFold = Pick<BriefTop, 'forYou' | 'waiting' | 'top'>;

function isTracked(item: BriefTopItem): boolean {
	return item.status === 'open' && item.verify !== 'proposal';
}

function sortable(item: BriefTopItem) {
	return { due: item.due, facets: item.facets, askedAt: item.askedAt, id: item._id };
}

/** Fold a thread's items into the row projection. Pure. */
export function deriveBriefTop(items: readonly BriefTopItem[]): BriefTopFold {
	const tracked = items.filter(isTracked);
	const forYou = tracked.filter((i) => i.responsibility !== 'them');
	const waiting = tracked.filter((i) => i.responsibility === 'them');
	const pick = (list: BriefTopItem[]) =>
		[...list].sort((a, b) => compareForYou(sortable(a), sortable(b)))[0];
	const first = pick(forYou) ?? pick(waiting);
	return {
		forYou: forYou.length,
		waiting: waiting.length,
		...(first
			? {
					top: {
						itemId: first._id,
						responsibility: first.responsibility,
						text: first.display,
						...(first.due?.at !== undefined ? { dueAt: first.due.at } : {}),
					},
				}
			: {}),
	};
}

/** Every open item a brief lists is bounded by the reducer's prompt budget; read a little past it. */
const OPEN_ITEM_READ_LIMIT = 100;

/**
 * Rewrite `mailThreads.briefTop` from the thread's open items.
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
	const items = await ctx.db
		.query('threadItems')
		.withIndex('by_mail_thread_and_status', (q) =>
			q.eq('mailThreadId', mailThreadId).eq('status', 'open')
		)
		.take(OPEN_ITEM_READ_LIMIT);
	const mode: InterpretMode = brief.mode;
	const latest = await nextLatest(mode, thread.briefTop?.latest, opts.latest);
	const next: BriefTop = {
		mode,
		...deriveBriefTop(items),
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
		responsibility: ItemResponsibility;
		text: { en: string; de: string };
		dueAt?: number;
	};
	latest?: { en: string; de: string };
};

async function openPair(pair: SealedPair): Promise<{ en: string; de: string }> {
	const [en, de] = await Promise.all([openMessageBody(pair.en), openMessageBody(pair.de)]);
	return { en, de };
}

/** Unseal the projection for a list row; undefined when the thread has none. */
export async function openBriefTop(stored: BriefTop | undefined): Promise<BriefTopRow | undefined> {
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
						responsibility: stored.top.responsibility,
						text: topText,
						...(stored.top.dueAt !== undefined ? { dueAt: stored.top.dueAt } : {}),
					},
				}
			: {}),
		...(latest ? { latest } : {}),
	};
}
