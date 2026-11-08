import type { AnswerItem } from '~/composables/useAnswerQueue';
import type { TaskView } from '~/types/tasks';
import { taskDueBucket } from '~/utils/taskBuckets';

/**
 * The Workbench's "What needs you": one list of the work waiting on the
 * viewer, whatever it came in as. Pure, so the order and the grouping are
 * tested on their own.
 *
 * Three sources feed it:
 *   - a reply the Answer queue holds (mail, the team inbox, a chat mention);
 *   - a request from a conversation that needs no reply (the brief's open
 *     items, mail/interpret/todo.ts);
 *   - a task assigned to the viewer.
 *
 * A task taken from a conversation that is already on the list rides along
 * on that conversation's card instead of standing on its own: the person
 * sees the conversation once, with the work they took on from it. It is not
 * assumed to be the same obligation, so it keeps its own checkbox.
 */

export type WorkCardKind = 'reply' | 'ask' | 'task';

/** One row of `mail.interpret.todo.listNoReplyToDo`, with the mailbox it came from. */
export interface WorkTodoRow {
	threadId: string;
	messageId?: string | null;
	itemId: string;
	text: { en: string; de: string };
	dueAt?: number;
	count: number;
	fromAddress: string;
	fromName?: string;
	subject: string;
	lastMessageAt: number;
	mailboxId: string;
}

export interface WorkCard {
	key: string;
	kind: WorkCardKind;
	/** When it arrived or was added; newest first within a kind. */
	at: number;
	/** The card's own due date, or the soonest of the tasks riding on it. */
	dueAt: number | null;
	threadId: string | null;
	answer?: AnswerItem;
	todo?: WorkTodoRow;
	task?: TaskView;
	/** Tasks taken from this card's conversation. */
	tasks: TaskView[];
}

export function answerThreadId(item: AnswerItem): string | null {
	if (item.source === 'mail') return item.row.threadId;
	if (item.source === 'team') return item.entry.thread?._id ?? null;
	return null;
}

export function taskThreadId(task: TaskView): string | null {
	if (!task.source) return null;
	return task.source.kind === 'mail' ? task.source.mailThreadId : task.source.conversationThreadId;
}

function soonest(...dates: (number | null | undefined)[]): number | null {
	const known = dates.filter((d): d is number => typeof d === 'number');
	return known.length > 0 ? Math.min(...known) : null;
}

/** Overdue and due-today work leads, whatever kind it is. */
function isPressing(card: WorkCard, now: number): boolean {
	if (card.dueAt === null) return false;
	const bucket = taskDueBucket(card.dueAt, now);
	return bucket === 'overdue' || bucket === 'today';
}

const KIND_ORDER: Record<WorkCardKind, number> = { reply: 0, ask: 1, task: 2 };

export function buildWorkCards(input: {
	/** The Answer queue, already ranked; its order is kept. */
	answer: readonly AnswerItem[];
	todo: readonly WorkTodoRow[];
	tasks: readonly TaskView[];
	/** A reply's due date where the brief knows one. */
	answerDueAt: (item: AnswerItem) => number | null;
	now: number;
}): WorkCard[] {
	const byThread = new Map<string, WorkCard>();
	const cards: WorkCard[] = [];

	for (const item of input.answer) {
		const threadId = answerThreadId(item);
		const card: WorkCard = {
			key: `reply:${item.id}`,
			kind: 'reply',
			at: item.at,
			dueAt: input.answerDueAt(item),
			threadId,
			answer: item,
			tasks: [],
		};
		cards.push(card);
		if (threadId) byThread.set(threadId, card);
	}

	for (const row of input.todo) {
		// The Answer queue already holds this conversation; one card is enough.
		if (byThread.has(row.threadId)) continue;
		const card: WorkCard = {
			key: `ask:${row.threadId}`,
			kind: 'ask',
			at: row.lastMessageAt,
			dueAt: row.dueAt ?? null,
			threadId: row.threadId,
			todo: row,
			tasks: [],
		};
		cards.push(card);
		byThread.set(row.threadId, card);
	}

	for (const task of input.tasks) {
		const threadId = taskThreadId(task);
		const host = threadId ? byThread.get(threadId) : undefined;
		if (host) {
			host.tasks.push(task);
			host.dueAt = soonest(host.dueAt, task.dueAt);
			continue;
		}
		cards.push({
			key: `task:${task._id}`,
			kind: 'task',
			at: task.createdAt,
			dueAt: task.dueAt,
			threadId,
			task,
			tasks: [],
		});
	}

	const rank = new Map(cards.map((card, index) => [card.key, index]));
	return cards.sort((a, b) => {
		const pa = isPressing(a, input.now);
		const pb = isPressing(b, input.now);
		if (pa !== pb) return pa ? -1 : 1;
		if (pa && pb) return a.dueAt! - b.dueAt!;
		if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
		// The Answer queue's own ranking.
		if (a.kind === 'reply') return rank.get(a.key)! - rank.get(b.key)!;
		if (a.kind === 'task') {
			const ad = a.dueAt ?? Number.POSITIVE_INFINITY;
			const bd = b.dueAt ?? Number.POSITIVE_INFINITY;
			if (ad !== bd) return ad - bd;
		}
		return b.at - a.at;
	});
}

/**
 * A task belongs to a Workbench tab when it came from that inbox; hand-made
 * ones show under All. When the tab is the only one (a single inbox, so no
 * All), it shows every task: a task must never be left without a tab.
 */
export function taskInScope(
	task: TaskView,
	scope: string,
	allScope: string,
	teamScope: string,
	options: { isOnlyTab?: boolean } = {}
): boolean {
	if (scope === allScope || options.isOnlyTab) return true;
	if (!task.source) return false;
	if (scope === teamScope) return task.source.kind === 'team';
	return task.source.kind === 'mail' && task.source.mailboxId === scope;
}

/**
 * Distinct ids in groups of at most `size`, each joined with commas, for a
 * read that takes a bounded list (one subscription per group).
 */
export function idBatches(ids: readonly string[], size: number): string[] {
	const distinct = [...new Set(ids)];
	const batches: string[] = [];
	for (let i = 0; i < distinct.length; i += size) {
		batches.push(distinct.slice(i, i + size).join(','));
	}
	return batches;
}
