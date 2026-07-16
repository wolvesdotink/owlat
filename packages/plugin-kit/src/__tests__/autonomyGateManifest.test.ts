import { describe, expect, it } from 'vitest';
import { parsePluginManifest, validatePluginManifest } from '../manifest';

function manifest(gate: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
	return {
		id: 'policy-pack',
		version: '1.0.0',
		capabilities: ['send:gate'],
		flag: { default: false },
		contributes: {
			sendGates: [
				{
					id: 'approval-policy',
					label: 'Approval policy',
					module: { exportPath: './gates/approval' },
					timeoutMs: 5_000,
					...gate,
				},
			],
		},
		...overrides,
	};
}

describe('autonomy gate manifest contract', () => {
	it('snapshots and freezes the complete data-only descriptor', () => {
		const input = manifest({});
		const parsed = parsePluginManifest(input);
		const parsedGate = parsed.contributes?.sendGates?.[0];
		expect(parsedGate).toEqual({
			id: 'approval-policy',
			label: 'Approval policy',
			module: { exportPath: './gates/approval' },
			timeoutMs: 5_000,
		});
		expect(parsedGate).not.toBe(input.contributes.sendGates[0]);
		expect(parsedGate?.module).not.toBe(input.contributes.sendGates[0]?.module);
		expect(Object.isFrozen(parsedGate)).toBe(true);
		expect(Object.isFrozen(parsedGate?.module)).toBe(true);

		input.contributes.sendGates[0]!.label = 'Mutated';
		input.contributes.sendGates[0]!.module.exportPath = './gates/mutated';
		expect(parsedGate).toMatchObject({
			label: 'Approval policy',
			module: { exportPath: './gates/approval' },
		});
	});

	it.each([
		['uppercase id', { id: 'Approval' }],
		['reserved id', { id: 'prototype' }],
		['padded label', { label: ' Approval policy ' }],
		['unsafe export', { module: { exportPath: '../secret' } }],
		['short timeout', { timeoutMs: 99 }],
		['long timeout', { timeoutMs: 30_001 }],
		['fractional timeout', { timeoutMs: 100.5 }],
		['unknown field', { endpoint: 'https://example.test' }],
	])('rejects %s', (_label, change) => {
		expect(validatePluginManifest(manifest(change)).ok).toBe(false);
	});

	it('rejects duplicate ids', () => {
		const value = manifest({});
		(value.contributes.sendGates as unknown[]).push({
			id: 'approval-policy',
			label: 'Duplicate',
			module: { exportPath: './gates/duplicate' },
			timeoutMs: 1_000,
		});
		expect(validatePluginManifest(value).ok).toBe(false);
	});

	it('requires the exact capability and a feature flag', () => {
		expect(validatePluginManifest(manifest({}, { capabilities: [] })).ok).toBe(false);
		expect(validatePluginManifest(manifest({}, { flag: undefined })).ok).toBe(false);
	});

	it('never invokes contribution accessors', () => {
		const descriptor = manifest({});
		Object.defineProperty(descriptor.contributes.sendGates[0], 'label', {
			enumerable: true,
			get: () => {
				throw new Error('must not execute');
			},
		});
		expect(validatePluginManifest(descriptor).ok).toBe(false);
	});
});
