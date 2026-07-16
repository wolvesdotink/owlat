import { describe, expect, it } from 'vitest';
import { parsePluginManifest, validatePluginManifest } from '../index';

function transportDefinition(overrides: Record<string, unknown> = {}) {
	return {
		id: 'postmark',
		label: 'Postmark',
		module: { exportPath: './transports/postmark' },
		retryDelays: [1_000, 5_000],
		...overrides,
	};
}

function transportManifest(overrides: Record<string, unknown> = {}) {
	return {
		id: 'mail-pack',
		version: '1.0.0',
		capabilities: ['send:transport'],
		flag: { default: false, requiredEnvVars: ['POSTMARK_TOKEN'] },
		contributes: { sendTransports: [transportDefinition()] },
		...overrides,
	};
}

function issuePaths(value: unknown): string[] {
	const result = validatePluginManifest(value);
	expect(result.ok).toBe(false);
	return result.ok ? [] : result.issues.map((issue) => issue.path);
}

describe('send transport manifest contract', () => {
	it('snapshots one data-only descriptor without importing its Node module', () => {
		const parsed = parsePluginManifest(transportManifest());
		const transport = parsed.contributes?.sendTransports?.[0];

		expect(transport).toEqual(transportDefinition());
		expect(Object.isFrozen(transport)).toBe(true);
		expect(Object.isFrozen(transport?.module)).toBe(true);
		expect(Object.isFrozen(transport?.retryDelays)).toBe(true);
	});

	it.each([
		[[], '$.capabilities'],
		[undefined, '$.flag'],
	] as const)('requires host capability and runtime flag', (value, path) => {
		const manifest = transportManifest(
			value === undefined ? { flag: undefined } : { capabilities: value }
		);
		expect(issuePaths(manifest)).toContain(path);
	});

	it.each([
		['uppercase id', { id: 'Postmark' }, '$.contributes.sendTransports[0].id'],
		['prototype id', { id: 'prototype' }, '$.contributes.sendTransports[0].id'],
		['blank label', { label: '' }, '$.contributes.sendTransports[0].label'],
		[
			'unsafe export',
			{ module: { exportPath: '../postmark' } },
			'$.contributes.sendTransports[0].module.exportPath',
		],
		[
			'unknown field',
			{ endpoint: 'https://secret.test' },
			'$.contributes.sendTransports[0].endpoint',
		],
		[
			'too many retries',
			{ retryDelays: [1, 2, 3, 4] },
			'$.contributes.sendTransports[0].retryDelays',
		],
		['negative retry', { retryDelays: [-1] }, '$.contributes.sendTransports[0].retryDelays[0]'],
		['fractional retry', { retryDelays: [1.5] }, '$.contributes.sendTransports[0].retryDelays[0]'],
		[
			'oversized retry',
			{ retryDelays: [60_001] },
			'$.contributes.sendTransports[0].retryDelays[0]',
		],
	] as const)('rejects %s', (_label, transport, path) => {
		expect(
			issuePaths(
				transportManifest({ contributes: { sendTransports: [transportDefinition(transport)] } })
			)
		).toContain(path);
	});

	it.each([
		['traversal', './transports/../postmark'],
		['double slash', './transports//postmark'],
		['trailing slash', './transports/'],
		['over 256 characters', `./${'a'.repeat(255)}`],
	] as const)('rejects a transport export path with %s', (_label, exportPath) => {
		expect(
			issuePaths(
				transportManifest({
					contributes: {
						sendTransports: [transportDefinition({ module: { exportPath } })],
					},
				})
			)
		).toContain('$.contributes.sendTransports[0].module.exportPath');
	});

	it('rejects duplicate local ids before global namespacing', () => {
		expect(
			issuePaths(
				transportManifest({
					contributes: {
						sendTransports: [transportDefinition(), transportDefinition({ label: 'Again' })],
					},
				})
			)
		).toContain('$.contributes.sendTransports[1].id');
	});

	it.each(['id', 'label', 'module', 'retryDelays'] as const)(
		'rejects a %s accessor without evaluating it',
		(field) => {
			let reads = 0;
			const transport = transportDefinition();
			Object.defineProperty(transport, field, {
				enumerable: true,
				get() {
					reads += 1;
					return field === 'retryDelays' ? [] : 'unsafe';
				},
			});

			expect(
				issuePaths(transportManifest({ contributes: { sendTransports: [transport] } }))
			).toContain(`$.contributes.sendTransports[0].${field}`);
			expect(reads).toBe(0);
		}
	);

	it('rejects inherited descriptor fields', () => {
		const inherited = Object.assign(Object.create({ id: 'postmark' }), {
			label: 'Postmark',
			module: { exportPath: './transports/postmark' },
			retryDelays: [],
		});
		expect(
			issuePaths(transportManifest({ contributes: { sendTransports: [inherited] } }))
		).toContain('$.contributes.sendTransports[0]');
	});
});
