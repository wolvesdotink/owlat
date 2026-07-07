import { describe, it, expect } from 'vitest';
import {
	estimateTaskFlowSeconds,
	formatTaskFlowEstimate,
	orderTaskFlow,
	summarizeTaskFlow,
	taskFlowKindRank,
	type TaskFlowKind,
	type TaskFlowOrderKey,
} from '../taskFlow';

interface Task {
	id: string;
	kind: TaskFlowKind;
	threadId?: string;
	contactKey?: string;
}
const key = (t: Task): TaskFlowOrderKey => t;
const order = (tasks: Task[]) => orderTaskFlow(tasks, key).map((t) => t.id);

describe('taskFlowKindRank', () => {
	it('ranks questions before draft reviews before plain replies', () => {
		expect(taskFlowKindRank('question')).toBeLessThan(taskFlowKindRank('draft_review'));
		expect(taskFlowKindRank('draft_review')).toBeLessThan(taskFlowKindRank('reply'));
	});
});

describe('orderTaskFlow', () => {
	it('orders by kind when nothing is related', () => {
		expect(
			order([
				{ id: 'r', kind: 'reply' },
				{ id: 'd', kind: 'draft_review' },
				{ id: 'q', kind: 'question' },
			])
		).toEqual(['q', 'd', 'r']);
	});

	it('is stable within a kind (keeps the source ranking)', () => {
		expect(
			order([
				{ id: 'a', kind: 'reply' },
				{ id: 'b', kind: 'reply' },
				{ id: 'c', kind: 'reply' },
			])
		).toEqual(['a', 'b', 'c']);
	});

	it('keeps same-thread items adjacent even across kinds', () => {
		// The reply on thread T should be pulled up next to its question, ahead of
		// an unrelated draft review that would otherwise sort before it.
		const result = order([
			{ id: 'q-T', kind: 'question', threadId: 'T' },
			{ id: 'd-X', kind: 'draft_review', threadId: 'X' },
			{ id: 'r-T', kind: 'reply', threadId: 'T' },
		]);
		expect(result.indexOf('r-T')).toBe(result.indexOf('q-T') + 1);
		expect(result).toEqual(['q-T', 'r-T', 'd-X']);
	});

	it('keeps same-contact items adjacent when no thread matches', () => {
		const result = order([
			{ id: 'q-alice', kind: 'question', contactKey: 'alice' },
			{ id: 'r-bob', kind: 'reply', contactKey: 'bob' },
			{ id: 'r-alice', kind: 'reply', contactKey: 'alice' },
		]);
		expect(result.indexOf('r-alice')).toBe(result.indexOf('q-alice') + 1);
	});

	it('prefers thread adjacency over contact adjacency', () => {
		const result = order([
			{ id: 'seed', kind: 'question', threadId: 'T', contactKey: 'alice' },
			{ id: 'same-contact', kind: 'reply', contactKey: 'alice' },
			{ id: 'same-thread', kind: 'reply', threadId: 'T' },
		]);
		expect(result[0]).toBe('seed');
		expect(result[1]).toBe('same-thread');
		expect(result[2]).toBe('same-contact');
	});

	it('returns a new array and does not mutate the input', () => {
		const input: Task[] = [
			{ id: 'r', kind: 'reply' },
			{ id: 'q', kind: 'question' },
		];
		const out = orderTaskFlow(input, key);
		expect(out).not.toBe(input);
		expect(input.map((t) => t.id)).toEqual(['r', 'q']);
	});
});

describe('estimateTaskFlowSeconds / formatTaskFlowEstimate', () => {
	it('sums per-kind budgets', () => {
		const a = estimateTaskFlowSeconds(['question']);
		const b = estimateTaskFlowSeconds(['question', 'question']);
		expect(b).toBe(a * 2);
	});
	it('formats minutes above 90s and seconds below', () => {
		expect(formatTaskFlowEstimate(0)).toBe('');
		expect(formatTaskFlowEstimate(45)).toMatch(/sec$/);
		expect(formatTaskFlowEstimate(240)).toBe('about 4 min');
	});
});

describe('summarizeTaskFlow', () => {
	it('joins non-zero tallies with a middot', () => {
		expect(
			summarizeTaskFlow([
				{ label: 'answered', count: 3 },
				{ label: 'approved', count: 2 },
			])
		).toBe('3 answered · 2 approved');
	});
	it('drops zero-count entries', () => {
		expect(
			summarizeTaskFlow([
				{ label: 'answered', count: 0 },
				{ label: 'approved', count: 1 },
			])
		).toBe('1 approved');
	});
});
