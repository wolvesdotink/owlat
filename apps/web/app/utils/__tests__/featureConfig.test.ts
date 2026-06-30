import { describe, it, expect } from 'vitest';
import { flagsNeedingConfig } from '../featureConfig';

describe('flagsNeedingConfig', () => {
	it('badges an enabled flag that is missing configuration', () => {
		const result = flagsNeedingConfig(
			{ ai: true },
			{ ai: ['LLM_PROVIDER', 'LLM_API_KEY'] },
		);
		expect(result.has('ai')).toBe(true);
	});

	it('does not badge a disabled flag even if it is missing configuration', () => {
		const result = flagsNeedingConfig(
			{ ai: false },
			{ ai: ['LLM_PROVIDER'] },
		);
		expect(result.has('ai')).toBe(false);
	});

	it('does not badge an enabled flag with no missing requirements', () => {
		const result = flagsNeedingConfig(
			{ ai: true, campaigns: true },
			{ campaigns: ['A configured delivery provider'] },
		);
		expect(result.has('ai')).toBe(false);
		expect(result.has('campaigns')).toBe(true);
	});

	it('badges sending flags missing a delivery provider', () => {
		const result = flagsNeedingConfig(
			{ transactional: true },
			{ transactional: ['A configured delivery provider'] },
		);
		expect(result.has('transactional')).toBe(true);
	});

	it('returns an empty set while the status map is still loading', () => {
		expect(flagsNeedingConfig({ ai: true }, undefined).size).toBe(0);
		expect(flagsNeedingConfig({ ai: true }, null).size).toBe(0);
	});

	it('ignores entries with an empty missing-requirements list', () => {
		const result = flagsNeedingConfig({ ai: true }, { ai: [] });
		expect(result.has('ai')).toBe(false);
	});
});
