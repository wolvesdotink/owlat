/**
 * Task headings: open tasks by due day (Overdue, Today, This week, Later, No
 * date), done tasks by the day they were finished. Days are the browser's
 * calendar days and a week ends on Sunday.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	groupTasksByCompletion,
	groupTasksByDue,
	taskDayOffset,
	taskDoneBucket,
	taskDueBucket,
	taskDueFromDateInput,
	taskDueToDateInput,
} from '../taskBuckets';

// Wednesday 2026-11-04, 09:30 local time.
const NOW = new Date(2026, 10, 4, 9, 30).getTime();
const at = (day: number, hour = 12) => new Date(2026, 10, day, hour).getTime();

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('taskDueBucket', () => {
	it('puts a due date before today under Overdue', () => {
		expect(taskDueBucket(at(3, 23), Date.now())).toBe('overdue');
	});

	it('keeps anything due today under Today, even an earlier hour', () => {
		expect(taskDueBucket(at(4, 0), Date.now())).toBe('today');
		expect(taskDueBucket(at(4, 23), Date.now())).toBe('today');
	});

	it('runs This week through Sunday and Later from Monday', () => {
		expect(taskDueBucket(at(5), Date.now())).toBe('thisWeek');
		expect(taskDueBucket(at(8, 23), Date.now())).toBe('thisWeek');
		expect(taskDueBucket(at(9, 0), Date.now())).toBe('later');
	});

	it('has an empty This week on a Sunday', () => {
		vi.setSystemTime(at(8, 10));
		expect(taskDueBucket(at(9), Date.now())).toBe('later');
	});

	it('files a task without a date under No date', () => {
		expect(taskDueBucket(null, Date.now())).toBe('none');
	});
});

describe('groupTasksByDue', () => {
	it('lists the headings in order, leaves out empty ones and keeps the list order inside one', () => {
		const tasks = [
			{ id: 'a', dueAt: null },
			{ id: 'b', dueAt: at(10) },
			{ id: 'c', dueAt: at(2) },
			{ id: 'd', dueAt: at(4) },
			{ id: 'e', dueAt: at(1) },
		];
		const groups = groupTasksByDue(tasks, Date.now());
		expect(groups.map((g) => [g.bucket, g.tasks.map((t) => t.id)])).toEqual([
			['overdue', ['c', 'e']],
			['today', ['d']],
			['later', ['b']],
			['none', ['a']],
		]);
	});
});

describe('done tasks', () => {
	it('buckets by finishing day', () => {
		expect(taskDoneBucket(at(4, 1), Date.now())).toBe('today');
		expect(taskDoneBucket(at(3, 23), Date.now())).toBe('yesterday');
		// The week started on Monday the 2nd.
		expect(taskDoneBucket(at(2, 8), Date.now())).toBe('thisWeek');
		expect(taskDoneBucket(at(1, 20), Date.now())).toBe('earlier');
	});

	it('sorts the most recent first and falls back to the last change', () => {
		const groups = groupTasksByCompletion(
			[
				{ id: 'old', completedAt: at(1), updatedAt: at(1) },
				{ id: 'now', completedAt: at(4, 8), updatedAt: at(4, 8) },
				{ id: 'early', completedAt: at(4, 1), updatedAt: at(4, 1) },
				{ id: 'legacy', completedAt: null, updatedAt: at(3) },
			],
			Date.now()
		);
		expect(groups.map((g) => [g.bucket, g.tasks.map((t) => t.id)])).toEqual([
			['today', ['now', 'early']],
			['yesterday', ['legacy']],
			['earlier', ['old']],
		]);
	});
});

describe('date field values', () => {
	it('stores a picked day as noon of that local day and reads it back', () => {
		const due = taskDueFromDateInput('2026-11-12');
		expect(due).toBe(new Date(2026, 10, 12, 12).getTime());
		expect(taskDueToDateInput(due)).toBe('2026-11-12');
	});

	it('reads an empty or malformed field as no date', () => {
		expect(taskDueFromDateInput('')).toBeNull();
		expect(taskDueFromDateInput('12.11.2026')).toBeNull();
		expect(taskDueToDateInput(null)).toBe('');
	});

	it('counts calendar days from today', () => {
		expect(taskDayOffset(at(4, 23), Date.now())).toBe(0);
		expect(taskDayOffset(at(5, 0), Date.now())).toBe(1);
		expect(taskDayOffset(at(3, 23), Date.now())).toBe(-1);
	});
});
