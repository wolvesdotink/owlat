import { describe, expect, it } from 'vitest';
import { isDeclaredPluginCautionEdge, parsePluginAgentStepResult } from '../pluginStepRuntime';

describe('hosted plugin agent step runtime boundary', () => {
	it('accepts bounded continue and caution outcomes', () => {
		expect(parsePluginAgentStepResult({ kind: 'continue', output: { score: 12 } })).toEqual({
			kind: 'continue',
			outputJson: '{"score":12}',
		});
		expect(
			parsePluginAgentStepResult({
				kind: 'caution',
				to: 'draft_ready',
				reason: 'Needs human review',
			})
		).toEqual({
			kind: 'caution',
			to: 'draft_ready',
			outputJson: '{"reason":"Needs human review"}',
		});
	});

	it.each([
		[{ kind: 'skip', output: null }],
		[{ kind: 'caution', to: 'approved', reason: 'bypass' }],
		[{ kind: 'caution', to: 'failed', reason: '' }],
		[{ kind: 'continue', nextStep: 'route' }],
		[{ kind: 'continue', output: { invalid: undefined } }],
	] as const)('rejects malformed or unsafe output %#', (result) => {
		expect(() => parsePluginAgentStepResult(result)).toThrow(TypeError);
	});

	it('does not evaluate result accessors', () => {
		let reads = 0;
		const result = Object.defineProperty({}, 'kind', {
			enumerable: true,
			get() {
				reads += 1;
				return 'continue';
			},
		});
		expect(() => parsePluginAgentStepResult(result)).toThrow(TypeError);
		expect(reads).toBe(0);
	});

	it('matches only an exactly declared host-approved caution edge', () => {
		const edges = [{ from: 'drafting', to: 'draft_ready' }];
		expect(isDeclaredPluginCautionEdge(edges, 'drafting', 'draft_ready')).toBe(true);
		expect(isDeclaredPluginCautionEdge(edges, 'classifying', 'draft_ready')).toBe(false);
		expect(isDeclaredPluginCautionEdge(edges, 'drafting', 'approved')).toBe(false);
	});
});
