/**
 * Today-view partition (utils/postboxTodayPartition):
 *   - local-midnight boundary (timezone-aware via local Date math)
 *   - unread-from-yesterday inclusion (read yesterday mail goes to older)
 *   - auto-filed smart-inbox categories never render as Today rows
 *   - roll-up line grammar.
 */
import { describe, it, expect } from 'vitest';
import {
	partitionTodayMessages,
	formatAutoFiledLine,
	startOfLocalDay,
	startOfPreviousLocalDay,
} from '../postboxTodayPartition';

// A fixed LOCAL wall-clock "now": 2026-07-06 09:30 in whatever timezone the
// test runs in — the util's contract is local midnights, so the fixtures are
// built with the same local Date math.
const NOW = new Date(2026, 6, 6, 9, 30, 0);
const local = (day: number, hour: number, minute = 0) =>
	new Date(2026, 6, day, hour, minute, 0).getTime();

let nextId = 0;
function msg(overrides: { receivedAt: number; flagSeen?: boolean; threadId?: string }): {
	_id: string;
	receivedAt: number;
	flagSeen: boolean;
	threadId?: string;
} {
	return {
		_id: `m${nextId++}`,
		flagSeen: false,
		...overrides,
	};
}

describe('startOfLocalDay boundaries', () => {
	it('computes local midnight of today and yesterday', () => {
		expect(startOfLocalDay(NOW)).toBe(local(6, 0));
		expect(startOfPreviousLocalDay(NOW)).toBe(local(5, 0));
	});
});

describe('partitionTodayMessages', () => {
	it('puts mail received since local midnight in today (read or unread)', () => {
		const read = msg({ receivedAt: local(6, 8), flagSeen: true });
		const unread = msg({ receivedAt: local(6, 0), flagSeen: false }); // exactly midnight
		const { today, older } = partitionTodayMessages([read, unread], { now: NOW });
		expect(today.map((m) => m._id)).toEqual([read._id, unread._id]);
		expect(older).toEqual([]);
	});

	it('keeps unread mail from the previous local day in today, read goes to older', () => {
		const unreadYesterday = msg({ receivedAt: local(5, 23, 59), flagSeen: false });
		const readYesterday = msg({ receivedAt: local(5, 23, 59), flagSeen: true });
		const { today, older } = partitionTodayMessages([unreadYesterday, readYesterday], {
			now: NOW,
		});
		expect(today.map((m) => m._id)).toEqual([unreadYesterday._id]);
		expect(older.map((m) => m._id)).toEqual([readYesterday._id]);
	});

	it('sends unread mail older than yesterday to older (one-day grace only)', () => {
		const unreadTwoDaysAgo = msg({ receivedAt: local(4, 23, 59), flagSeen: false });
		const justBeforeYesterdayMidnight = msg({ receivedAt: local(5, 0) - 1, flagSeen: false });
		const { today, older } = partitionTodayMessages(
			[unreadTwoDaysAgo, justBeforeYesterdayMidnight],
			{ now: NOW }
		);
		expect(today).toEqual([]);
		expect(older.map((m) => m._id)).toEqual([
			unreadTwoDaysAgo._id,
			justBeforeYesterdayMidnight._id,
		]);
	});

	it('auto-files categorized Today candidates instead of listing them', () => {
		const person = msg({ receivedAt: local(6, 8), threadId: 't-person' });
		const newsletter = msg({ receivedAt: local(6, 7), threadId: 't-news' });
		const receipt = msg({ receivedAt: local(5, 12), flagSeen: false, threadId: 't-receipt' });
		const uncategorized = msg({ receivedAt: local(6, 6) });
		const categories: Record<string, string> = {
			't-person': 'person',
			't-news': 'newsletter',
			't-receipt': 'receipt',
		};
		const { today, autoFiled, autoFiledCounts, older } = partitionTodayMessages(
			[person, newsletter, receipt, uncategorized],
			{
				now: NOW,
				categoryOf: (m) => (m.threadId ? categories[m.threadId] : undefined),
			}
		);
		expect(today.map((m) => m._id)).toEqual([person._id, uncategorized._id]);
		expect(autoFiled.map((m) => m._id)).toEqual([newsletter._id, receipt._id]);
		expect(autoFiledCounts).toEqual({ newsletter: 1, receipt: 1 });
		expect(older).toEqual([]);
	});

	it('never auto-files older mail — past mail is for browsing, nothing is lost', () => {
		const oldNewsletter = msg({ receivedAt: local(1, 12), flagSeen: true, threadId: 't-news' });
		const { older, autoFiled } = partitionTodayMessages([oldNewsletter], {
			now: NOW,
			categoryOf: () => 'newsletter',
		});
		expect(older.map((m) => m._id)).toEqual([oldNewsletter._id]);
		expect(autoFiled).toEqual([]);
	});

	it('fails open: without categoryOf nothing is auto-filed', () => {
		const m = msg({ receivedAt: local(6, 8), threadId: 't-news' });
		const { today, autoFiled } = partitionTodayMessages([m], { now: NOW });
		expect(today).toHaveLength(1);
		expect(autoFiled).toEqual([]);
	});
});

describe('formatAutoFiledLine', () => {
	it('is null when nothing was auto-filed', () => {
		expect(formatAutoFiledLine({})).toBeNull();
		expect(formatAutoFiledLine({ newsletter: 0 })).toBeNull();
	});

	it('uses the singular for a single message', () => {
		expect(formatAutoFiledLine({ notification: 1 })).toBe('1 notification auto-filed');
	});

	it('joins two categories with an ampersand', () => {
		expect(formatAutoFiledLine({ newsletter: 10, receipt: 2 })).toBe(
			'12 newsletters & receipts auto-filed'
		);
	});

	it('joins three categories with commas and a final ampersand', () => {
		expect(formatAutoFiledLine({ newsletter: 3, notification: 2, receipt: 1 })).toBe(
			'6 newsletters, notifications & receipts auto-filed'
		);
	});
});
