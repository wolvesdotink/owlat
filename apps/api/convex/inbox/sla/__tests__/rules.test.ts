/**
 * Response-target policy bounds, list slices and the analytics summary.
 */
import { describe, expect, it } from 'vitest';
import {
	normalizeSlaPolicy,
	slaPolicyProblem,
	slaPolicyView,
	type SlaPolicyInput,
} from '../policyRules';
import { SLA_DUE_SOON_MS, compareResponseDue, threadMatchesSlaSlice } from '../slices';
import { nearestRank, spreadOf, summarizeResponseAnalytics } from '../analyticsRules';
import type { Doc } from '../../../_generated/dataModel';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const valid: SlaPolicyInput = {
	isEnabled: true,
	firstResponseMinutes: 240,
	nextResponseMinutes: 480,
	hoursMode: 'business',
	timeZone: 'Europe/Berlin',
	businessHours: [{ day: 1, start: 540, end: 1020 }],
	holidays: ['2026-12-25'],
};

describe('slaPolicyProblem', () => {
	it('accepts a valid policy', () => {
		expect(slaPolicyProblem(valid)).toBeNull();
	});

	it.each([
		['a zero target', { firstResponseMinutes: 0 }],
		['a fractional target', { nextResponseMinutes: 1.5 }],
		['a target over thirty days', { firstResponseMinutes: 30 * 24 * 60 + 1 }],
		['an unknown zone', { timeZone: 'Nowhere/Land' }],
		[
			'two windows on one day',
			{ businessHours: [valid.businessHours[0]!, valid.businessHours[0]!] },
		],
		['a window that ends before it starts', { businessHours: [{ day: 1, start: 600, end: 540 }] }],
		['a window past midnight', { businessHours: [{ day: 1, start: 600, end: 1441 }] }],
		['business hours with no open day', { businessHours: [] }],
		['a malformed holiday', { holidays: ['2026-02-30'] }],
	])('refuses %s', (_name, patch) => {
		expect(slaPolicyProblem({ ...valid, ...patch })).not.toBeNull();
	});

	it('allows calendar mode without opening hours', () => {
		expect(slaPolicyProblem({ ...valid, hoursMode: 'calendar', businessHours: [] })).toBeNull();
	});
});

describe('normalizeSlaPolicy / slaPolicyView', () => {
	it('sorts windows and dedupes holidays', () => {
		const normalized = normalizeSlaPolicy({
			...valid,
			businessHours: [
				{ day: 5, start: 0, end: 60 },
				{ day: 1, start: 0, end: 60 },
			],
			holidays: ['2026-12-26', '2026-12-25', '2026-12-26'],
		});
		expect(normalized.businessHours.map((h) => h.day)).toEqual([1, 5]);
		expect(normalized.holidays).toEqual(['2026-12-25', '2026-12-26']);
	});

	it('is null for an absent, disabled or invalid row', () => {
		const row = { ...valid, updatedAt: 1 } as unknown as Doc<'inboxSlaPolicies'>;
		expect(slaPolicyView(null)).toBeNull();
		expect(slaPolicyView({ ...row, isEnabled: false })).toBeNull();
		expect(slaPolicyView({ ...row, timeZone: 'Nowhere/Land' })).toBeNull();
		expect(slaPolicyView(row)).toMatchObject({
			firstResponseMs: 240 * MINUTE,
			nextResponseMs: 480 * MINUTE,
		});
	});
});

describe('SLA slices', () => {
	const now = 1_000_000_000_000;

	it('pins the due-soon window the web chip mirrors', () => {
		expect(SLA_DUE_SOON_MS).toBe(60 * 60 * 1000);
	});

	it('matches overdue and due-soon by the running deadline', () => {
		expect(threadMatchesSlaSlice({ responseDueAt: now }, 'sla-overdue', 'u', now)).toBe(true);
		expect(threadMatchesSlaSlice({ responseDueAt: now + 1 }, 'sla-overdue', 'u', now)).toBe(false);
		expect(threadMatchesSlaSlice({ responseDueAt: now + HOUR }, 'sla-due-soon', 'u', now)).toBe(
			true
		);
		expect(threadMatchesSlaSlice({ responseDueAt: now + HOUR + 1 }, 'sla-due-soon', 'u', now)).toBe(
			false
		);
		expect(threadMatchesSlaSlice({}, 'sla-overdue', 'u', now)).toBe(false);
	});

	it('narrows by assignee', () => {
		const mine = { responseDueAt: now - 1, assignedTo: 'u' };
		expect(threadMatchesSlaSlice(mine, 'sla-overdue', 'u', now, 'me')).toBe(true);
		expect(threadMatchesSlaSlice(mine, 'sla-overdue', 'u', now, 'unassigned')).toBe(false);
	});

	it('orders by deadline, threads without one last', () => {
		const rows = [
			{ responseDueAt: undefined, lastMessageAt: 5 },
			{ responseDueAt: 30, lastMessageAt: 1 },
			{ responseDueAt: undefined, lastMessageAt: 2 },
			{ responseDueAt: 10, lastMessageAt: 9 },
		];
		expect(rows.sort(compareResponseDue).map((r) => r.lastMessageAt)).toEqual([9, 1, 2, 5]);
	});
});

describe('analytics summary', () => {
	it('uses nearest-rank percentiles', () => {
		expect(nearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
		expect(nearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
		expect(spreadOf([])).toBeNull();
		expect(spreadOf([30, 10, 20])).toEqual({ median: 20, p90: 30, count: 3 });
	});

	it('summarizes the conversations that started in range', () => {
		const from = Date.parse('2026-09-01T00:00:00Z');
		const now = from + 10 * DAY;
		const thread = (o: Record<string, unknown>) =>
			({ status: 'open', firstMessageAt: from, ...o }) as Parameters<
				typeof summarizeResponseAnalytics
			>[0][number];
		const summary = summarizeResponseAnalytics(
			[
				thread({ firstResponseAt: from + HOUR, assignedTo: 'a', slaMetCount: 1 }),
				thread({ firstResponseAt: from + 3 * HOUR, assignedTo: 'a', slaMissedCount: 1 }),
				thread({ firstMessageAt: from + DAY, status: 'resolved', resolvedAt: from + 2 * DAY }),
				thread({ firstMessageAt: from + DAY, responseDueAt: now - 1 }),
				thread({ firstMessageAt: from - 1 }), // before the range
			],
			{ fromMs: from, toMs: from + 3 * DAY, now }
		);
		expect(summary.conversations).toBe(4);
		expect(summary.firstResponse).toEqual({ median: HOUR, p90: 3 * HOUR, count: 2 });
		expect(summary.resolution).toEqual({ median: DAY, p90: DAY, count: 1 });
		expect(summary.targets).toEqual({ met: 1, missed: 2, overdueNow: 1, hitRate: 1 / 3 });
		expect(summary.daily.map((d) => d.conversations)).toEqual([2, 2, 0]);
		expect(summary.daily[0]!.medianFirstResponseMs).toBe(HOUR);
		expect(summary.daily[2]!.medianFirstResponseMs).toBeNull();
		expect(summary.assignees[0]).toMatchObject({
			userId: 'a',
			conversations: 2,
			met: 1,
			missed: 1,
		});
		expect(summary.assignees.find((r) => r.userId === null)?.overdueNow).toBe(1);
	});
});
