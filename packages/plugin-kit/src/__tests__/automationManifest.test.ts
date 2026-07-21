import { describe, expect, it } from 'vitest';
import { parsePluginManifest, validatePluginManifest } from '../manifest';

const BUCKETS = [
	{ bucket: 'automationTriggers', capability: 'automation:trigger' },
	{ bucket: 'automationSteps', capability: 'automation:step' },
	{ bucket: 'automationConditions', capability: 'automation:condition' },
] as const;

function manifest(
	bucket: string,
	capability: string,
	entry: Record<string, unknown>,
	overrides: Record<string, unknown> = {}
) {
	return {
		id: 'auto-pack',
		version: '1.0.0',
		capabilities: [capability],
		flag: { default: false },
		contributes: {
			[bucket]: [
				{
					id: 'nudge',
					label: 'Nudge',
					description: 'Post a nudge to the channel',
					icon: 'bell',
					module: { exportPath: './automation/nudge' },
					...entry,
				},
			],
		},
		...overrides,
	};
}

describe('automation contribution manifest contract', () => {
	it.each(BUCKETS)(
		'snapshots a bounded editor descriptor for $bucket',
		({ bucket, capability }) => {
			const input = manifest(bucket, capability, {});
			const parsed = parsePluginManifest(input);
			const contributions = parsed.contributes as Record<
				string,
				readonly Record<string, unknown>[]
			>;
			const entry = contributions[bucket]?.[0];
			expect(entry).toEqual({
				id: 'nudge',
				label: 'Nudge',
				description: 'Post a nudge to the channel',
				icon: 'bell',
				module: { exportPath: './automation/nudge' },
			});
			expect(Object.isFrozen(entry)).toBe(true);
			expect(Object.isFrozen(entry?.['module'])).toBe(true);
			// Deep copy: mutating the source after parsing does not leak in.
			const source = input.contributes[bucket as keyof typeof input.contributes] as Record<
				string,
				unknown
			>[];
			source[0]!['label'] = 'Mutated';
			expect(entry).toMatchObject({ label: 'Nudge' });
		}
	);

	it.each(BUCKETS)('requires the matching capability for $bucket', ({ bucket, capability }) => {
		const withCapability = validatePluginManifest(manifest(bucket, capability, {}));
		expect(withCapability.ok).toBe(true);
		const withoutCapability = validatePluginManifest(
			manifest(bucket, capability, {}, { capabilities: [] })
		);
		expect(withoutCapability.ok).toBe(false);
		if (!withoutCapability.ok) {
			expect(
				withoutCapability.issues.some(
					(issue) => issue.path === '$.capabilities' && issue.message.includes(capability)
				)
			).toBe(true);
		}
	});

	it.each(BUCKETS)('requires a flag object for $bucket', ({ bucket, capability }) => {
		const result = validatePluginManifest(manifest(bucket, capability, {}, { flag: undefined }));
		expect(result.ok).toBe(false);
	});

	it.each(BUCKETS)('rejects a reserved id for $bucket', ({ bucket, capability }) => {
		expect(validatePluginManifest(manifest(bucket, capability, { id: '__proto__' })).ok).toBe(
			false
		);
	});

	it.each([
		['non-kebab id', { id: 'Nudge' }],
		['blank label', { label: '' }],
		['overlong label', { label: 'x'.repeat(81) }],
		['blank description', { description: '' }],
		['overlong description', { description: 'x'.repeat(201) }],
		['icon with slash', { icon: 'a/b' }],
		['icon as url', { icon: 'https://x' }],
		['unsafe export path', { module: { exportPath: '../secret' } }],
		['unknown field', { endpoint: 'https://example.test' }],
	])('rejects %s', (_label, change) => {
		expect(validatePluginManifest(manifest('automationSteps', 'automation:step', change)).ok).toBe(
			false
		);
	});

	it('rejects duplicate ids within a bucket', () => {
		const input = manifest('automationSteps', 'automation:step', {});
		(input.contributes['automationSteps'] as Record<string, unknown>[]).push({
			id: 'nudge',
			label: 'Nudge 2',
			description: 'Another nudge',
			icon: 'bell',
			module: { exportPath: './automation/nudge2' },
		});
		expect(validatePluginManifest(input).ok).toBe(false);
	});
});
