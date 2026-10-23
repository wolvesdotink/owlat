import { describe, expect, it } from 'vitest';
import { TEAM_THREAD_PRIORITIES, teamThreadPriorityOf } from '../teamThreadPriority';

describe('teamThreadPriorityOf', () => {
	it('reads an absent, empty or unknown priority as normal', () => {
		expect(teamThreadPriorityOf(null)).toBe('normal');
		expect(teamThreadPriorityOf({})).toBe('normal');
		expect(teamThreadPriorityOf({ priority: null })).toBe('normal');
		expect(teamThreadPriorityOf({ priority: 'high' })).toBe('normal');
	});

	it('keeps urgent and low', () => {
		expect(teamThreadPriorityOf({ priority: 'urgent' })).toBe('urgent');
		expect(teamThreadPriorityOf({ priority: 'low' })).toBe('low');
	});

	it('lists the most pressing first', () => {
		expect(TEAM_THREAD_PRIORITIES).toEqual(['urgent', 'normal', 'low']);
	});
});
