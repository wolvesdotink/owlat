import { describe, it, expect } from 'vitest';
import {
	badgeCount,
	groupBody,
	newlyArrived,
	planNotifications,
	shouldNotify,
	trayPeekItems,
	NOTIFICATION_GROUP_WINDOW_MS,
	type ThreadWindowEntry,
	type UnreadPeekMessage,
} from '../notificationRules';
import type { PostboxMailCategory } from '~/utils/postboxNotify';

function msg(over: Partial<UnreadPeekMessage> & { messageId: string }): UnreadPeekMessage {
	return {
		threadId: 't1',
		fromAddress: 'a@b.com',
		fromName: 'Anna',
		subject: 'Hi',
		receivedAt: 1000,
		...over,
	};
}

describe('shouldNotify (category x setting matrix)', () => {
	const categories: Array<PostboxMailCategory | undefined> = [
		'person',
		'newsletter',
		'notification',
		'receipt',
		'other',
		undefined,
	];

	it("'nothing' never notifies, whatever the category", () => {
		for (const c of categories) expect(shouldNotify(c, 'nothing')).toBe(false);
	});

	it("'everything' always notifies, whatever the category", () => {
		for (const c of categories) expect(shouldNotify(c, 'everything')).toBe(true);
	});

	it("'people-important' notifies only for person (and un-classified mail)", () => {
		expect(shouldNotify('person', 'people-important')).toBe(true);
		// Absent category falls open so nothing is dropped before classification.
		expect(shouldNotify(undefined, 'people-important')).toBe(true);
		expect(shouldNotify('newsletter', 'people-important')).toBe(false);
		expect(shouldNotify('notification', 'people-important')).toBe(false);
		expect(shouldNotify('receipt', 'people-important')).toBe(false);
		expect(shouldNotify('other', 'people-important')).toBe(false);
	});
});

describe('badgeCount', () => {
	const messages = [
		msg({ messageId: 'a', category: 'person' }),
		msg({ messageId: 'b', category: 'newsletter' }),
		msg({ messageId: 'c', category: undefined }),
		msg({ messageId: 'd', category: 'receipt' }),
	];

	it('counts everything (the exact server total) when badgeNonPeople is on', () => {
		expect(badgeCount(42, messages, true)).toBe(42);
	});

	it('counts only person + un-classified mail when badgeNonPeople is off', () => {
		// person (a) + undefined (c) = 2
		expect(badgeCount(42, messages, false)).toBe(2);
	});

	it('never exceeds the server total', () => {
		expect(badgeCount(1, messages, false)).toBe(1);
	});
});

describe('newlyArrived', () => {
	it('returns only messages whose id is not in the seen set', () => {
		const seen = new Set(['a']);
		const out = newlyArrived([msg({ messageId: 'a' }), msg({ messageId: 'b' })], seen);
		expect(out.map((m) => m.messageId)).toEqual(['b']);
	});
});

describe('planNotifications grouping window', () => {
	const now = 10_000;
	const win = NOTIFICATION_GROUP_WINDOW_MS;

	it('emits a single notification for one new message in a fresh thread', () => {
		const { notifications } = planNotifications(
			[msg({ messageId: 'a', threadId: 't1' })],
			new Map(),
			now,
			win,
		);
		expect(notifications).toEqual([
			{ kind: 'single', message: expect.objectContaining({ messageId: 'a' }) },
		]);
	});

	it('collapses multiple new messages in one thread (same tick) into one group', () => {
		const { notifications } = planNotifications(
			[
				msg({ messageId: 'a', threadId: 't1', receivedAt: 1 }),
				msg({ messageId: 'b', threadId: 't1', receivedAt: 5, subject: 'Later' }),
				msg({ messageId: 'c', threadId: 't1', receivedAt: 3 }),
			],
			new Map(),
			now,
			win,
		);
		expect(notifications).toHaveLength(1);
		const n = notifications[0]!;
		expect(n.kind).toBe('group');
		if (n.kind === 'group') {
			expect(n.count).toBe(3);
			expect(n.threadId).toBe('t1');
			expect(n.sender).toBe('Anna');
			// The sample is the newest message in the thread.
			expect(n.sample.messageId).toBe('b');
		}
	});

	it('keeps distinct threads as separate notifications', () => {
		const { notifications } = planNotifications(
			[msg({ messageId: 'a', threadId: 't1' }), msg({ messageId: 'b', threadId: 't2' })],
			new Map(),
			now,
			win,
		);
		expect(notifications).toHaveLength(2);
	});

	it('cumulates a later arrival within the window into an updated group', () => {
		const first = planNotifications(
			[msg({ messageId: 'a', threadId: 't1' })],
			new Map(),
			now,
			win,
		);
		expect(first.notifications[0]!.kind).toBe('single');

		// A second message in the same thread 5s later — still within the window.
		const second = planNotifications(
			[msg({ messageId: 'b', threadId: 't1' })],
			first.threadWindows,
			now + 5_000,
			win,
		);
		const n = second.notifications[0]!;
		expect(n.kind).toBe('group');
		if (n.kind === 'group') expect(n.count).toBe(2);
	});

	it('starts a fresh count once the window has elapsed', () => {
		const first = planNotifications(
			[msg({ messageId: 'a', threadId: 't1' })],
			new Map(),
			now,
			win,
		);
		const later = planNotifications(
			[msg({ messageId: 'b', threadId: 't1' })],
			first.threadWindows,
			now + win + 1,
			win,
		);
		expect(later.notifications[0]!.kind).toBe('single');
		// Stale thread memory is pruned.
		expect(later.threadWindows.has('t1')).toBe(true); // re-created with count 1
		expect(later.threadWindows.get('t1')!.count).toBe(1);
	});

	it('prunes thread memory older than the window even for untouched threads', () => {
		const seed: Map<string, ThreadWindowEntry> = new Map([
			['old', { count: 3, sender: 'X', lastAt: 0 }],
		]);
		const { threadWindows } = planNotifications(
			[msg({ messageId: 'a', threadId: 't1' })],
			seed,
			win + 1, // well past the window relative to the entry at lastAt=0
			win,
		);
		expect(threadWindows.has('old')).toBe(false);
	});
});

describe('trayPeekItems', () => {
	it('maps up to `limit` newest unread to plain-text inbox rows', () => {
		const items = trayPeekItems(
			[
				msg({ messageId: 'a', fromName: 'Anna', subject: 'Lunch?' }),
				msg({ messageId: 'b', fromName: 'Bob', subject: 'Report' }),
			],
			5,
		);
		expect(items).toEqual([
			{ messageId: 'a', folderRole: 'inbox', title: 'Anna — Lunch?' },
			{ messageId: 'b', folderRole: 'inbox', title: 'Bob — Report' },
		]);
	});

	it('caps to the limit', () => {
		const many = Array.from({ length: 10 }, (_, i) => msg({ messageId: `m${i}` }));
		expect(trayPeekItems(many, 5)).toHaveLength(5);
	});

	it('truncates long sender/subject and falls back on empty subject', () => {
		const [item] = trayPeekItems(
			[msg({ messageId: 'a', fromName: 'x'.repeat(40), subject: '' })],
			5,
		);
		expect(item!.title.startsWith('x'.repeat(27))).toBe(true);
		expect(item!.title).toContain('(no subject)');
	});
});

describe('groupBody', () => {
	it('is plain text', () => {
		expect(groupBody(3, 'Anna')).toBe('3 new messages from Anna');
	});
});
