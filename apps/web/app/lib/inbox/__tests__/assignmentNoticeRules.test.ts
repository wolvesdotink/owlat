import { describe, it, expect } from 'vitest';
import {
	assignmentGroupToastMessage,
	assignmentNotificationParts,
	assignmentToastMessage,
	planAssignmentNotices,
	ASSIGNMENT_COALESCE_WINDOW_MS,
	type AssignmentNotice,
	type AssignmentMessage,
} from '../assignmentNoticeRules';
import { createTestI18n } from '~/__tests__/i18n';

/**
 * The rules decide the line; the toast and the OS notification speak it. Module
 * scope cannot call `useI18n`, so the copy travels as a catalog key plus its
 * parameters — rendered here exactly as the caller renders it.
 */
const { t } = createTestI18n().global;
const render = (message: AssignmentMessage): string => t(message.key, message.params ?? {});

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
			render(assignmentToastMessage(notice({ id: 'a', subject: 'Refund?', assignedByName: 'Bo' })))
		).toBe('Assigned to you — Refund? · from Bo');
	});

	it('says "No subject" as translated words, not as a spliced-in literal', () => {
		expect(
			render(assignmentToastMessage(notice({ id: 'a', subject: '', assignedByName: 'Bo' })))
		).toBe('Assigned to you — No subject · from Bo');
	});

	it('counts conversations in the grouped toast', () => {
		expect(render(assignmentGroupToastMessage(4))).toBe('4 conversations assigned to you');
	});
});

describe('clarification notices', () => {
	it('never coalesces a clarification into an assignment burst', () => {
		const notices = [
			notice({ id: 'a', createdAt: 1_000 }),
			notice({ id: 'q', kind: 'clarification', createdAt: 2_000 }),
			notice({ id: 'b', createdAt: 3_000 }),
		];
		const plans = planAssignmentNotices(notices, new Set());
		expect(plans.map((p) => p.kind)).toEqual(['single', 'single', 'single']);
		expect(plans[1]).toMatchObject({ kind: 'single', notice: { id: 'q' } });
	});

	it('speaks the clarification line, naming the subject', () => {
		const n = notice({ id: 'q', kind: 'clarification', subject: 'Renewal quote' });
		expect(render(assignmentToastMessage(n))).toBe(
			'The agent needs your input to reply — Renewal quote'
		);
		const parts = assignmentNotificationParts(n);
		expect(render(parts.title)).toBe('Your input is needed');
		expect(render(parts.body)).toBe('Renewal quote · the agent has a question for you');
	});

	it('keeps the assignment wording for assignment notices', () => {
		const n = notice({ id: 'a', kind: 'assignment' });
		expect(render(assignmentToastMessage(n))).toBe(
			'Assigned to you — Where is my order? · from Ada'
		);
	});
});
