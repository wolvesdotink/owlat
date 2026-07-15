import { describe, it, expect } from 'vitest';
import {
	estimateCost,
	estimateCostUsd,
	estimateKnownCostMicrousd,
	providerLabelForModel,
} from '../pricing';

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

describe('known-model fixed-point admission pricing', () => {
	it('ceil-prices known models in integer micro-USD and rejects unknown models', () => {
		expect(
			estimateKnownCostMicrousd('gpt-4o-mini', {
				promptTokens: 100,
				completionTokens: 100,
				totalTokens: 200,
			})
		).toBe(75);
		expect(
			estimateKnownCostMicrousd('some-future-model', {
				promptTokens: 100,
				completionTokens: 100,
				totalTokens: 200,
			})
		).toBeUndefined();
	});
});

describe('providerLabelForModel — spend grouping per backend', () => {
	it('labels native ids by their provider family', () => {
		expect(providerLabelForModel('gpt-4o-mini')).toBe('OpenAI');
		expect(providerLabelForModel('o3-mini')).toBe('OpenAI');
		expect(providerLabelForModel('claude-opus-4-8')).toBe('Anthropic');
		expect(providerLabelForModel('gemini-2.5-pro')).toBe('Google');
		expect(providerLabelForModel('llama3.1')).toBe('Local');
		expect(providerLabelForModel('qwen2.5')).toBe('Local');
	});

	it('reads a provider-prefixed (slash) id as coming from OpenRouter', () => {
		expect(providerLabelForModel('anthropic/claude-opus-4-8')).toBe('OpenRouter');
		expect(providerLabelForModel('openai/gpt-4o')).toBe('OpenRouter');
	});

	it('distinguishes Google vs OpenAI embedding ids by the more-specific prefix', () => {
		expect(providerLabelForModel('text-embedding-004')).toBe('Google');
		expect(providerLabelForModel('text-embedding-3-small')).toBe('OpenAI');
	});

	it('is case-insensitive and trims', () => {
		expect(providerLabelForModel('  GPT-4O  ')).toBe('OpenAI');
	});

	it('falls back to Other for an unrecognized id and Unknown for none', () => {
		expect(providerLabelForModel('some-brand-new-model')).toBe('Other');
		expect(providerLabelForModel(undefined)).toBe('Unknown');
		expect(providerLabelForModel('')).toBe('Unknown');
	});
});
