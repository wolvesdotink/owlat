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
		const definitions = reg.list();
		expect(definitions.map((d) => d.kind)).toEqual(['question', 'draft_review', 'reply']);
		expect(Object.isFrozen(definitions)).toBe(true);
		expect(definitions.every(Object.isFrozen)).toBe(true);
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

	it('classifies kinds by namespace (two lowercase segments required)', () => {
		expect(BUILT_IN_TASK_FLOW_KINDS.every(isBuiltInTaskFlowKind)).toBe(true);
		expect(isBuiltInTaskFlowKind('plugin.acme.survey')).toBe(false);
		expect(isPluginTaskFlowKind('plugin.acme.survey')).toBe(true);
		// Rejects single-segment, empty, uppercase, and whitespace-bearing kinds.
		expect(isPluginTaskFlowKind('plugin.acme')).toBe(false);
		expect(isPluginTaskFlowKind('plugin.a')).toBe(false);
		expect(isPluginTaskFlowKind('plugin.')).toBe(false);
		expect(isPluginTaskFlowKind('plugin.A.b')).toBe(false);
		expect(isPluginTaskFlowKind('plugin.a b')).toBe(false);
		expect(isPluginTaskFlowKind('reply')).toBe(false);
	});

	it('exposes a ready-to-use app-wide singleton seeded with the built-ins', () => {
		expect(taskCardRegistry.list().map((d) => d.kind)).toEqual([
			'question',
			'draft_review',
			'reply',
		]);
		expect(taskCardRegistry.isFrozen()).toBe(true);
	});
});

describe('plugin registration guards', () => {
	it('appends a namespaced plugin kind after every built-in', () => {
		const reg = createTaskCardRegistry();
		const def = reg.register({
			kind: 'plugin.acme.survey',
			label: 'Survey',
			flag: 'plugin.acme',
			load: noop,
		});
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
		const a = reg.register({ kind: 'plugin.acme.a', label: 'A', flag: 'plugin.acme', load: noop });
		const b = reg.register({ kind: 'plugin.acme.b', label: 'B', flag: 'plugin.acme', load: noop });
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

	it('rejects a kind that violates the two-segment namespaced grammar', () => {
		const reg = createTaskCardRegistry();
		// Single-segment (no owning-plugin id), uppercase, and embedded whitespace.
		for (const bad of ['plugin.a', 'plugin.A.b', 'plugin.a b'] as const) {
			expect(() => reg.register({ kind: bad, label: 'x', load: noop })).toThrow(/namespaced/);
		}
	});

	it('rejects a duplicate plugin kind (late/duplicate registration)', () => {
		const reg = createTaskCardRegistry();
		reg.register({ kind: 'plugin.acme.dup', label: 'x', flag: 'plugin.acme', load: noop });
		expect(() =>
			reg.register({ kind: 'plugin.acme.dup', label: 'y', flag: 'plugin.acme', load: noop })
		).toThrow(/already registered/);
	});

	it('rejects a plugin kind with no card loader', () => {
		const reg = createTaskCardRegistry();
		expect(() =>
			reg.register({ kind: 'plugin.acme.noload', label: 'x', load: undefined as never })
		).toThrow(/loader/);
	});

	it('requires the gating flag to match the kind owner', () => {
		const reg = createTaskCardRegistry();
		expect(() => reg.register({ kind: 'plugin.acme.card', label: 'x', load: noop })).toThrow(
			/owning plugin flag/
		);
		expect(() =>
			reg.register({
				kind: 'plugin.acme.card',
				label: 'x',
				flag: 'plugin.other',
				load: noop,
			})
		).toThrow(/plugin\.acme/);
	});

	it('rejects registration after the composition latch freezes', () => {
		const reg = createTaskCardRegistry().freeze();
		expect(reg.isFrozen()).toBe(true);
		expect(() =>
			reg.register({
				kind: 'plugin.acme.late',
				label: 'Late',
				flag: 'plugin.acme',
				load: noop,
			})
		).toThrow(/frozen/);
	});
});

describe('untrusted metadata clamping', () => {
	it('clamps an out-of-range estimate into the sane band', () => {
		const reg = createTaskCardRegistry();
		expect(
			reg.register({
				kind: 'plugin.acme.slow',
				label: 'x',
				flag: 'plugin.acme',
				estimateSeconds: 99999,
				load: noop,
			}).estimateSeconds
		).toBe(600);
		expect(
			reg.register({
				kind: 'plugin.acme.fast',
				label: 'x',
				flag: 'plugin.acme',
				estimateSeconds: 0,
				load: noop,
			}).estimateSeconds
		).toBe(5);
	});

	it('falls back to the default estimate when none/NaN is supplied', () => {
		const reg = createTaskCardRegistry();
		expect(
			reg.register({ kind: 'plugin.acme.d', label: 'x', flag: 'plugin.acme', load: noop })
				.estimateSeconds
		).toBe(DEFAULT_TASK_CARD_SECONDS);
		expect(
			reg.register({
				kind: 'plugin.acme.n',
				label: 'x',
				flag: 'plugin.acme',
				estimateSeconds: NaN,
				load: noop,
			}).estimateSeconds
		).toBe(DEFAULT_TASK_CARD_SECONDS);
	});

	it('collapses whitespace and length-clamps the label', () => {
		const reg = createTaskCardRegistry();
		const long = 'a'.repeat(200);
		const def = reg.register({
			kind: 'plugin.acme.long',
			label: `  hi\n\tthere  ${long}`,
			flag: 'plugin.acme',
			load: noop,
		});
		expect(def.label.length).toBeLessThanOrEqual(80);
		expect(def.label.startsWith('hi there')).toBe(true);
	});

	it('falls back to the kind when the label clamps to empty', () => {
		const reg = createTaskCardRegistry();
		expect(
			reg.register({
				kind: 'plugin.acme.blank',
				label: '   ',
				flag: 'plugin.acme',
				load: noop,
			}).label
		).toBe('plugin.acme.blank');
	});

	it('strips bidi and other control/format characters from labels', () => {
		const reg = createTaskCardRegistry();
		const definition = reg.register({
			kind: 'plugin.acme.safe-label',
			label: `Core\u202e spoof\u0007`,
			flag: 'plugin.acme',
			load: noop,
		});
		expect(definition.label).toBe('Core spoof');
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
		reg.register({ kind: 'plugin.acme.ok', label: 'Ok', flag: 'plugin.acme', load: noop });
		expect(reg.resolve('plugin.acme.ok', () => true).status).toBe('plugin');
	});

	it('resolves a flag-disabled plugin kind to a disabled fallback', () => {
		const reg = createTaskCardRegistry();
		reg.register({
			kind: 'plugin.acme.gated',
			label: 'Gated',
			flag: 'plugin.acme',
			load: noop,
		});
		const r = reg.resolve('plugin.acme.gated', (f) => f !== 'plugin.acme');
		expect(r).toEqual({ status: 'disabled', kind: 'plugin.acme.gated', label: 'Gated' });
	});

	it('resolves an enabled, gated plugin kind to its card when the flag is on', () => {
		const reg = createTaskCardRegistry();
		reg.register({
			kind: 'plugin.acme.gated',
			label: 'Gated',
			flag: 'plugin.acme',
			load: noop,
		});
		expect(reg.resolve('plugin.acme.gated', () => true).status).toBe('plugin');
	});

	it('fails closed: a gated plugin kind with no predicate resolves to disabled', () => {
		const reg = createTaskCardRegistry();
		reg.register({
			kind: 'plugin.acme.gated',
			label: 'Gated',
			flag: 'plugin.acme',
			load: noop,
		});
		expect(reg.resolve('plugin.acme.gated')).toEqual({
			status: 'disabled',
			kind: 'plugin.acme.gated',
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
