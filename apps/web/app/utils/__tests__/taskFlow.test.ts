import { describe, it, expect } from 'vitest';
import {
	estimateTaskFlowSeconds,
	formatTaskFlowEstimate,
	orderTaskFlow,
	summarizeTaskFlow,
	TASK_FLOW_OUTCOMES,
	taskFlowOutcome,
	taskFlowKindRank,
	type TaskFlowKind,
	type TaskFlowOrderKey,
} from '../taskFlow';
import en from '~~/i18n/locales/en.json';
import de from '~~/i18n/locales/de.json';

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

describe('open-union kinds (plugin / unknown)', () => {
	it('sorts an unregistered plugin kind after every built-in (never ahead)', () => {
		// The registry ranks unknown kinds last, so the open union can never let a
		// stray kind jump the built-in ordering.
		const result = order([
			{ id: 'ghost', kind: 'plugin.ghost' as TaskFlowKind },
			{ id: 'r', kind: 'reply' },
			{ id: 'q', kind: 'question' },
		]);
		expect(result).toEqual(['q', 'r', 'ghost']);
	});

	it('still clusters an unknown kind by thread/contact adjacency', () => {
		const result = order([
			{ id: 'q-T', kind: 'question', threadId: 'T' },
			{ id: 'x-T', kind: 'plugin.x' as TaskFlowKind, threadId: 'T' },
			{ id: 'r-U', kind: 'reply', threadId: 'U' },
		]);
		expect(result.indexOf('x-T')).toBe(result.indexOf('q-T') + 1);
	});

	it('estimates an unknown kind with the default budget (no crash)', () => {
		expect(estimateTaskFlowSeconds(['plugin.ghost' as TaskFlowKind])).toBe(60);
		// A mixed queue still yields a stable, finite estimate.
		expect(estimateTaskFlowSeconds(['question', 'plugin.ghost' as TaskFlowKind])).toBe(45 + 60);
	});
});

describe('estimateTaskFlowSeconds / formatTaskFlowEstimate', () => {
	it('sums per-kind budgets', () => {
		const a = estimateTaskFlowSeconds(['question']);
		const b = estimateTaskFlowSeconds(['question', 'question']);
		expect(b).toBe(a * 2);
	});
	it('carries a catalog key and its count, never English words (#1187)', () => {
		expect(formatTaskFlowEstimate(0)).toBeNull();
		expect(formatTaskFlowEstimate(-5)).toBeNull();
		// Under 90s: seconds, rounded to the nearest 15 and never below 1.
		expect(formatTaskFlowEstimate(45)).toEqual({
			key: 'components.agentTasks.agentTaskFlow.estimateSeconds',
			params: { n: 45 },
		});
		expect(formatTaskFlowEstimate(5)).toEqual({
			key: 'components.agentTasks.agentTaskFlow.estimateSeconds',
			params: { n: 1 },
		});
		expect(formatTaskFlowEstimate(80)).toEqual({
			key: 'components.agentTasks.agentTaskFlow.estimateSeconds',
			params: { n: 75 },
		});
		// From 90s: whole minutes.
		expect(formatTaskFlowEstimate(90)).toEqual({
			key: 'components.agentTasks.agentTaskFlow.estimateMinutes',
			params: { n: 2 },
		});
		expect(formatTaskFlowEstimate(240)).toEqual({
			key: 'components.agentTasks.agentTaskFlow.estimateMinutes',
			params: { n: 4 },
		});
	});

	it('names keys the English and German catalogs carry', () => {
		const lookup = (catalog: unknown, key: string): unknown =>
			key
				.split('.')
				.reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], catalog);
		for (const seconds of [45, 240]) {
			const { key } = formatTaskFlowEstimate(seconds) as { key: string };
			for (const catalog of [en, de]) expect(lookup(catalog, key)).toMatch(/\{n\}/);
		}
	});
});

const outcomeKey = (outcome: string) => `components.agentTasks.agentTaskFlow.outcome.${outcome}`;

describe('summarizeTaskFlow', () => {
	it('carries one catalog key and count per outcome, in first-seen order (#1187)', () => {
		expect(
			summarizeTaskFlow([
				{ label: 'replied', count: 3 },
				{ label: 'approved', count: 2 },
			])
		).toEqual([
			{ key: outcomeKey('replied'), params: { count: 3 } },
			{ key: outcomeKey('approved'), params: { count: 2 } },
		]);
	});
	it('drops zero-count entries', () => {
		expect(
			summarizeTaskFlow([
				{ label: 'replied', count: 0 },
				{ label: 'approved', count: 1 },
			])
		).toEqual([{ key: outcomeKey('approved'), params: { count: 1 } }]);
		expect(summarizeTaskFlow([])).toEqual([]);
	});
	it('merges outcomes without copy of their own into completed', () => {
		expect(
			summarizeTaskFlow([
				{ label: 'handled', count: 1 },
				{ label: 'sent', count: 2 },
				{ label: 'completed', count: 1 },
				{ label: 'done', count: 2 },
			])
		).toEqual([
			{ key: outcomeKey('completed'), params: { count: 4 } },
			{ key: outcomeKey('sent'), params: { count: 2 } },
		]);
	});
	it('has English and German copy for every outcome', () => {
		const lookup = (catalog: unknown, key: string): unknown =>
			key
				.split('.')
				.reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], catalog);
		for (const outcome of TASK_FLOW_OUTCOMES) {
			for (const catalog of [en, de]) {
				expect(lookup(catalog, outcomeKey(outcome))).toMatch(/\{count\}/);
			}
		}
	});
});

describe('taskFlowOutcome', () => {
	it('keeps a known outcome and maps anything else to completed', () => {
		expect(taskFlowOutcome('archived')).toBe('archived');
		expect(taskFlowOutcome('handled')).toBe('completed');
		expect(taskFlowOutcome(undefined)).toBe('completed');
	});
});
