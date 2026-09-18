/**
 * Decision-plane resolution — `lib/decisionProvider.ts` — and the storage it
 * resolves from.
 *
 * THE PROPERTY THIS SUITE EXISTS FOR is the plan's own acceptance gate: an
 * install that enters no key resolves exactly as it did before this plane
 * existed. Everything else here is in service of that — the resolution order
 * that puts the language-backed adapter last, the degradation when a configured
 * provider has no credential, and the row plumbing that must not leave a key in
 * four columns and the preview in a fifth.
 *
 * Two halves, deliberately:
 *   • the resolver, unit-tested against a fake `ActionCtx`, so the stored / env
 *     / default order and the decrypt-and-cache behaviour are asserted without
 *     a database; and
 *   • the row itself, through `convex-test`, because "the five columns move in
 *     lockstep" and "no plaintext reaches a query result" are claims about what
 *     the mutation WROTE and what the query RETURNED, and a unit test of either
 *     half would prove neither.
 *
 * The language plane is mocked (`resolveLanguageModel`) — resolving a real one
 * would build an AI-SDK client, and which model the language plane picks is its
 * own suite's business. Key crypto is REAL so the encrypt → persist → project
 * round trip is exercised end to end.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';
import { newHarness } from '../../__tests__/testModules';
import { encryptSecret } from '../credentialCrypto';
import {
	__resetDecisionPlaneCacheForTests,
	decisionEnvApiKey,
	decisionKindNeedsKey,
	resolveDecisionConfig,
	resolveDecisionFallback,
	resolveDecisionProvider,
} from '../decisionProvider';

vi.stubEnv('INSTANCE_SECRET', 'test-instance-secret-value-for-aes-256-gcm-kdf');

const LANGUAGE_MODEL = { modelId: 'language-plane-model', provider: 'openai' };

vi.mock('../llmProvider', () => ({
	resolveLanguageModel: vi.fn(async () => LANGUAGE_MODEL),
}));

const sessionMocks = vi.hoisted(() => ({
	session: { userId: 'user_admin', role: 'admin' as 'owner' | 'admin' | 'editor' },
}));

vi.mock('../sessionOrganization', async () => {
	const actual = await vi.importActual('../sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(async () => sessionMocks.session),
		requireOrgPermission: vi.fn().mockImplementation(async () => sessionMocks.session),
	};
});

/** A plaintext key that must never appear in anything a client can read. */
const DECISION_KEY = 'ts-live-0123456789abcdef';

/** A mock ActionCtx whose `_getConfigRow` returns `row` and whose decrypt yields a key. */
function makeCtx(row: Doc<'aiProviderConfig'> | null, decrypted = DECISION_KEY) {
	const runQuery = vi.fn(async () => row);
	const runAction = vi.fn(async () => decrypted);
	return { ctx: { runQuery, runAction } as unknown as ActionCtx, runQuery, runAction };
}

/** A stored row, overridable per field. The decision columns are unset by default —
 * which is exactly the shape every row written before this plane existed has. */
function storedRow(over: Partial<Doc<'aiProviderConfig'>> = {}): Doc<'aiProviderConfig'> {
	return {
		_id: 'cfg1' as Doc<'aiProviderConfig'>['_id'],
		_creationTime: 0,
		languageProviderKind: 'openai',
		modelFast: 'stored-fast',
		modelCapable: 'stored-capable',
		embeddingProviderKind: 'local',
		embeddingModelVersion: 1,
		updatedAt: 1_700_000_000_000,
		...over,
	} as Doc<'aiProviderConfig'>;
}

/** The four AES-GCM columns of a stored decision key, with the preview beside them. */
function decisionEnvelopeColumns(key = DECISION_KEY): Partial<Doc<'aiProviderConfig'>> {
	const e = encryptSecret(key);
	return {
		decisionSecretCiphertext: e.ciphertext,
		decisionSecretIv: e.iv,
		decisionSecretAuthTag: e.authTag,
		decisionSecretEnvelopeVersion: e.version,
		decisionKeyPreview: 'ts-…cdef',
	};
}

describe('decisionProvider — resolution order', () => {
	beforeEach(() => {
		__resetDecisionPlaneCacheForTests();
		vi.unstubAllEnvs();
		vi.stubEnv('INSTANCE_SECRET', 'test-instance-secret-value-for-aes-256-gcm-kdf');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('resolves the language-backed adapter when nothing is configured anywhere', async () => {
		const { ctx, runAction } = makeCtx(null);
		const plane = await resolveDecisionConfig(ctx);
		expect(plane.kind).toBe('llm');
		expect(plane.source).toBe('default');
		expect(plane.calibrated).toBe(false);
		// Not a degradation: nobody opted in, so there is nothing to explain.
		expect(plane.degradedFrom).toBeUndefined();
		// And nothing was decrypted — there is no envelope to decrypt.
		expect(runAction).not.toHaveBeenCalled();
	});

	it('leaves a row written before the plane existed on the language-backed adapter', async () => {
		const { ctx } = makeCtx(storedRow());
		const plane = await resolveDecisionConfig(ctx);
		expect(plane.kind).toBe('llm');
		expect(plane.source).toBe('default');
	});

	it('uses the stored kind and the decrypted stored key', async () => {
		const { ctx, runAction } = makeCtx(
			storedRow({ decisionProviderKind: 'typesafe', ...decisionEnvelopeColumns() })
		);
		const plane = await resolveDecisionConfig(ctx);
		expect(plane.kind).toBe('typesafe');
		expect(plane.source).toBe('stored');
		expect(plane.calibrated).toBe(true);
		expect(plane.endpointProvenance).toBe('typesafe-native');
		expect(plane.clientConfig.apiKey).toBe(DECISION_KEY);
		expect(runAction).toHaveBeenCalledTimes(1);
	});

	it('prefers the stored key over the deployment one', async () => {
		vi.stubEnv('TYPESAFE_API_KEY', 'env-key');
		const { ctx } = makeCtx(
			storedRow({ decisionProviderKind: 'typesafe', ...decisionEnvelopeColumns() })
		);
		const plane = await resolveDecisionConfig(ctx);
		expect(plane.clientConfig.apiKey).toBe(DECISION_KEY);
	});

	it('falls back to the env kind, key and origin when the row names none', async () => {
		vi.stubEnv('DECISION_PROVIDER', 'typesafe');
		vi.stubEnv('TYPESAFE_API_KEY', 'env-key');
		vi.stubEnv('DECISION_BASE_URL', 'https://jev.proxy.example');
		const { ctx, runAction } = makeCtx(storedRow());
		const plane = await resolveDecisionConfig(ctx);
		expect(plane.kind).toBe('typesafe');
		expect(plane.source).toBe('env');
		expect(plane.clientConfig.apiKey).toBe('env-key');
		expect(plane.clientConfig.baseUrl).toBe('https://jev.proxy.example');
		expect(plane.endpointProvenance).toBe('custom');
		expect(runAction).not.toHaveBeenCalled();
	});

	it('lets a stored kind beat the environment', async () => {
		vi.stubEnv('DECISION_PROVIDER', 'typesafe');
		vi.stubEnv('TYPESAFE_API_KEY', 'env-key');
		const { ctx } = makeCtx(storedRow({ decisionProviderKind: 'llm' }));
		const plane = await resolveDecisionConfig(ctx);
		expect(plane.kind).toBe('llm');
		expect(plane.source).toBe('stored');
	});

	it('ignores an unrecognised DECISION_PROVIDER rather than failing the call', async () => {
		vi.stubEnv('DECISION_PROVIDER', 'typesaef');
		vi.stubEnv('TYPESAFE_API_KEY', 'env-key');
		const { ctx } = makeCtx(null);
		const plane = await resolveDecisionConfig(ctx);
		expect(plane.kind).toBe('llm');
		expect(plane.source).toBe('default');
	});

	it('marks an explicitly configured origin as a custom endpoint', async () => {
		const { ctx } = makeCtx(
			storedRow({
				decisionProviderKind: 'typesafe',
				decisionBaseUrl: 'https://jev.proxy.example',
				...decisionEnvelopeColumns(),
			})
		);
		const plane = await resolveDecisionConfig(ctx);
		expect(plane.endpointProvenance).toBe('custom');
		expect(plane.clientConfig.baseUrl).toBe('https://jev.proxy.example');
	});

	it('takes the stored model over the env override over the adapter default', async () => {
		vi.stubEnv('DECISION_MODEL', 'jev-from-env');
		const stored = await resolveDecisionConfig(
			makeCtx(
				storedRow({
					decisionProviderKind: 'typesafe',
					decisionModel: 'jev-from-row',
					...decisionEnvelopeColumns(),
				})
			).ctx
		);
		expect(stored.modelId).toBe('jev-from-row');

		__resetDecisionPlaneCacheForTests();
		const fromEnv = await resolveDecisionConfig(
			makeCtx(storedRow({ decisionProviderKind: 'typesafe', ...decisionEnvelopeColumns() })).ctx
		);
		expect(fromEnv.modelId).toBe('jev-from-env');

		__resetDecisionPlaneCacheForTests();
		vi.stubEnv('DECISION_MODEL', '');
		const fromAdapter = await resolveDecisionConfig(
			makeCtx(storedRow({ decisionProviderKind: 'typesafe', ...decisionEnvelopeColumns() })).ctx
		);
		// The pinned version, never an alias.
		expect(fromAdapter.modelId).toMatch(/^jev-\d/);
	});
});

describe('decisionProvider — degradation without a key', () => {
	beforeEach(() => {
		__resetDecisionPlaneCacheForTests();
		vi.unstubAllEnvs();
		vi.stubEnv('INSTANCE_SECRET', 'test-instance-secret-value-for-aes-256-gcm-kdf');
	});

	it('degrades a keyless stored typesafe config to the language plane', async () => {
		const { ctx, runAction } = makeCtx(storedRow({ decisionProviderKind: 'typesafe' }));
		const plane = await resolveDecisionConfig(ctx);
		expect(plane.kind).toBe('llm');
		expect(plane.calibrated).toBe(false);
		expect(plane.degradedFrom).toBe('typesafe');
		expect(plane.degradedReason).toContain('API key');
		// Nothing to decrypt, so nothing was asked of the Node action.
		expect(runAction).not.toHaveBeenCalled();
	});

	it('never leaks the key into the degraded explanation', async () => {
		vi.stubEnv('DECISION_PROVIDER', 'typesafe');
		const { ctx } = makeCtx(null);
		const plane = await resolveDecisionConfig(ctx);
		expect(plane.degradedReason).toBeDefined();
		expect(plane.degradedReason).not.toContain(DECISION_KEY);
	});

	it('degrades a stored config whose base URL already carries the endpoint path', async () => {
		const { ctx } = makeCtx(
			storedRow({
				decisionProviderKind: 'typesafe',
				decisionBaseUrl: 'https://api.typesafe.ai/v1/systemone',
				...decisionEnvelopeColumns(),
			})
		);
		const plane = await resolveDecisionConfig(ctx);
		expect(plane.kind).toBe('llm');
		expect(plane.degradedFrom).toBe('typesafe');
	});

	it('knows which kinds carry a key of their own', () => {
		expect(decisionKindNeedsKey('typesafe')).toBe(true);
		expect(decisionKindNeedsKey('llm')).toBe(false);
		expect(decisionEnvApiKey('llm')).toBeUndefined();
	});
});

describe('decisionProvider — the cache is keyed on the stored version', () => {
	beforeEach(() => {
		__resetDecisionPlaneCacheForTests();
		vi.unstubAllEnvs();
		vi.stubEnv('INSTANCE_SECRET', 'test-instance-secret-value-for-aes-256-gcm-kdf');
	});

	it('decrypts once for repeated resolutions of an unchanged row', async () => {
		const { ctx, runAction } = makeCtx(
			storedRow({ decisionProviderKind: 'typesafe', ...decisionEnvelopeColumns() })
		);
		await resolveDecisionConfig(ctx);
		await resolveDecisionConfig(ctx);
		await resolveDecisionConfig(ctx);
		expect(runAction).toHaveBeenCalledTimes(1);
	});

	it('re-decrypts as soon as a save bumps updatedAt — no TTL to wait out', async () => {
		const columns = decisionEnvelopeColumns();
		let row = storedRow({ decisionProviderKind: 'typesafe', ...columns });
		const runQuery = vi.fn(async () => row);
		const runAction = vi.fn(async () => DECISION_KEY);
		const ctx = { runQuery, runAction } as unknown as ActionCtx;

		await resolveDecisionConfig(ctx);
		expect(runAction).toHaveBeenCalledTimes(1);

		// An admin saves a corrected key: same row, new version.
		row = storedRow({
			decisionProviderKind: 'typesafe',
			...columns,
			updatedAt: row.updatedAt + 1,
		});
		runAction.mockImplementation(async () => 'the-corrected-key');
		const plane = await resolveDecisionConfig(ctx);
		expect(runAction).toHaveBeenCalledTimes(2);
		expect(plane.clientConfig.apiKey).toBe('the-corrected-key');
	});

	it('does not serve a stored plane to a deployment whose row was deleted', async () => {
		const { ctx: stored } = makeCtx(
			storedRow({ decisionProviderKind: 'typesafe', ...decisionEnvelopeColumns() })
		);
		expect((await resolveDecisionConfig(stored)).kind).toBe('typesafe');
		const { ctx: empty } = makeCtx(null);
		expect((await resolveDecisionConfig(empty)).kind).toBe('llm');
	});
});

describe('decisionProvider — the dispatch-shaped resolution', () => {
	beforeEach(() => {
		__resetDecisionPlaneCacheForTests();
		vi.unstubAllEnvs();
		vi.stubEnv('INSTANCE_SECRET', 'test-instance-secret-value-for-aes-256-gcm-kdf');
	});

	it('carries the language model only for the adapter that needs one', async () => {
		const { ctx: native } = makeCtx(
			storedRow({ decisionProviderKind: 'typesafe', ...decisionEnvelopeColumns() })
		);
		const nativeProvider = await resolveDecisionProvider(native);
		expect(nativeProvider.kind).toBe('typesafe');
		expect(nativeProvider.model).toBeUndefined();
		expect(nativeProvider.deadlineMs).toBeGreaterThan(0);

		__resetDecisionPlaneCacheForTests();
		const { ctx: language } = makeCtx(null);
		const languageProvider = await resolveDecisionProvider(language);
		expect(languageProvider.kind).toBe('llm');
		expect(languageProvider.model).toBe(LANGUAGE_MODEL);
	});

	it('offers no fallback hop unless the operator turned one on', async () => {
		const { ctx } = makeCtx(
			storedRow({ decisionProviderKind: 'typesafe', ...decisionEnvelopeColumns() })
		);
		expect(await resolveDecisionFallback(ctx)).toBeUndefined();
	});

	it('offers the hop when it is on and the primary is not already the language plane', async () => {
		const { ctx } = makeCtx(
			storedRow({
				decisionProviderKind: 'typesafe',
				isDecisionFallbackEnabled: true,
				...decisionEnvelopeColumns(),
			})
		);
		const fallback = await resolveDecisionFallback(ctx);
		expect(fallback?.kind).toBe('llm');
		expect(fallback?.model).toBe(LANGUAGE_MODEL);
	});

	it('offers no hop when the plane already IS the language plane', async () => {
		const { ctx } = makeCtx(
			storedRow({ decisionProviderKind: 'llm', isDecisionFallbackEnabled: true })
		);
		expect(await resolveDecisionFallback(ctx)).toBeUndefined();
	});
});

describe('aiProviderConfig — the five decision columns move in lockstep', () => {
	/** The language/embedding half of a save, which every case here repeats verbatim. */
	const BASE = {
		languageProviderKind: 'openai' as const,
		modelFast: 'fast',
		modelCapable: 'capable',
		isLanguageLocal: false,
		languageEnvelope: { ...encryptSecret('sk-language-key'), keyPreview: 'sk-…-key' },
		embeddingProviderKind: 'local' as const,
		isEmbeddingLocal: true,
	};

	function decisionEnvelope() {
		return { ...encryptSecret(DECISION_KEY), keyPreview: 'ts-…cdef' };
	}

	it('writes all five columns together, then clears all five together', async () => {
		const t = newHarness();
		await t.mutation(internal.aiProviderConfig._persistConfig, {
			...BASE,
			decisionProviderKind: 'typesafe',
			decisionModel: 'jev-1.13.0',
			isDecisionKeyless: false,
			decisionEnvelope: decisionEnvelope(),
		});

		const written = await t.run(async (ctx) => await ctx.db.query('aiProviderConfig').first());
		expect(written?.decisionSecretCiphertext).toBeDefined();
		expect(written?.decisionSecretIv).toBeDefined();
		expect(written?.decisionSecretAuthTag).toBeDefined();
		expect(written?.decisionSecretEnvelopeVersion).toBeDefined();
		expect(written?.decisionKeyPreview).toBe('ts-…cdef');
		// The ciphertext is not the key.
		expect(written?.decisionSecretCiphertext).not.toContain(DECISION_KEY);

		// Switching to the keyless adapter drops the stored key — all five columns.
		await t.mutation(internal.aiProviderConfig._persistConfig, {
			...BASE,
			decisionProviderKind: 'llm',
			isDecisionKeyless: true,
		});
		const cleared = await t.run(async (ctx) => await ctx.db.query('aiProviderConfig').first());
		expect(cleared?.decisionProviderKind).toBe('llm');
		expect(cleared?.decisionSecretCiphertext).toBeUndefined();
		expect(cleared?.decisionSecretIv).toBeUndefined();
		expect(cleared?.decisionSecretAuthTag).toBeUndefined();
		expect(cleared?.decisionSecretEnvelopeVersion).toBeUndefined();
		expect(cleared?.decisionKeyPreview).toBeUndefined();
	});

	it('never carries credentials across a provider change', async () => {
		const t = newHarness();
		await t.mutation(internal.aiProviderConfig._persistConfig, {
			...BASE,
			decisionProviderKind: 'typesafe',
			decisionEnvelope: decisionEnvelope(),
		});
		// Simulate another keyed adapter using the existing validator's second
		// kind. The persistence layer must bind secrets to identity, not keylessness.
		await expect(
			t.mutation(internal.aiProviderConfig._persistConfig, {
				...BASE,
				decisionProviderKind: 'llm',
				isDecisionKeyless: false,
			})
		).rejects.toThrow(/requires an API key/);
	});

	it('keeps an unchanged key from disk rather than asking for it again', async () => {
		const t = newHarness();
		await t.mutation(internal.aiProviderConfig._persistConfig, {
			...BASE,
			decisionProviderKind: 'typesafe',
			isDecisionKeyless: false,
			decisionEnvelope: decisionEnvelope(),
		});
		const first = await t.run(async (ctx) => await ctx.db.query('aiProviderConfig').first());

		await t.mutation(internal.aiProviderConfig._persistConfig, {
			...BASE,
			decisionProviderKind: 'typesafe',
			decisionModel: 'jev-1.13.0',
			isDecisionKeyless: false,
		});
		const second = await t.run(async (ctx) => await ctx.db.query('aiProviderConfig').first());
		expect(second?.decisionSecretCiphertext).toBe(first?.decisionSecretCiphertext);
		expect(second?.decisionKeyPreview).toBe(first?.decisionKeyPreview);
		expect(second?.decisionModel).toBe('jev-1.13.0');
	});

	it('leaves the plane untouched when a save names no decision kind', async () => {
		const t = newHarness();
		await t.mutation(internal.aiProviderConfig._persistConfig, {
			...BASE,
			decisionProviderKind: 'typesafe',
			isDecisionFallbackEnabled: true,
			isDecisionKeyless: false,
			decisionEnvelope: decisionEnvelope(),
		});

		// A save from a settings card that only edits the language plane.
		await t.mutation(internal.aiProviderConfig._persistConfig, BASE);

		const row = await t.run(async (ctx) => await ctx.db.query('aiProviderConfig').first());
		expect(row?.decisionProviderKind).toBe('typesafe');
		expect(row?.isDecisionFallbackEnabled).toBe(true);
		expect(row?.decisionSecretCiphertext).toBeDefined();
		expect(row?.decisionKeyPreview).toBe('ts-…cdef');
	});

	it('refuses a key-bearing provider with no key anywhere', async () => {
		const t = newHarness();
		await expect(
			t.mutation(internal.aiProviderConfig._persistConfig, {
				...BASE,
				decisionProviderKind: 'typesafe',
				isDecisionKeyless: false,
			})
		).rejects.toThrow(/decision provider requires an API key/i);
	});

	it('accepts a key-bearing provider whose key the deployment supplies', async () => {
		const t = newHarness();
		await t.mutation(internal.aiProviderConfig._persistConfig, {
			...BASE,
			decisionProviderKind: 'typesafe',
			isDecisionKeyless: false,
			hasDecisionEnvKey: true,
		});
		const row = await t.run(async (ctx) => await ctx.db.query('aiProviderConfig').first());
		expect(row?.decisionProviderKind).toBe('typesafe');
		expect(row?.decisionSecretCiphertext).toBeUndefined();
		expect(row?.decisionKeyPreview).toBeUndefined();
	});

	it('refuses a decision base URL that would send the key somewhere internal', async () => {
		const t = newHarness();
		await expect(
			t.mutation(internal.aiProviderConfig._persistConfig, {
				...BASE,
				decisionProviderKind: 'typesafe',
				decisionBaseUrl: 'http://169.254.169.254',
				isDecisionKeyless: false,
				decisionEnvelope: decisionEnvelope(),
			})
		).rejects.toThrow(/base URL/i);
	});
});

describe('aiProviderConfig.getConfig — the projection carries no secret', () => {
	it('returns the selection, the mask and a boolean, and nothing else', async () => {
		const t = newHarness();
		await t.mutation(internal.aiProviderConfig._persistConfig, {
			languageProviderKind: 'openai',
			modelFast: 'fast',
			modelCapable: 'capable',
			isLanguageLocal: false,
			languageEnvelope: { ...encryptSecret('sk-language-key'), keyPreview: 'sk-…-key' },
			embeddingProviderKind: 'local',
			isEmbeddingLocal: true,
			decisionProviderKind: 'typesafe',
			decisionModel: 'jev-1.13.0',
			isDecisionFallbackEnabled: false,
			isDecisionKeyless: false,
			decisionEnvelope: { ...encryptSecret(DECISION_KEY), keyPreview: 'ts-…cdef' },
		});

		const row = await t.run(async (ctx) => await ctx.db.query('aiProviderConfig').first());
		const config = await t.query(api.aiProviderConfig.getConfig, {});
		const projected = JSON.stringify(config);

		expect(config).toMatchObject({
			configured: true,
			decisionProviderKind: 'typesafe',
			decisionModel: 'jev-1.13.0',
			isDecisionFallbackEnabled: false,
			isDecisionKeySet: true,
			decisionKeyPreview: 'ts-…cdef',
		});
		// Neither the plaintext key nor any part of the envelope crosses to a client.
		expect(projected).not.toContain(DECISION_KEY);
		expect(projected).not.toContain(row?.decisionSecretCiphertext);
		expect(projected).not.toContain(row?.decisionSecretIv);
		expect(projected).not.toContain(row?.decisionSecretAuthTag);
		expect(projected).not.toMatch(/decisionSecret/);
	});

	it('says nothing about a plane the install never configured', async () => {
		const t = newHarness();
		await t.mutation(internal.aiProviderConfig._persistConfig, {
			languageProviderKind: 'openai',
			modelFast: 'fast',
			modelCapable: 'capable',
			isLanguageLocal: false,
			languageEnvelope: { ...encryptSecret('sk-language-key'), keyPreview: 'sk-…-key' },
			embeddingProviderKind: 'local',
			isEmbeddingLocal: true,
		});
		const config = await t.query(api.aiProviderConfig.getConfig, {});
		expect(config).toMatchObject({ configured: true, isDecisionKeySet: false });
		expect((config as { decisionProviderKind?: string }).decisionProviderKind).toBeUndefined();
	});
});
