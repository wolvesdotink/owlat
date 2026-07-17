import { describe, it, expect } from 'vitest';
import {
	BUILT_IN_TASK_FLOW_KINDS,
	DEFAULT_TASK_CARD_SECONDS,
	UNKNOWN_TASK_CARD_RANK,
	createTaskCardRegistry,
	isBuiltInTaskFlowKind,
	isPluginTaskFlowKind,
	taskCardRegistry,
} from '../taskCardRegistry';

const noop = async () => ({ default: {} });

describe('built-in membership and metadata', () => {
	it('seeds exactly the three built-in kinds in canonical order', () => {
		const reg = createTaskCardRegistry();
		expect(reg.list().map((d) => d.kind)).toEqual(['question', 'draft_review', 'reply']);
	});

	it('pins built-in ranks (question < draft_review < reply) and time budgets', () => {
		const reg = createTaskCardRegistry();
		expect(reg.rank('question')).toBe(0);
		expect(reg.rank('draft_review')).toBe(1);
		expect(reg.rank('reply')).toBe(2);
		expect(reg.estimateSeconds('question')).toBe(45);
		expect(reg.estimateSeconds('draft_review')).toBe(60);
		expect(reg.estimateSeconds('reply')).toBe(120);
	});

	it('classifies kinds by namespace', () => {
		expect(BUILT_IN_TASK_FLOW_KINDS.every(isBuiltInTaskFlowKind)).toBe(true);
		expect(isBuiltInTaskFlowKind('plugin.foo')).toBe(false);
		expect(isPluginTaskFlowKind('plugin.foo')).toBe(true);
		expect(isPluginTaskFlowKind('plugin.')).toBe(false);
		expect(isPluginTaskFlowKind('reply')).toBe(false);
	});

	it('exposes a ready-to-use app-wide singleton seeded with the built-ins', () => {
		expect(taskCardRegistry.list().map((d) => d.kind)).toEqual([
			'question',
			'draft_review',
			'reply',
		]);
	});
});

describe('plugin registration guards', () => {
	it('appends a namespaced plugin kind after every built-in', () => {
		const reg = createTaskCardRegistry();
		const def = reg.register({ kind: 'plugin.acme.survey', label: 'Survey', load: noop });
		expect(def.rank).toBe(BUILT_IN_TASK_FLOW_KINDS.length);
		expect(reg.list().map((d) => d.kind)).toEqual([
			'question',
			'draft_review',
			'reply',
			'plugin.acme.survey',
		]);
	});

	it('assigns plugin ranks in registration order (deterministic, plugins never jump built-ins)', () => {
		const reg = createTaskCardRegistry();
		const a = reg.register({ kind: 'plugin.a', label: 'A', load: noop });
		const b = reg.register({ kind: 'plugin.b', label: 'B', load: noop });
		expect(a.rank).toBeLessThan(b.rank);
		expect(a.rank).toBeGreaterThan(reg.rank('reply'));
	});

	it('rejects overriding a built-in kind', () => {
		const reg = createTaskCardRegistry();
		expect(() => reg.register({ kind: 'reply', label: 'x', load: noop })).toThrow(/built in/);
	});

	it('rejects a non-namespaced kind', () => {
		const reg = createTaskCardRegistry();
		expect(() => reg.register({ kind: 'survey', label: 'x', load: noop })).toThrow(/namespaced/);
	});

	it('rejects a duplicate plugin kind (late/duplicate registration)', () => {
		const reg = createTaskCardRegistry();
		reg.register({ kind: 'plugin.dup', label: 'x', load: noop });
		expect(() => reg.register({ kind: 'plugin.dup', label: 'y', load: noop })).toThrow(
			/already registered/
		);
	});

	it('rejects a plugin kind with no card loader', () => {
		const reg = createTaskCardRegistry();
		expect(() =>
			reg.register({ kind: 'plugin.noload', label: 'x', load: undefined as never })
		).toThrow(/loader/);
	});
});

describe('untrusted metadata clamping', () => {
	it('clamps an out-of-range estimate into the sane band', () => {
		const reg = createTaskCardRegistry();
		expect(
			reg.register({ kind: 'plugin.slow', label: 'x', estimateSeconds: 99999, load: noop })
				.estimateSeconds
		).toBe(600);
		expect(
			reg.register({ kind: 'plugin.fast', label: 'x', estimateSeconds: 0, load: noop })
				.estimateSeconds
		).toBe(5);
	});

	it('falls back to the default estimate when none/NaN is supplied', () => {
		const reg = createTaskCardRegistry();
		expect(reg.register({ kind: 'plugin.d', label: 'x', load: noop }).estimateSeconds).toBe(
			DEFAULT_TASK_CARD_SECONDS
		);
		expect(
			reg.register({ kind: 'plugin.n', label: 'x', estimateSeconds: NaN, load: noop })
				.estimateSeconds
		).toBe(DEFAULT_TASK_CARD_SECONDS);
	});

	it('collapses whitespace and length-clamps the label', () => {
		const reg = createTaskCardRegistry();
		const long = 'a'.repeat(200);
		const def = reg.register({ kind: 'plugin.long', label: `  hi\n\tthere  ${long}`, load: noop });
		expect(def.label.length).toBeLessThanOrEqual(80);
		expect(def.label.startsWith('hi there')).toBe(true);
	});

	it('falls back to the kind when the label clamps to empty', () => {
		const reg = createTaskCardRegistry();
		expect(reg.register({ kind: 'plugin.blank', label: '   ', load: noop }).label).toBe(
			'plugin.blank'
		);
	});
});

describe('unknown-kind fallbacks', () => {
	it('ranks an unregistered kind last of all', () => {
		const reg = createTaskCardRegistry();
		expect(reg.rank('plugin.ghost')).toBe(UNKNOWN_TASK_CARD_RANK);
		expect(reg.rank('plugin.ghost')).toBeGreaterThan(reg.rank('reply'));
	});

	it('uses the default budget for an unregistered kind', () => {
		const reg = createTaskCardRegistry();
		expect(reg.estimateSeconds('plugin.ghost')).toBe(DEFAULT_TASK_CARD_SECONDS);
	});
});

describe('resolve() for the card dispatcher', () => {
	it('resolves an enabled plugin kind to its card', () => {
		const reg = createTaskCardRegistry();
		reg.register({ kind: 'plugin.ok', label: 'Ok', load: noop });
		expect(reg.resolve('plugin.ok').status).toBe('plugin');
	});

	it('resolves a flag-disabled plugin kind to a disabled fallback', () => {
		const reg = createTaskCardRegistry();
		reg.register({ kind: 'plugin.gated', label: 'Gated', flag: 'plugin.gated', load: noop });
		const r = reg.resolve('plugin.gated', (f) => f !== 'plugin.gated');
		expect(r).toEqual({ status: 'disabled', kind: 'plugin.gated', label: 'Gated' });
	});

	it('resolves an enabled, gated plugin kind to its card when the flag is on', () => {
		const reg = createTaskCardRegistry();
		reg.register({ kind: 'plugin.gated', label: 'Gated', flag: 'plugin.gated', load: noop });
		expect(reg.resolve('plugin.gated', () => true).status).toBe('plugin');
	});

	it('fails closed: a gated plugin kind with no predicate resolves to disabled', () => {
		const reg = createTaskCardRegistry();
		reg.register({ kind: 'plugin.gated', label: 'Gated', flag: 'plugin.gated', load: noop });
		expect(reg.resolve('plugin.gated')).toEqual({
			status: 'disabled',
			kind: 'plugin.gated',
			label: 'Gated',
		});
	});

	it('resolves an unregistered kind to an unknown fallback', () => {
		const reg = createTaskCardRegistry();
		expect(reg.resolve('plugin.ghost')).toEqual({ status: 'unknown', kind: 'plugin.ghost' });
	});

	it('resolves a built-in kind to unknown (built-ins render natively, not via the dispatcher)', () => {
		const reg = createTaskCardRegistry();
		expect(reg.resolve('reply').status).toBe('unknown');
	});
});
