/**
 * The Priority view's groups (SPEC §3, plan §6 "The inbox"). Pure, so the
 * grouping and the one-line rows are unit-testable without the view.
 *
 * Rows group by their thread's placement (`row.placement`: the thread's
 * placement override, else its arrival projection, attached server-side):
 *
 *   needsMe   `needs_me`, unless the Reply Queue already lists the thread
 *             (the queue's row stands for it)
 *   today     `today`, headed "Everything else" (the Categories view's word)
 *   updates   `updates`: the view shows three, then folds the rest
 *   digest    `digest`: a count and a link to All mail filtered to the digest
 *
 * The feed lists messages; each conversation counts once, by its newest row.
 * Every explicit placement groups at any age: it says what a thread needs, not
 * when it came. Only threads without an arrival projection keep the legacy
 * grouping: the Today window (received since local midnight, or unread from
 * yesterday) with auto-filed categories rolled up, and older mail behind "Show
 * past mails". A thread the Reply Queue lists shows once, as the queue's row,
 * and nowhere else.
 */
import type { InjectionKey, Ref } from 'vue';
import type { Placement } from '@owlat/shared/arrival';
import type { BriefTopRow } from '../../../api/convex/mail/interpret/briefTop';
import { briefRowLatest } from '~/utils/briefRowLine';
import { rowGistOf } from '~/utils/postboxReaderStrip';
import { briefDueDate } from '~/utils/threadBriefContext';
import {
	partitionTodayMessages,
	type PostboxAutoFiledCategory,
	type PostboxTodayPartitionMessage,
} from '~/utils/postboxTodayPartition';

export type PriorityGroup = 'needsMe' | 'today' | 'updates' | 'digest';

/**
 * Provided by the Priority view: the thread rows under it render as one line
 * (PostboxThreadRowBody), keeping the shared list's hover triage and keys.
 */
export const POSTBOX_PRIORITY_ROWS: InjectionKey<boolean> = Symbol('postboxPriorityRows');

/**
 * Provided by the Priority view: the viewer's "Show the brief above
 * conversations" (`isAutoSummarizeOn`). Off, a row's line is its subject, never
 * the AI's lead, ask or gist. Not provided reads as on.
 */
export const POSTBOX_PRIORITY_BRIEF_LINES: InjectionKey<Readonly<Ref<boolean>>> = Symbol(
	'postboxPriorityBriefLines'
);

/** The group a row's placement puts it in; no placement reads as `today`. */
export function priorityGroupOf(placement: Placement | undefined): PriorityGroup {
	if (placement === 'needs_me') return 'needsMe';
	if (placement === 'updates' || placement === 'digest') return placement;
	return 'today';
}

export interface PriorityRow extends PostboxTodayPartitionMessage {
	placement?: Placement;
}

export interface PriorityGroups<T> {
	needsMe: T[];
	today: T[];
	updates: T[];
	digest: T[];
	/** Placement-less rows of an auto-filed category, for the old roll-up line. */
	autoFiled: T[];
	autoFiledCounts: Partial<Record<PostboxAutoFiledCategory, number>>;
	older: T[];
}

/** Where each placement groups, at any age (`archived` is past mail). */
const GROUP_OF: Partial<Record<Placement, PriorityGroup>> = {
	needs_me: 'needsMe',
	today: 'today',
	updates: 'updates',
	digest: 'digest',
};

/**
 * One row per conversation: the feed lists messages, newest first, so the
 * first row of a thread is its newest. Rows without a thread stand alone.
 */
function newestPerThread<T extends PriorityRow>(rows: readonly T[]): T[] {
	const seen = new Set<string>();
	return rows.filter((row) => {
		if (row.threadId === undefined) return true;
		if (seen.has(row.threadId)) return false;
		seen.add(row.threadId);
		return true;
	});
}

export function groupPriorityRows<T extends PriorityRow>(
	rows: readonly T[],
	opts: { now: Date; queuedThreadIds?: ReadonlySet<string> }
): PriorityGroups<T> {
	const queued = opts.queuedThreadIds ?? new Set<string>();
	// The Reply Queue's row stands for its thread: it shows nowhere else.
	const threads = newestPerThread(rows).filter(
		(row) => row.threadId === undefined || !queued.has(row.threadId)
	);
	// Only threads without an arrival projection keep the legacy grouping: the
	// Today window and the category roll-up. A placement groups at any age.
	const split = partitionTodayMessages(
		threads.filter((row) => !row.placement),
		{ now: opts.now }
	);
	const autoFiled = new Set(split.autoFiled);
	const inWindow = new Set([...split.today, ...split.autoFiled]);
	const groups: PriorityGroups<T> = {
		needsMe: [],
		today: [],
		updates: [],
		digest: [],
		autoFiled: [],
		autoFiledCounts: {},
		older: [],
	};
	// Walk the feed's own order (newest first).
	for (const row of threads) {
		const group = row.placement ? GROUP_OF[row.placement] : undefined;
		if (group) groups[group].push(row);
		else if (row.placement === 'archived' || !inWindow.has(row)) groups.older.push(row);
		else if (autoFiled.has(row)) {
			groups.autoFiled.push(row);
			const category = row.category as PostboxAutoFiledCategory;
			groups.autoFiledCounts[category] = (groups.autoFiledCounts[category] ?? 0) + 1;
		} else groups.today.push(row);
	}
	return groups;
}

/** The fields a one-line row reads. */
export interface PriorityLineRow {
	subject: string;
	receivedAt: number;
	briefTop?: BriefTopRow;
}

export type PriorityRowState =
	| { kind: 'due'; date: string }
	| { kind: 'reply' }
	| { kind: 'waiting' }
	| { kind: 'time' };

export interface PriorityRowLine {
	text: string;
	/** Where the text came from; `subject` is the plain fallback. */
	source: 'ask' | 'lead' | 'gist' | 'subject';
	state: PriorityRowState;
}

/**
 * One line per thread: the brief's lead or ask (the ask first in "Needs you"),
 * else the gist, else the subject; and one state: a due date, "reply",
 * "waiting" or the time. With `showBrief: false` (the viewer turned the brief
 * off) the line is always the subject; the state stays.
 */
export function priorityRowLine(
	row: PriorityLineRow,
	group: PriorityGroup,
	locale: string,
	opts: { now?: number; showBrief?: boolean } = {}
): PriorityRowLine {
	const now = opts.now ?? Date.now();
	const top = row.briefTop?.top;
	const askText = top
		? (locale.toLowerCase().startsWith('de') ? top.text.de : top.text.en).trim()
		: '';
	const isWaiting = top?.bucket ? top.bucket === 'waitingOnOthers' : top?.responsibility === 'them';
	const ask = askText ? { text: askText, source: 'ask' as const } : null;
	const leadText = briefRowLatest(row.briefTop, locale);
	const lead = leadText ? { text: leadText, source: 'lead' as const } : null;
	const gistText = rowGistOf(row.briefTop);
	const gist = gistText ? { text: gistText, source: 'gist' as const } : null;
	const subject = { text: row.subject.trim(), source: 'subject' as const };
	const picked =
		opts.showBrief === false
			? subject
			: ((group === 'needsMe' ? (ask ?? lead) : (lead ?? ask)) ?? gist ?? subject);

	let state: PriorityRowState = { kind: 'time' };
	if (top?.dueAt !== undefined && !isWaiting) {
		state = { kind: 'due', date: briefDueDate(top.dueAt, locale, now) };
	} else if (row.briefTop?.isReplyNeeded || group === 'needsMe') state = { kind: 'reply' };
	else if (top && isWaiting) state = { kind: 'waiting' };
	return { text: picked.text, source: picked.source, state };
}

/** The Updates fold's sentence: "9 more updates from GitHub, Hetzner and 4 others". */
export interface FoldLine {
	key: string;
	params: Record<string, string | number>;
	count: number;
}

export function updatesFoldLine(
	hidden: readonly { fromName?: string; fromAddress: string }[]
): FoldLine | null {
	const count = hidden.length;
	if (count === 0) return null;
	const names: string[] = [];
	for (const row of hidden) {
		const name = row.fromName?.trim() || row.fromAddress;
		if (!names.includes(name)) names.push(name);
	}
	const [a = '', b = ''] = names;
	const others = names.length - 2;
	if (names.length === 1)
		return { key: 'postbox.priority.updates.foldOne', params: { count, a }, count };
	if (names.length === 2)
		return { key: 'postbox.priority.updates.foldTwo', params: { count, a, b }, count };
	return {
		key:
			others === 1
				? 'postbox.priority.updates.foldOneOther'
				: 'postbox.priority.updates.foldOthers',
		params: { count, a, b, others },
		count,
	};
}
