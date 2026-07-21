import { describe, expect, it } from 'vitest';
import { validatePluginManifest } from '../index';

function manifest(step: Record<string, unknown>) {
	return {
		id: 'policy-pack',
		version: '1.0.0',
		capabilities: ['agent:step'],
		flag: { default: false },
		contributes: { agentSteps: [step] },
	};
}

function step(overrides: Record<string, unknown> = {}) {
	return {
		id: 'spam-score',
		after: 'security_scan',
		module: { exportPath: './agent/spam-score' },
		lifecycleEdges: [{ kind: 'caution', from: 'classifying', to: 'archived' }],
		...overrides,
	};
}

function issuePaths(value: unknown): readonly string[] {
	const result = validatePluginManifest(value);
	return result.ok ? [] : result.issues.map((issue) => issue.path);
}

describe('agent step manifest contributions', () => {
	it('accepts a data-only step descriptor', () => {
		expect(validatePluginManifest(manifest(step())).ok).toBe(true);
	});

	it.each([
		['invalid id', { id: 'SpamScore' }, '$.contributes.agentSteps[0].id'],
		['unsafe anchor', { after: '../security_scan' }, '$.contributes.agentSteps[0].after'],
		[
			'unsafe export',
			{ module: { exportPath: '../step' } },
			'$.contributes.agentSteps[0].module.exportPath',
		],
		[
			'invalid edge source',
			{ lifecycleEdges: [{ kind: 'caution', from: 'Classifying', to: 'archived' }] },
			'$.contributes.agentSteps[0].lifecycleEdges[0]',
		],
		[
			'unknown edge kind',
			{ lifecycleEdges: [{ kind: 'approve', from: 'drafting', to: 'draft_ready' }] },
			'$.contributes.agentSteps[0].lifecycleEdges[0]',
		],
		['unknown field', { handler: () => undefined }, '$.contributes.agentSteps[0].handler'],
	] as const)('rejects %s', (_label, override, path) => {
		expect(issuePaths(manifest(step(override)))).toContain(path);
	});

	it('rejects duplicate local ids and edges', () => {
		const value = manifest(
			step({
				lifecycleEdges: [
					{ kind: 'caution', from: 'classifying', to: 'archived' },
					{ kind: 'caution', from: 'classifying', to: 'archived' },
				],
			})
		);
		(value.contributes.agentSteps as Record<string, unknown>[]).push(step());
		const paths = issuePaths(value);
		expect(paths).toContain('$.contributes.agentSteps[0].lifecycleEdges[1]');
		expect(paths).toContain('$.contributes.agentSteps[1].id');
	});

	it('requires an explicit capability and flag', () => {
		const withoutCapability = manifest(step());
		withoutCapability.capabilities = [];
		expect(issuePaths(withoutCapability)).toContain('$.capabilities');

		const withoutFlag = manifest(step()) as Record<string, unknown>;
		delete withoutFlag['flag'];
		expect(issuePaths(withoutFlag)).toContain('$.flag');
	});

	it('snapshots nested descriptors without invoking accessors', () => {
		let reads = 0;
		const contribution = Object.defineProperty(step(), 'module', {
			enumerable: true,
			get() {
				reads += 1;
				return { exportPath: './agent/spam-score' };
			},
		});
		expect(issuePaths(manifest(contribution))).toContain('$.contributes.agentSteps[0].module');
		expect(reads).toBe(0);
	});
});
