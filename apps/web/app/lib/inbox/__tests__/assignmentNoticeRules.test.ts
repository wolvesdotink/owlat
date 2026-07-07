import { describe, it, expect } from 'vitest';
import {
	assignmentGroupToastMessage,
	assignmentToastMessage,
	planAssignmentNotices,
	ASSIGNMENT_COALESCE_WINDOW_MS,
	type AssignmentNotice,
} from '../assignmentNoticeRules';

function notice(over: Partial<AssignmentNotice> & { id: string }): AssignmentNotice {
	return {
		threadId: `thread-${over.id}`,
		subject: 'Where is my order?',
		assignedByName: 'Ada',
		createdAt: 1_000,
		...over,
	};
}

describe('planAssignmentNotices', () => {
	it('skips notices already surfaced this session', () => {
		const seen = new Set(['a']);
		const plans = planAssignmentNotices([notice({ id: 'a' })], seen);
		expect(plans).toEqual([]);
	});

	it('emits a single plan for one fresh notice', () => {
		const n = notice({ id: 'a' });
		const plans = planAssignmentNotices([n], new Set());
		expect(plans).toEqual([{ kind: 'single', notice: n }]);
	});

	it('coalesces a burst inside the window into one grouped plan', () => {
		const notices = [
			notice({ id: 'a', createdAt: 1_000 }),
			notice({ id: 'b', createdAt: 20_000 }),
			notice({ id: 'c', createdAt: 55_000 }),
		];
		const plans = planAssignmentNotices(notices, new Set());
		expect(plans).toHaveLength(1);
		expect(plans[0]).toMatchObject({ kind: 'group', count: 3 });
	});

	it('splits notices separated by more than the window into distinct plans', () => {
		const notices = [
			notice({ id: 'a', createdAt: 1_000 }),
			// > one minute after `a` → a new run
			notice({ id: 'b', createdAt: 1_000 + ASSIGNMENT_COALESCE_WINDOW_MS + 1 }),
		];
		const plans = planAssignmentNotices(notices, new Set());
		expect(plans).toHaveLength(2);
		expect(plans.every((p) => p.kind === 'single')).toBe(true);
	});

	it('only groups the fresh notices, not the already-seen ones', () => {
		const seen = new Set(['a']);
		const notices = [notice({ id: 'a', createdAt: 1_000 }), notice({ id: 'b', createdAt: 2_000 })];
		const plans = planAssignmentNotices(notices, seen);
		expect(plans).toEqual([{ kind: 'single', notice: notices[1] }]);
	});
});

describe('assignment copy', () => {
	it('names the subject and assigner in the single toast', () => {
		expect(
			assignmentToastMessage(notice({ id: 'a', subject: 'Refund?', assignedByName: 'Bo' }))
		).toBe('Assigned to you — Refund? · from Bo');
	});

	it('counts conversations in the grouped toast', () => {
		expect(assignmentGroupToastMessage(4)).toBe('4 conversations assigned to you');
	});
});
