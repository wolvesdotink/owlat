import { describe, expect, it } from 'vitest';
import {
	definePlugin,
	isPluginManifest,
	isPluginId,
	parsePluginId,
	PluginIdError,
	parsePluginManifest,
	PLUGIN_CONTRIBUTION_KINDS,
	PluginManifestError,
	validatePluginManifest,
} from '../index';

describe('plugin identity', () => {
	it('brands only ids that a manifest can own', () => {
		expect(parsePluginId('policy-pack')).toBe('policy-pack');
		expect(isPluginId('policy-pack')).toBe(true);
		expect(isPluginId('Policy Pack')).toBe(false);
		expect(() => parsePluginId('Policy Pack')).toThrow(PluginIdError);
	});
});

const validManifest = () => ({
	id: 'deliverability-lab',
	version: '0.3.0',
	capabilities: ['campaigns:read', 'send:gate', 'llm:invoke'] as const,
	flag: { default: false, requiredEnvVars: ['SEEDBOX_API_KEY'] },
	llmBudget: { dailyUsd: 2.5 },
	contributes: {
		sendGates: [{ id: 'seed-list-preflight' }],
	},
	component: { exportPath: './convex/convex.config' },
});

describe('plugin manifest validation', () => {
	function expectInvalidAt(manifest: unknown, path: string): void {
		const result = validatePluginManifest(manifest);
		expect(result.ok).toBe(false);
		expect(isPluginManifest(manifest)).toBe(false);
		if (!result.ok) expect(result.issues.map((issue) => issue.path)).toContain(path);
		expect(() => parsePluginManifest(manifest)).toThrow(PluginManifestError);
	}

	it('accepts the public manifest shape as immutable data', () => {
		const manifest = validManifest();

		const result = validatePluginManifest(manifest);

		expect(result).toEqual({ ok: true, manifest });
		if (result.ok) {
			expect(result.manifest).not.toBe(manifest);
			expect(Object.isFrozen(result.manifest)).toBe(true);
			expect(Object.isFrozen(result.manifest.capabilities)).toBe(true);
			expect(Object.isFrozen(result.manifest.flag)).toBe(true);
			expect(Object.isFrozen(result.manifest.flag?.requiredEnvVars)).toBe(true);
			expect(Object.isFrozen(result.manifest.llmBudget)).toBe(true);
			expect(Object.isFrozen(result.manifest.component)).toBe(true);
			expect(Object.isFrozen(result.manifest.contributes)).toBe(true);
			expect(Object.isFrozen(result.manifest.contributes?.sendGates)).toBe(true);
		}
		expect(isPluginManifest(manifest)).toBe(true);
	});

	it('preserves the exact object and literal contribution types in definePlugin', () => {
		const source = {
			...validManifest(),
			capabilities: [...validManifest().capabilities, 'agent:step'] as const,
			contributes: {
				...validManifest().contributes,
				agentSteps: [
					{
						id: 'spam-score',
						after: 'security_scan',
						module: { exportPath: './agent/spam-score' },
						lifecycleEdges: [{ from: 'classifying', to: 'archived' }],
					},
				],
			},
		};
		const plugin = definePlugin(source);

		expect(plugin).toBe(source);
		expect(plugin.contributes.agentSteps[0]).toEqual({
			id: 'spam-score',
			after: 'security_scan',
			module: { exportPath: './agent/spam-score' },
			lifecycleEdges: [{ from: 'classifying', to: 'archived' }],
		});
	});

	it.each([
		['plugin id', { ...validManifest(), id: 'Deliverability Lab' }, '$.id'],
		['semantic version', { ...validManifest(), version: 'v1' }, '$.version'],
		['daily budget', { ...validManifest(), llmBudget: { dailyUsd: 0 } }, '$.llmBudget.dailyUsd'],
		[
			'component export path',
			{ ...validManifest(), component: { exportPath: '../convex.config' } },
			'$.component.exportPath',
		],
		[
			'component directory export path',
			{ ...validManifest(), component: { exportPath: './convex/' } },
			'$.component.exportPath',
		],
		[
			'component loader function',
			{ ...validManifest(), component: async () => ({}) },
			'$.component',
		],
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
		['traversal', './convex/../config'],
		['double slash', './convex//config'],
		['trailing slash', './convex/'],
		['over 256 characters', `./${'a'.repeat(255)}`],
	] as const)('rejects a component export path with %s', (_label, exportPath) => {
		const result = validatePluginManifest({ ...validManifest(), component: { exportPath } });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues.map((issue) => issue.path)).toContain('$.component.exportPath');
		}
	});

	it('accepts every contribution kind in the shared catalog', () => {
		for (const kind of PLUGIN_CONTRIBUTION_KINDS) {
			expect(
				validatePluginManifest({
					...validManifest(),
					contributes: { [kind]: [] },
				}).ok,
				kind
			).toBe(true);
		}
	});

	it('requires an explicit flag only for plugins that declare host storage', () => {
		const withoutFlag = {
			...validManifest(),
			capabilities: ['campaigns:read'],
			llmBudget: undefined,
		};
		delete (withoutFlag as { flag?: unknown }).flag;
		expect(validatePluginManifest(withoutFlag).ok).toBe(true);

		const result = validatePluginManifest({
			...withoutFlag,
			capabilities: ['plugin-storage:read'],
		});
		expect(result).toMatchObject({
			ok: false,
			issues: [
				expect.objectContaining({
					code: 'missing',
					path: '$.flag',
				}),
			],
		});

		for (const [flag, expectedPath] of [
			[undefined, '$.flag'],
			[null, '$.flag'],
			[{}, '$.flag.default'],
		] as const) {
			const invalid = validatePluginManifest({
				...withoutFlag,
				capabilities: ['plugin-storage:write'],
				flag,
			});
			expect(invalid.ok, String(flag)).toBe(false);
			if (!invalid.ok) {
				expect(invalid.issues).toEqual([expect.objectContaining({ path: expectedPath })]);
			}
		}

		let accessorReads = 0;
		const accessorFlag = Object.defineProperty(
			{ ...withoutFlag, capabilities: ['plugin-storage:read'] },
			'flag',
			{
				enumerable: true,
				get() {
					accessorReads += 1;
					return { default: false };
				},
			}
		);
		const accessorResult = validatePluginManifest(accessorFlag);
		expect(accessorResult).toMatchObject({
			ok: false,
			issues: [expect.objectContaining({ code: 'accessor_not_allowed', path: '$.flag' })],
		});
		expect(accessorReads).toBe(0);
	});

	it('requires an explicit flag and valid budget for llm:invoke', () => {
		const expectOnlyIssueAt = (manifest: unknown, path: string) => {
			const result = validatePluginManifest(manifest);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.issues.map((issue) => issue.path)).toEqual([path]);
		};
		for (const [field, value, expectedPath] of [
			['flag', undefined, '$.flag'],
			['flag', null, '$.flag'],
			['flag', {}, '$.flag.default'],
			['llmBudget', undefined, '$.llmBudget'],
			['llmBudget', null, '$.llmBudget'],
			['llmBudget', {}, '$.llmBudget.dailyUsd'],
		] as const) {
			const manifest = validManifest() as Record<string, unknown>;
			manifest[field] = value;
			expectOnlyIssueAt(manifest, expectedPath);
		}

		let reads = 0;
		const accessor = Object.defineProperty(validManifest(), 'llmBudget', {
			enumerable: true,
			get() {
				reads += 1;
				return { dailyUsd: 10 };
			},
		});
		expectOnlyIssueAt(accessor, '$.llmBudget');
		expect(reads).toBe(0);

		for (const dailyUsd of [0.0000001, 1_000_000.000001, Number.POSITIVE_INFINITY]) {
			expectOnlyIssueAt({ ...validManifest(), llmBudget: { dailyUsd } }, '$.llmBudget.dailyUsd');
		}
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

	it('validates and returns the same one-pass capability snapshot', () => {
		let descriptorReads = 0;
		let propertyReads = 0;
		const capabilities = new Proxy(['mail:read'], {
			get(target, key, receiver) {
				propertyReads += 1;
				return Reflect.get(target, key, receiver);
			},
			getOwnPropertyDescriptor(target, key) {
				const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
				if (key !== '0' || !descriptor || !('value' in descriptor)) return descriptor;
				descriptorReads += 1;
				return {
					...descriptor,
					value: descriptorReads === 1 ? 'mail:read' : 'contacts:write',
				};
			},
		});

		const parsed = parsePluginManifest({ ...validManifest(), capabilities });

		expect(parsed.capabilities).toEqual(['mail:read']);
		expect(descriptorReads).toBe(1);
		expect(propertyReads).toBe(0);
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

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER])(
		'returns one structured issue for a proxy-reported invalid array length %s',
		(reportedLength) => {
			let descriptorReads = 0;
			let ownKeyReads = 0;
			let propertyReads = 0;
			const capabilities = new Proxy([], {
				get(target, key, receiver) {
					propertyReads += 1;
					return Reflect.get(target, key, receiver);
				},
				getOwnPropertyDescriptor(target, key) {
					const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
					if (key !== 'length' || !descriptor || !('value' in descriptor)) return descriptor;
					descriptorReads += 1;
					return { ...descriptor, value: reportedLength };
				},
				ownKeys() {
					ownKeyReads += 1;
					return ['length'];
				},
			});

			const result = validatePluginManifest({ ...validManifest(), capabilities });

			expect(result).toEqual({
				ok: false,
				issues: [
					{
						code: 'invalid_type',
						path: '$.capabilities.length',
						message: 'must be an unsigned 32-bit integer',
					},
				],
			});
			expect(descriptorReads).toBe(1);
			expect(ownKeyReads).toBe(0);
			expect(propertyReads).toBe(0);
		}
	);

	it.each([
		['maximum legal JavaScript array length', 0xffff_ffff],
		['large sparse array length', 100_000],
	] as const)('bounds work and issues for %s', (_label, reportedLength) => {
		const capabilities: unknown[] = [];
		capabilities.length = reportedLength;

		const result = validatePluginManifest({ ...validManifest(), capabilities });

		expect(result).toEqual({
			ok: false,
			issues: [
				{
					code: 'too_many_items',
					path: '$.capabilities',
					message: 'must contain at most 64 items',
				},
			],
		});
	});

	it('rejects an over-limit proxy before requesting keys or property values', () => {
		let descriptorReads = 0;
		const capabilities = new Proxy([], {
			get() {
				throw new Error('property get trap must not run');
			},
			getOwnPropertyDescriptor(target, key) {
				const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
				if (key !== 'length' || !descriptor || !('value' in descriptor)) return descriptor;
				descriptorReads += 1;
				return { ...descriptor, value: 100_000 };
			},
			ownKeys() {
				throw new Error('ownKeys trap must not run for an over-limit array');
			},
		});

		const result = validatePluginManifest({ ...validManifest(), capabilities });

		expect(result).toMatchObject({
			ok: false,
			issues: [{ code: 'too_many_items', path: '$.capabilities' }],
		});
		if (!result.ok) expect(result.issues).toHaveLength(1);
		expect(descriptorReads).toBe(1);
	});

	it.each([
		[
			'capabilities',
			64,
			(count: number) => ({
				...validManifest(),
				capabilities: Array.from({ length: count }, (_, index) => `domain-${index}:read`),
			}),
			'$.capabilities',
		],
		[
			'required environment variables',
			64,
			(count: number) => ({
				...validManifest(),
				flag: {
					default: false,
					requiredEnvVars: Array.from({ length: count }, (_, index) => `TOKEN_${index}`),
				},
			}),
			'$.flag.requiredEnvVars',
		],
		[
			'contribution bucket entries',
			256,
			(count: number) => ({
				...validManifest(),
				contributes: { sendGates: Array.from({ length: count }, () => undefined) },
			}),
			'$.contributes.sendGates',
		],
	] as const)(
		'accepts the %s limit and rejects limit plus one with one issue',
		(_label, maximum, makeManifest, path) => {
			expect(validatePluginManifest(makeManifest(maximum)).ok).toBe(true);
			const overLimit = validatePluginManifest(makeManifest(maximum + 1));
			expect(overLimit).toMatchObject({
				ok: false,
				issues: [{ code: 'too_many_items', path }],
			});
			if (!overLimit.ok) expect(overLimit.issues).toHaveLength(1);
		}
	);

	it('stops after the first hole even at the item-count boundary', () => {
		const capabilities: unknown[] = [];
		capabilities.length = 64;

		const result = validatePluginManifest({ ...validManifest(), capabilities });

		expect(result).toMatchObject({
			ok: false,
			issues: [{ code: 'missing', path: '$.capabilities[0]' }],
		});
		if (!result.ok) expect(result.issues).toHaveLength(1);
	});

	it('does not allocate from an out-of-range proxy index', () => {
		let propertyReads = 0;
		const capabilities = new Proxy([], {
			get(target, key, receiver) {
				propertyReads += 1;
				return Reflect.get(target, key, receiver);
			},
			getOwnPropertyDescriptor(target, key) {
				if (key === '4294967294') {
					return { configurable: true, enumerable: true, value: 'mail:read', writable: true };
				}
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
			ownKeys() {
				return ['length', '4294967294'];
			},
		});

		const result = validatePluginManifest({ ...validManifest(), capabilities });

		expect(result).toMatchObject({
			ok: false,
			issues: [{ code: 'unknown_field', path: '$.capabilities[4294967294]' }],
		});
		if (!result.ok) expect(result.issues).toHaveLength(1);
		expect(propertyReads).toBe(0);
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
