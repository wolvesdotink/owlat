/**
 * The team stream's reads shared by both surfaces (`inbox/teamStream.ts` for
 * the agent Team Inbox, `mail/interpret/teamStream.ts` for shared mailboxes):
 * the activity system lines and the text of an item a row or a note names.
 *
 * No authorization here: the callers decide the viewer may read the thread
 * first. Isolate-safe helpers, no Convex functions.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import { isAppLocale, type AppLocale } from '@owlat/shared/appLocales';
import { openMessageBody } from '../../lib/messageBody';
import type { ThreadRef } from '../../lib/validators/threadRef';
import type { TeamStreamEntry } from './briefShape';
import { readViewerState, toActivityView } from './briefRead';
import {
	isStreamActivity,
	rangesBefore,
	readSourceBatch,
	type SourceBatch,
	type StreamPosition,
} from './teamStreamMerge';

type ReadCtx = Pick<QueryCtx, 'db'>;
type ActivityEntry = Extract<TeamStreamEntry, { kind: 'activity' }>;

/** Entries per page, and the most rows one source scans for a page. */
export const STREAM_PAGE_SIZE = 40;
export const STREAM_SCAN_BUDGET = 200;

/** The stream's locale from the UI's: `de-DE` → `de`, anything unknown → `en`. */
export function streamLocale(locale: string): AppLocale {
	const base = locale.trim().toLowerCase().split(/[-_]/)[0];
	return isAppLocale(base) ? base : 'en';
}

/**
 * Item texts for one page, opened once each. An item that is gone (purged)
 * or belongs to another thread reads as no text: the link is shown without it.
 */
export function itemTextReader(ctx: ReadCtx, ref: ThreadRef, locale: AppLocale) {
	const cache = new Map<string, Promise<string | undefined>>();
	async function read(itemId: Id<'threadItems'>): Promise<string | undefined> {
		const item = await ctx.db.get(itemId);
		if (!item) return undefined;
		const isSameThread =
			ref.kind === 'mail' ? item.mailThreadId === ref.id : item.conversationThreadId === ref.id;
		return isSameThread ? openMessageBody(item.display[locale]) : undefined;
	}
	return (itemId: Id<'threadItems'> | undefined): Promise<string | undefined> => {
		if (!itemId) return Promise.resolve(undefined);
		let text = cache.get(itemId);
		if (!text) {
			text = read(itemId);
			cache.set(itemId, text);
		}
		return text;
	};
}

export function activityPosition(
	row: Pick<Doc<'threadActivity'>, '_id' | '_creationTime' | 'eventAt'>
): StreamPosition {
	return { at: row.eventAt, tie: row._creationTime, key: `activity:${row._id}` };
}

/** The thread's activity system lines strictly before `before`, newest first. */
export async function readActivityBatch(
	ctx: ReadCtx,
	ref: ThreadRef,
	before: StreamPosition | null,
	itemText: (itemId: Id<'threadItems'> | undefined) => Promise<string | undefined>
): Promise<SourceBatch<ActivityEntry>> {
	const activity = ctx.db.query('threadActivity');
	const rows = rangesBefore(before, {
		all: () =>
			ref.kind === 'mail'
				? activity
						.withIndex('by_mail_thread_and_event', (q) => q.eq('mailThreadId', ref.id))
						.order('desc')
				: activity
						.withIndex('by_conversation_thread_and_event', (q) =>
							q.eq('conversationThreadId', ref.id)
						)
						.order('desc'),
		tied: (at, tie) =>
			ref.kind === 'mail'
				? activity
						.withIndex('by_mail_thread_and_event', (q) =>
							q.eq('mailThreadId', ref.id).eq('eventAt', at).lte('_creationTime', tie)
						)
						.order('desc')
				: activity
						.withIndex('by_conversation_thread_and_event', (q) =>
							q.eq('conversationThreadId', ref.id).eq('eventAt', at).lte('_creationTime', tie)
						)
						.order('desc'),
		older: (at) =>
			ref.kind === 'mail'
				? activity
						.withIndex('by_mail_thread_and_event', (q) =>
							q.eq('mailThreadId', ref.id).lt('eventAt', at)
						)
						.order('desc')
				: activity
						.withIndex('by_conversation_thread_and_event', (q) =>
							q.eq('conversationThreadId', ref.id).lt('eventAt', at)
						)
						.order('desc'),
	});
	return readSourceBatch(rows, {
		before,
		limit: STREAM_PAGE_SIZE,
		budget: STREAM_SCAN_BUDGET,
		positionOf: activityPosition,
		toEntries: async (row): Promise<ActivityEntry[]> => {
			if (!isStreamActivity(row)) return [];
			const text = await itemText(row.itemId);
			return [
				{
					kind: 'activity',
					...activityPosition(row),
					activity: await toActivityView(row),
					...(text !== undefined ? { itemText: text } : {}),
				},
			];
		},
	});
}

/** The viewer's saved place in the stream, for "new since you looked". */
export async function readSeenPosition(
	ctx: ReadCtx,
	ref: ThreadRef,
	userId: string
): Promise<{ at: number; key: string } | undefined> {
	return (await readViewerState(ctx, ref, userId))?.streamPosition;
}
