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
	function expectInvalidAt(manifest: unknown, path: string): void {
		const result = validatePluginManifest(manifest);
		expect(result.ok).toBe(false);
		expect(isPluginManifest(manifest)).toBe(false);
		if (!result.ok) expect(result.issues.map((issue) => issue.path)).toContain(path);
		expect(() => parsePluginManifest(manifest)).toThrow(PluginManifestError);
	}

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

	it.each([
		['capability non-string', { ...validManifest(), capabilities: [42] }, '$.capabilities[0]'],
		[
			'environment variable non-string',
			{ ...validManifest(), flag: { default: false, requiredEnvVars: [42] } },
			'$.flag.requiredEnvVars[0]',
		],
		[
			'capability format',
			{ ...validManifest(), capabilities: ['Campaigns.Read'] },
			'$.capabilities[0]',
		],
		[
			'environment variable format',
			{ ...validManifest(), flag: { default: false, requiredEnvVars: ['seedbox-key'] } },
			'$.flag.requiredEnvVars[0]',
		],
		[
			'duplicate capability',
			{ ...validManifest(), capabilities: ['mail:read', 'mail:read'] },
			'$.capabilities[1]',
		],
		[
			'duplicate environment variable',
			{ ...validManifest(), flag: { default: false, requiredEnvVars: ['API_KEY', 'API_KEY'] } },
			'$.flag.requiredEnvVars[1]',
		],
	] as const)('validates shared string-array rule: %s', (_label, manifest, path) => {
		expectInvalidAt(manifest, path);
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

	it.each([
		['id', { ...validManifest(), id: undefined }, '$.id'],
		['version', { ...validManifest(), version: undefined }, '$.version'],
		['capabilities', { ...validManifest(), capabilities: undefined }, '$.capabilities'],
		['flag.default', { ...validManifest(), flag: { default: undefined } }, '$.flag.default'],
		[
			'llmBudget.dailyUsd',
			{ ...validManifest(), llmBudget: { dailyUsd: undefined } },
			'$.llmBudget.dailyUsd',
		],
	] as const)('rejects an explicitly undefined required %s', (_label, manifest, path) => {
		expectInvalidAt(manifest, path);
	});

	it.each([
		['id', { version: '1.0.0', capabilities: [] }, '$.id'],
		['version', { id: 'missing-version', capabilities: [] }, '$.version'],
		['capabilities', { id: 'missing-capabilities', version: '1.0.0' }, '$.capabilities'],
		['flag.default', { ...validManifest(), flag: {} }, '$.flag.default'],
		['llmBudget.dailyUsd', { ...validManifest(), llmBudget: {} }, '$.llmBudget.dailyUsd'],
	] as const)('rejects an absent required %s', (_label, manifest, path) => {
		expectInvalidAt(manifest, path);
	});

	it.each(['1.0.0', '0.0.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-0.3.7', '1.0.0+build.01'])(
		'accepts SemVer %s',
		(version) => {
			expect(validatePluginManifest({ ...validManifest(), version }).ok).toBe(true);
		}
	);

	it.each(['1.0.0-01', '1.0.0-alpha.01', '1.0.0-', '1.0.0+'])(
		'rejects invalid SemVer %s',
		(version) => {
			expectInvalidAt({ ...validManifest(), version }, '$.version');
		}
	);

	it.each(['send:*', 'send:r*ad', 'send:read.*'])(
		'rejects undocumented wildcard capability %s',
		(capability) => {
			expectInvalidAt({ ...validManifest(), capabilities: [capability] }, '$.capabilities[0]');
		}
	);

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

	it('validates proxy-wrapped arrays without invoking their get traps', () => {
		let reads = 0;
		const trackReads = <Value extends unknown[]>(value: Value): Value =>
			new Proxy(value, {
				get(target, key, receiver) {
					reads += 1;
					return Reflect.get(target, key, receiver);
				},
			});
		const source = validManifest();
		const manifest = {
			...source,
			capabilities: trackReads([...source.capabilities]),
			flag: {
				...source.flag,
				requiredEnvVars: trackReads([...(source.flag.requiredEnvVars ?? [])]),
			},
			contributes: {
				...source.contributes,
				sendGates: trackReads([...source.contributes.sendGates]),
			},
		};

		expect(validatePluginManifest(manifest).ok).toBe(true);
		expect(reads).toBe(0);
	});

	it.each([
		[
			'flag.default',
			() => {
				const flag = {};
				Object.defineProperty(flag, 'default', { enumerable: true, get: accessorValue });
				return { ...validManifest(), flag };
			},
			'$.flag.default',
		],
		[
			'llmBudget.dailyUsd',
			() => {
				const llmBudget = {};
				Object.defineProperty(llmBudget, 'dailyUsd', { enumerable: true, get: accessorValue });
				return { ...validManifest(), llmBudget };
			},
			'$.llmBudget.dailyUsd',
		],
		[
			'capabilities[0]',
			() => {
				const capabilities = ['mail:read'];
				Object.defineProperty(capabilities, '0', { enumerable: true, get: accessorValue });
				return { ...validManifest(), capabilities };
			},
			'$.capabilities[0]',
		],
		[
			'flag.requiredEnvVars[0]',
			() => {
				const requiredEnvVars = ['API_KEY'];
				Object.defineProperty(requiredEnvVars, '0', { enumerable: true, get: accessorValue });
				return { ...validManifest(), flag: { default: false, requiredEnvVars } };
			},
			'$.flag.requiredEnvVars[0]',
		],
		[
			'contributes.sendGates[0]',
			() => {
				const sendGates = [{}];
				Object.defineProperty(sendGates, '0', { enumerable: true, get: accessorValue });
				return { ...validManifest(), contributes: { sendGates } };
			},
			'$.contributes.sendGates[0]',
		],
	] as const)('rejects the %s accessor without evaluating it', (_label, makeManifest, path) => {
		accessorReads = 0;
		const manifest = makeManifest();
		expectInvalidAt(manifest, path);
		expect(accessorReads).toBe(0);
	});

	it('rejects hidden and symbol metadata', () => {
		const hiddenManifest = validManifest() as Record<PropertyKey, unknown>;
		Object.defineProperty(hiddenManifest, 'displayName', { value: 'Hidden', enumerable: false });
		expectInvalidAt(hiddenManifest, '$.displayName');

		const symbol = Symbol('metadata');
		const symbolManifest = validManifest() as Record<PropertyKey, unknown>;
		symbolManifest[symbol] = 'hidden';
		expectInvalidAt(symbolManifest, '$[Symbol(metadata)]');
	});

	it.each([
		[
			'capabilities',
			() => {
				const capabilities: unknown[] = [];
				capabilities.length = 1;
				return { ...validManifest(), capabilities };
			},
			'$.capabilities[0]',
		],
		[
			'required env vars',
			() => {
				const requiredEnvVars: unknown[] = [];
				requiredEnvVars.length = 1;
				return { ...validManifest(), flag: { default: false, requiredEnvVars } };
			},
			'$.flag.requiredEnvVars[0]',
		],
	] as const)('rejects holes in %s', (_label, makeManifest, path) => {
		expectInvalidAt(makeManifest(), path);
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

let accessorReads = 0;

function accessorValue(): string {
	accessorReads += 1;
	return 'mail:read';
}
