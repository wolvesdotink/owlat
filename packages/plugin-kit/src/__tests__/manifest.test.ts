import { describe, expect, it } from 'vitest';
import {
	definePlugin,
	isPluginManifest,
	parsePluginManifest,
	PluginManifestError,
	validatePluginManifest,
} from '../index';

const validManifest = () => ({
	id: 'deliverability-lab',
	version: '0.3.0',
	capabilities: ['campaigns:read', 'send:gate', 'llm:invoke'] as const,
	flag: { default: false, requiredEnvVars: ['SEEDBOX_API_KEY'] },
	llmBudget: { dailyUsd: 2.5 },
	contributes: {
		sendGates: [{ id: 'seed-list-preflight' }],
		agentSteps: [{ id: 'spam-score', after: 'security_scan' }],
	},
	component: async () => ({ name: 'deliverabilityLab' }),
});

describe('plugin manifest validation', () => {
	it('accepts the public manifest shape without invoking plugin code', () => {
		let componentLoads = 0;
		const manifest = validManifest();
		manifest.component = async () => {
			componentLoads += 1;
			return { name: 'deliverabilityLab' };
		};

		const result = validatePluginManifest(manifest);

		expect(result).toEqual({ ok: true, manifest });
		expect(componentLoads).toBe(0);
		expect(isPluginManifest(manifest)).toBe(true);
	});

	it('preserves the exact object and literal contribution types in definePlugin', () => {
		const source = validManifest();
		const plugin = definePlugin(source);

		expect(plugin).toBe(source);
		expect(plugin.contributes.agentSteps[0]).toEqual({
			id: 'spam-score',
			after: 'security_scan',
		});
	});

	it.each([
		['plugin id', { ...validManifest(), id: 'Deliverability Lab' }, '$.id'],
		['semantic version', { ...validManifest(), version: 'v1' }, '$.version'],
		[
			'capability format',
			{ ...validManifest(), capabilities: ['Campaigns.Read'] },
			'$.capabilities[0]',
		],
		[
			'duplicate capability',
			{ ...validManifest(), capabilities: ['mail:read', 'mail:read'] },
			'$.capabilities[1]',
		],
		[
			'environment variable',
			{ ...validManifest(), flag: { default: false, requiredEnvVars: ['seedbox-key'] } },
			'$.flag.requiredEnvVars[0]',
		],
		['daily budget', { ...validManifest(), llmBudget: { dailyUsd: 0 } }, '$.llmBudget.dailyUsd'],
		[
			'contribution kind',
			{ ...validManifest(), contributes: { mysteriousThings: [] } },
			'$.contributes.mysteriousThings',
		],
		[
			'contribution bucket',
			{ ...validManifest(), contributes: { sendGates: { id: 'gate' } } },
			'$.contributes.sendGates',
		],
		['top-level field', { ...validManifest(), displayName: 'Lab' }, '$.displayName'],
	] as const)('rejects an invalid %s', (_label, manifest, expectedPath) => {
		const result = validatePluginManifest(manifest);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.issues.map((issue) => issue.path)).toContain(expectedPath);
	});

	it('reports all independent problems in one validation pass', () => {
		const result = validatePluginManifest({
			id: 'Bad Id',
			version: 'latest',
			capabilities: ['bad'],
			flag: { default: 'no' },
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues.map((issue) => issue.path)).toEqual([
				'$.id',
				'$.version',
				'$.capabilities[0]',
				'$.flag.default',
			]);
		}
	});

	it('rejects accessors without evaluating them', () => {
		let reads = 0;
		const manifest = validManifest() as Record<string, unknown>;
		Object.defineProperty(manifest, 'id', {
			enumerable: true,
			get() {
				reads += 1;
				return 'deliverability-lab';
			},
		});

		const result = validatePluginManifest(manifest);

		expect(reads).toBe(0);
		expect(result).toMatchObject({
			ok: false,
			issues: [{ code: 'accessor_not_allowed', path: '$.id' }],
		});
	});

	it('throws one typed error from the parsing API', () => {
		expect(() => parsePluginManifest({ id: 'invalid' })).toThrow(PluginManifestError);
		try {
			parsePluginManifest({ id: 'invalid' });
		} catch (error) {
			expect(error).toBeInstanceOf(PluginManifestError);
			if (error instanceof PluginManifestError) {
				expect(error.issues.map((issue) => issue.path)).toEqual(['$.version', '$.capabilities']);
			}
		}
	});
});
