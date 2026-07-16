import { describe, expect, it } from 'vitest';
import { parsePluginManifest, validatePluginManifest } from '../manifest';

function manifest(strategy: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
	return {
		id: 'draft-pack',
		version: '1.0.0',
		capabilities: ['draft:strategy'],
		flag: { default: false },
		contributes: {
			draftStrategies: [
				{
					id: 'legal',
					label: 'Legal clauses',
					module: { exportPath: './draft/legal' },
					timeoutMs: 5_000,
					...strategy,
				},
			],
		},
		...overrides,
	};
}

describe('draft strategy manifest contract', () => {
	it('snapshots the bounded data-only descriptor', () => {
		const input = manifest({});
		const parsed = parsePluginManifest(input);
		expect(parsed.contributes?.draftStrategies?.[0]).toEqual({
			id: 'legal',
			label: 'Legal clauses',
			module: { exportPath: './draft/legal' },
			timeoutMs: 5_000,
		});
	});

	it.each([
		['invalid id', { id: 'Legal' }],
		['blank label', { label: '' }],
		['unsafe export', { module: { exportPath: '../secret' } }],
		['short timeout', { timeoutMs: 99 }],
		['long timeout', { timeoutMs: 30_001 }],
		['unknown field', { endpoint: 'https://example.test' }],
	])('rejects %s', (_label, change) => {
		expect(validatePluginManifest(manifest(change)).ok).toBe(false);
	});

	it('rejects duplicate ids', () => {
		const value = manifest({});
		(value.contributes.draftStrategies as unknown[]).push({
			id: 'legal',
			label: 'Duplicate',
			module: { exportPath: './draft/duplicate' },
			timeoutMs: 1_000,
		});
		expect(validatePluginManifest(value).ok).toBe(false);
	});

	it('requires the capability and feature flag', () => {
		expect(validatePluginManifest(manifest({}, { capabilities: [] })).ok).toBe(false);
		expect(validatePluginManifest(manifest({}, { flag: undefined })).ok).toBe(false);
	});

	it('never invokes manifest getters', () => {
		const descriptor = manifest({});
		Object.defineProperty(descriptor.contributes.draftStrategies[0], 'label', {
			enumerable: true,
			get: () => {
				throw new Error('must not execute');
			},
		});
		const result = validatePluginManifest(descriptor);
		expect(result.ok).toBe(false);
	});
});
