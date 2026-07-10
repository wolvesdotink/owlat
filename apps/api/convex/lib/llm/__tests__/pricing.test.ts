import { describe, it, expect } from 'vitest';
import { estimateCost, estimateCostUsd } from '../pricing';

const oneMillionEach = {
	promptTokens: 1_000_000,
	completionTokens: 1_000_000,
	totalTokens: 2_000_000,
};

describe('estimateCost', () => {
	it('prices known models from the per-million table', () => {
		expect(estimateCost('gpt-4o-mini', oneMillionEach)).toEqual({
			costUsd: 0.15 + 0.6,
			estimated: false,
		});
		expect(estimateCost('gpt-4o', oneMillionEach)).toEqual({ costUsd: 2.5 + 10, estimated: false });
	});

	it('matches the most-specific prefix (mini before base) and tolerates id suffixes', () => {
		// gpt-4o-mini-2024-07-18 must price as mini, not as gpt-4o.
		expect(estimateCost('gpt-4o-mini-2024-07-18', oneMillionEach).costUsd).toBeCloseTo(0.75);
	});

	it('prices current-generation Claude ids from their exact rows, not the generic fallback', () => {
		// claude-opus-4-8 must price at its own $5/$25 — not the older Opus
		// generic ($15/$75) whose prefix `claude-opus` it also starts with.
		expect(estimateCost('claude-opus-4-8', oneMillionEach)).toEqual({
			costUsd: 5 + 25,
			estimated: false,
		});
		expect(estimateCost('claude-haiku-4-5', oneMillionEach)).toEqual({
			costUsd: 1 + 5,
			estimated: false,
		});
		expect(estimateCost('claude-sonnet-4-5', oneMillionEach)).toEqual({
			costUsd: 3 + 15,
			estimated: false,
		});
	});

	it('still prices generic Claude tiers via their fallback prefixes', () => {
		expect(estimateCost('claude-opus-4-1', oneMillionEach)).toEqual({
			costUsd: 15 + 75,
			estimated: false,
		});
		expect(estimateCost('claude-sonnet-3-5', oneMillionEach)).toEqual({
			costUsd: 3 + 15,
			estimated: false,
		});
	});

	it('prices an unknown model with a conservative non-zero default, flagged estimated', () => {
		const r = estimateCost('some-future-model-xl', oneMillionEach);
		expect(r.estimated).toBe(true);
		expect(r.costUsd).toBeGreaterThan(0); // never silently $0
	});

	it('is zero for missing usage', () => {
		expect(estimateCost('gpt-4o', undefined).costUsd).toBe(0);
		expect(estimateCostUsd('gpt-4o', undefined)).toBe(0);
	});

	it('scales linearly with token counts', () => {
		const half = { promptTokens: 500_000, completionTokens: 500_000, totalTokens: 1_000_000 };
		expect(estimateCostUsd('gpt-4o-mini', half)).toBeCloseTo(0.75 / 2);
	});
});
