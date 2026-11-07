import { describe, expect, it } from 'vitest';
import type { AnswerItem } from '~/composables/useAnswerQueue';
import type { TaskView } from '~/types/tasks';
import { buildWorkCards, idBatches, taskInScope, type WorkTodoRow } from '../workbenchWork';

const NOW = new Date(2026, 10, 7, 10, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function reply(id: string, threadId: string, at = NOW): AnswerItem {
	return {
		id,
		source: 'mail',
		at,
		mailboxId: 'mb1',
		inbox: null,
		row: { threadId, messageId: `m-${id}` },
	} as unknown as AnswerItem;
}

function todo(threadId: string, extra: Partial<WorkTodoRow> = {}): WorkTodoRow {
	return {
		threadId,
		itemId: `i-${threadId}`,
		text: { en: 'Pay the invoice', de: 'Rechnung zahlen' },
		count: 1,
		fromAddress: 'ben@acmecorp.example',
		subject: 'Invoice',
		lastMessageAt: NOW - DAY,
		mailboxId: 'mb1',
		...extra,
	};
}

function task(id: string, extra: Partial<TaskView> = {}): TaskView {
	return {
		_id: id,
		title: id,
		dueAt: null,
		createdAt: NOW - DAY,
		source: null,
		...extra,
	} as unknown as TaskView;
}

const mailSource = (threadId: string, mailboxId = 'mb1') =>
	({ kind: 'mail', mailThreadId: threadId, mailboxId, canOpen: true, subject: null }) as const;

describe('buildWorkCards', () => {
	it('keeps the Answer queue order, then requests, then tasks', () => {
		const cards = buildWorkCards({
			answer: [reply('a', 't1'), reply('b', 't2')],
			todo: [todo('t3')],
			tasks: [task('x')],
			answerDueAt: () => null,
			now: NOW,
		});
		expect(cards.map((c) => c.key)).toEqual(['reply:a', 'reply:b', 'ask:t3', 'task:x']);
	});

	it('rides a task on the card of the conversation it came from', () => {
		const cards = buildWorkCards({
			answer: [reply('a', 't1')],
			todo: [],
			tasks: [task('x', { source: mailSource('t1') as never }), task('y')],
			answerDueAt: () => null,
			now: NOW,
		});
		expect(cards.map((c) => c.key)).toEqual(['reply:a', 'task:y']);
		expect(cards[0]!.tasks.map((t) => t._id)).toEqual(['x']);
	});

	it('shows a conversation once when it is both a reply and a request', () => {
		const cards = buildWorkCards({
			answer: [reply('a', 't1')],
			todo: [todo('t1')],
			tasks: [],
			answerDueAt: () => null,
			now: NOW,
		});
		expect(cards.map((c) => c.key)).toEqual(['reply:a']);
	});

	it('puts overdue and due-today work first, soonest first, whatever its kind', () => {
		const cards = buildWorkCards({
			answer: [reply('a', 't1')],
			todo: [todo('t2', { dueAt: NOW - DAY })],
			tasks: [task('x', { dueAt: NOW + 60_000 }), task('later', { dueAt: NOW + 5 * DAY })],
			answerDueAt: () => null,
			now: NOW,
		});
		expect(cards.map((c) => c.key)).toEqual(['ask:t2', 'task:x', 'reply:a', 'task:later']);
	});

	it('lets a pressing task pull its conversation forward', () => {
		const cards = buildWorkCards({
			answer: [reply('a', 't1'), reply('b', 't2')],
			todo: [],
			tasks: [task('x', { dueAt: NOW - DAY, source: mailSource('t2') as never })],
			answerDueAt: () => null,
			now: NOW,
		});
		expect(cards.map((c) => c.key)).toEqual(['reply:b', 'reply:a']);
		expect(cards[0]!.dueAt).toBe(NOW - DAY);
	});
});

describe('taskInScope', () => {
	it('shows every task under All, and a tab only the tasks from its inbox', () => {
		const handMade = task('h');
		const fromMb1 = task('m', { source: mailSource('t1', 'mb1') as never });
		expect(taskInScope(handMade, 'all', 'all', 'team')).toBe(true);
		expect(taskInScope(handMade, 'mb1', 'all', 'team')).toBe(false);
		expect(taskInScope(fromMb1, 'mb1', 'all', 'team')).toBe(true);
		expect(taskInScope(fromMb1, 'mb2', 'all', 'team')).toBe(false);
		expect(taskInScope(fromMb1, 'team', 'all', 'team')).toBe(false);
	});

	it('shows every task, hand-made ones too, when the tab is the only one there is', () => {
		const handMade = task('h');
		const fromMb2 = task('m', { source: mailSource('t1', 'mb2') as never });
		expect(taskInScope(handMade, 'mb1', 'all', 'team', { isOnlyTab: true })).toBe(true);
		expect(taskInScope(fromMb2, 'mb1', 'all', 'team', { isOnlyTab: true })).toBe(true);
	});
});

describe('idBatches', () => {
	it('splits distinct ids into groups no larger than the read takes', () => {
		const ids = Array.from({ length: 11 }, (_, i) => `t${i}`);
		const batches = idBatches([...ids, 't0'], 10);
		expect(batches).toHaveLength(2);
		expect(batches[0]!.split(',')).toHaveLength(10);
		expect(batches[1]).toBe('t10');
		expect(idBatches([], 10)).toEqual([]);
	});
});
