/**
 * The mail list workloads build the rows the Postbox and Team Inbox scenarios
 * claim: a folder on each side of the windowing threshold, threads that age
 * against the pinned clock, and live updates that change exactly one row.
 */
import { describe, expect, it } from 'vitest';
import { inboxSlaChip } from '~/utils/inboxSla';
import { inboxWaitingChip } from '~/utils/inboxWaiting';
import { POSTBOX_VIRTUAL_THRESHOLD } from '~/utils/postboxDensity';
import { SCENARIO_NOW } from '../browserContext';
import {
	firstUnread,
	markRead,
	markThreadRead,
	postboxListWorkload,
	teamInboxWorkload,
} from '../listWorkload';
import { SCENARIOS } from '../scenarios';

const postboxScenarios = SCENARIOS.flatMap((s) => (s.family === 'postbox-list' ? [s] : []));
const inboxScenarios = SCENARIOS.flatMap((s) => (s.family === 'team-inbox' ? [s] : []));

describe('postbox list workload', () => {
	it('covers a folder below and a folder above the windowing threshold', () => {
		const sizes = postboxScenarios.map((s) => s.rows);
		expect(sizes.some((n) => n <= POSTBOX_VIRTUAL_THRESHOLD)).toBe(true);
		expect(sizes.some((n) => n > POSTBOX_VIRTUAL_THRESHOLD)).toBe(true);
	});

	it.each(postboxScenarios)('$id builds its rows newest first, before the pinned clock', (s) => {
		const rows = postboxListWorkload(s);
		expect(rows).toHaveLength(s.rows);
		expect(new Set(rows.map((r) => r._id)).size).toBe(s.rows);
		const times = rows.map((r) => r.receivedAt);
		expect(times).toEqual([...times].sort((a, b) => b - a));
		expect(Math.max(...times)).toBeLessThan(SCENARIO_NOW);
		expect(rows.some((r) => !r.flagSeen)).toBe(true);
		expect(rows.some((r) => r.flagSeen)).toBe(true);
	});

	it('a live update marks one unread row read and leaves every other row as it was', () => {
		const rows = postboxListWorkload(postboxScenarios[0]!);
		const index = firstUnread(rows);
		const next = markRead(rows, index);
		expect(next[index]).toEqual({ ...rows[index], flagSeen: true });
		expect(next.filter((row, i) => row !== rows[i])).toHaveLength(1);
		expect(() => markRead(next, index)).toThrow(/already read/);
	});
});

describe('team inbox workload', () => {
	it.each(inboxScenarios)('$id renders aging and deadline chips at the pinned clock', (s) => {
		const threads = teamInboxWorkload(s);
		expect(threads).toHaveLength(s.threads);
		expect(Math.max(...threads.map((t) => t.lastMessageAt))).toBeLessThan(SCENARIO_NOW);
		const waiting = threads.filter((t) => inboxWaitingChip(t, SCENARIO_NOW) !== null);
		const deadlines = threads.filter((t) => inboxSlaChip(t, SCENARIO_NOW) !== null);
		expect(waiting.length).toBeGreaterThan(0);
		expect(deadlines.length).toBeGreaterThan(0);
		expect(threads.some((t) => t.unread)).toBe(true);
		expect(threads.some((t) => t.assignee !== null)).toBe(true);
	});

	it('a live update reads one thread and leaves every other thread as it was', () => {
		const threads = teamInboxWorkload(inboxScenarios[0]!);
		const index = threads.findIndex((t) => t.unread);
		const next = markThreadRead(threads, index);
		expect(next[index]).toEqual({ ...threads[index], unread: false });
		expect(next.filter((thread, i) => thread !== threads[i])).toHaveLength(1);
		expect(() => markThreadRead(next, index)).toThrow(/not unread/);
	});
});
