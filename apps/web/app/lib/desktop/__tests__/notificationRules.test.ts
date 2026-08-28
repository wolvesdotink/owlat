import { describe, it, expect } from 'vitest';
import {
	badgeCount,
	decideNotification,
	isWithinQuietHours,
	minutesUntilQuietHoursEnd,
	newlyArrived,
	notificationParts,
	planNotifications,
	shouldNotify,
	stepQuietHours,
	NOTIFICATION_GROUP_WINDOW_MS,
	QUIET_HOURS_INITIAL_STATE,
	type ThreadWindowEntry,
	type UnreadPeekMessage,
} from '../notificationRules';
import type { PostboxMailCategory } from '~/utils/postboxNotify';
import type { PostboxQuietHours } from '~/utils/postboxQuietHours';

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

	it('never notifies for a MUTED thread, whatever the scope says', () => {
		// Mute is an explicit per-conversation opt-out, so it outranks the
		// notification scope — including 'everything'.
		expect(shouldNotify('person', 'everything', true)).toBe(false);
		expect(shouldNotify(undefined, 'people-important', true)).toBe(false);
		expect(shouldNotify('person', 'everything', false)).toBe(true);
		// Omitting the argument is exactly the pre-mute behaviour.
		expect(shouldNotify('person', 'everything')).toBe(true);
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
			win
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
			win
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
			win
		);
		expect(notifications).toHaveLength(2);
	});

	it('cumulates a later arrival within the window into an updated group', () => {
		const first = planNotifications([msg({ messageId: 'a', threadId: 't1' })], new Map(), now, win);
		expect(first.notifications[0]!.kind).toBe('single');

		// A second message in the same thread 5s later — still within the window.
		const second = planNotifications(
			[msg({ messageId: 'b', threadId: 't1' })],
			first.threadWindows,
			now + 5_000,
			win
		);
		const n = second.notifications[0]!;
		expect(n.kind).toBe('group');
		if (n.kind === 'group') expect(n.count).toBe(2);
	});

	it('starts a fresh count once the window has elapsed', () => {
		const first = planNotifications([msg({ messageId: 'a', threadId: 't1' })], new Map(), now, win);
		const later = planNotifications(
			[msg({ messageId: 'b', threadId: 't1' })],
			first.threadWindows,
			now + win + 1,
			win
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
			win
		);
		expect(threadWindows.has('old')).toBe(false);
	});
});

describe('isWithinQuietHours', () => {
	const everyDay = [0, 1, 2, 3, 4, 5, 6];
	function hours(over: Partial<PostboxQuietHours> = {}): PostboxQuietHours {
		return { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60, days: everyDay, ...over };
	}
	/** Local-time instant on weekday `day` (0 = Sunday): 2026-08-23 IS a Sunday. */
	function at(day: number, hour: number, minute = 0): Date {
		return new Date(2026, 7, 23 + day, hour, minute);
	}

	it('is never quiet without a window, or with an inert one', () => {
		expect(isWithinQuietHours(undefined, at(3, 23))).toBe(false);
		expect(isWithinQuietHours(hours({ enabled: false }), at(3, 23))).toBe(false);
		expect(isWithinQuietHours(hours({ days: [] }), at(3, 23))).toBe(false);
		// A zero-length window would otherwise read as "quiet all day".
		expect(isWithinQuietHours(hours({ startMinute: 480, endMinute: 480 }), at(3, 8))).toBe(false);
	});

	it('covers a same-day window start-inclusive, end-exclusive', () => {
		const q = hours({ startMinute: 9 * 60, endMinute: 17 * 60 });
		expect(isWithinQuietHours(q, at(3, 8, 59))).toBe(false);
		expect(isWithinQuietHours(q, at(3, 9, 0))).toBe(true);
		expect(isWithinQuietHours(q, at(3, 16, 59))).toBe(true);
		expect(isWithinQuietHours(q, at(3, 17, 0))).toBe(false);
	});

	it('wraps past midnight, crediting the tail to the day the window STARTED', () => {
		// Quiet on Friday (5) only: Friday 22:00 through Saturday 07:00.
		const q = hours({ days: [5] });
		expect(isWithinQuietHours(q, at(5, 22, 0))).toBe(true);
		expect(isWithinQuietHours(q, at(5, 21, 59))).toBe(false);
		// Saturday's small hours still belong to Friday's window.
		expect(isWithinQuietHours(q, at(6, 2, 0))).toBe(true);
		expect(isWithinQuietHours(q, at(6, 7, 0))).toBe(false);
		// Saturday night is NOT quiet: Saturday is not in the mask.
		expect(isWithinQuietHours(q, at(6, 23, 0))).toBe(false);
	});

	it('reports the minutes left in the window, wrapping midnight', () => {
		const q = hours();
		expect(minutesUntilQuietHoursEnd(q, at(3, 23, 0))).toBe(8 * 60);
		expect(minutesUntilQuietHoursEnd(q, at(4, 6, 30))).toBe(30);
		// Outside the window there is nothing to wait for.
		expect(minutesUntilQuietHoursEnd(q, at(3, 12, 0))).toBeNull();
	});
});

describe('decideNotification precedence', () => {
	it('drops a muted thread even when it is armed for reply alerts', () => {
		expect(
			decideNotification({ category: 'person', setting: 'everything', muted: true, alerted: true })
		).toEqual({ fire: false, suppressed: 'muted' });
	});

	it('lets an armed thread pierce the people-only scope AND quiet hours', () => {
		expect(
			decideNotification({
				category: 'newsletter',
				setting: 'people-important',
				alerted: true,
				quiet: true,
			})
		).toEqual({ fire: true, suppressed: null });
		// Even 'nothing' — arming a thread is a per-conversation override.
		expect(decideNotification({ setting: 'nothing', alerted: true })).toEqual({
			fire: true,
			suppressed: null,
		});
	});

	it('reports the scope, not quiet hours, for out-of-scope mail inside the window', () => {
		// The distinction matters: only quiet-hours suppressions are summarized.
		expect(
			decideNotification({ category: 'receipt', setting: 'people-important', quiet: true })
		).toEqual({ fire: false, suppressed: 'scope' });
	});

	it('defers in-scope mail while the window is open', () => {
		expect(decideNotification({ category: 'person', setting: 'everything', quiet: true })).toEqual({
			fire: false,
			suppressed: 'quiet-hours',
		});
	});

	it('fires ordinary in-scope mail outside the window', () => {
		expect(decideNotification({ category: 'person', setting: 'people-important' })).toEqual({
			fire: true,
			suppressed: null,
		});
	});
});

describe('stepQuietHours', () => {
	it('accumulates while the window is open and stays silent', () => {
		const first = stepQuietHours(QUIET_HOURS_INITIAL_STATE, { quiet: true, suppressed: 3 });
		expect(first).toEqual({ state: { quiet: true, deferred: 3 }, summaryCount: 0 });
		const second = stepQuietHours(first.state, { quiet: true, suppressed: 2 });
		expect(second).toEqual({ state: { quiet: true, deferred: 5 }, summaryCount: 0 });
	});

	it('rolls the whole backlog into ONE summary when the window closes, then resets', () => {
		const open = stepQuietHours(QUIET_HOURS_INITIAL_STATE, { quiet: true, suppressed: 12 });
		const closed = stepQuietHours(open.state, { quiet: false, suppressed: 0 });
		expect(closed.summaryCount).toBe(12);
		expect(closed.state).toEqual({ quiet: false, deferred: 0 });
		// The next tick must not summarize the same backlog again.
		expect(stepQuietHours(closed.state, { quiet: false, suppressed: 0 }).summaryCount).toBe(0);
	});

	it('summarizes nothing when the window closed with nothing suppressed', () => {
		const open = stepQuietHours(QUIET_HOURS_INITIAL_STATE, { quiet: true, suppressed: 0 });
		expect(stepQuietHours(open.state, { quiet: false, suppressed: 0 }).summaryCount).toBe(0);
	});
});

describe('notificationParts', () => {
	const single = { kind: 'single', message: msg({ messageId: 'a' }) } as const;

	it('carries the sender and subject as LITERAL text, not catalog keys', () => {
		const parts = notificationParts(single);
		expect(parts).toEqual({
			title: { text: 'Anna' },
			body: { text: 'Hi' },
			messageId: 'a',
		});
	});

	it('falls back to the no-subject key for a subject-less message', () => {
		const parts = notificationParts({
			kind: 'single',
			message: msg({ messageId: 'a', subject: '' }),
		});
		expect(parts.body).toEqual({ key: 'shared.useDesktopNotifications.noSubject' });
	});

	it('leaks neither sender nor subject when previews are hidden', () => {
		const parts = notificationParts(single, true);
		expect(parts).toEqual({
			title: { key: 'shared.useDesktopNotifications.newMail' },
			body: { key: 'shared.useDesktopNotifications.hiddenPreview.single' },
			messageId: 'a',
		});
	});

	it('drops the sender from a group body when previews are hidden', () => {
		const group = {
			kind: 'group',
			threadId: 't1',
			sender: 'Anna',
			count: 3,
			sample: msg({ messageId: 'b' }),
		} as const;
		expect(notificationParts(group).body).toEqual({
			key: 'shared.useDesktopNotifications.groupBody',
			params: { count: 3, sender: 'Anna' },
		});
		expect(notificationParts(group, true).body).toEqual({
			key: 'shared.useDesktopNotifications.hiddenPreview.group',
			params: { count: 3 },
		});
	});

	it('sends the quiet-hours summary without a message to act on', () => {
		const parts = notificationParts({ kind: 'quiet-summary', count: 12 });
		expect(parts).toEqual({
			title: { key: 'shared.useDesktopNotifications.quietSummary.title' },
			body: { key: 'shared.useDesktopNotifications.quietSummary.body', params: { count: 12 } },
		});
		expect(parts.messageId).toBeUndefined();
	});
});
