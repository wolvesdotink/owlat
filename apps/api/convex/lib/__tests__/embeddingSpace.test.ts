import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	EMBEDDING_DEFAULT_MODELS,
	LOCAL_EMBEDDING_DEFAULT_BASE_URLS,
	configuredEmbeddingTarget,
	embeddingSelectionForSave,
	endpointIdentity,
	envEmbeddingTarget,
	isLocalEmbeddingKind,
	isSameEmbeddingTarget,
	nextEmbeddingModelVersion,
	resolveStoredEmbeddingModel,
	storedEmbeddingTarget,
} from '../embeddingSpace';
import { embeddingProviderFor } from '../llmProviders';
import { EMBEDDING_PROVIDER_KINDS } from '../llmProviders/types';

const OLLAMA_V1 = endpointIdentity('http://ollama:11434/v1');

const ENV_KEYS = [
	'LLM_API_KEY',
	'OPENROUTER_API_KEY',
	'OPENAI_API_KEY',
	'LLM_PROVIDER',
	'LLM_BASE_URL',
	'LLM_EMBEDDING_MODEL',
	'LOCAL_EMBEDDING_MODEL',
	'LOCAL_EMBEDDING_BASE_URL',
] as const;

afterEach(() => {
	for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
});

describe('embedding defaults', () => {
	it.each(EMBEDDING_PROVIDER_KINDS)('match the %s adapter', (kind) => {
		const adapter = embeddingProviderFor(kind);
		expect(EMBEDDING_DEFAULT_MODELS[kind]).toBe(adapter.defaultModel);
		expect(isLocalEmbeddingKind(kind)).toBe(adapter.isLocal);
		if (kind === 'local' || kind === 'openaiCompatible') {
			expect(LOCAL_EMBEDDING_DEFAULT_BASE_URLS[kind]).toBe(adapter.defaultBaseUrl);
		}
	});
});

describe('resolveStoredEmbeddingModel', () => {
	it('keeps an explicit model', () => {
		expect(
			resolveStoredEmbeddingModel({ embeddingProviderKind: 'google', embeddingModel: 'x' })
		).toBe('x');
	});

	it('resolves a Google row without a model to the legacy model, not the new default', () => {
		expect(resolveStoredEmbeddingModel({ embeddingProviderKind: 'google' })).toBe(
			'text-embedding-004'
		);
	});

	it('lets a local kind follow LOCAL_EMBEDDING_MODEL', () => {
		vi.stubEnv('LOCAL_EMBEDDING_MODEL', 'mxbai-embed-large');
		expect(resolveStoredEmbeddingModel({ embeddingProviderKind: 'local' })).toBe(
			'mxbai-embed-large'
		);
		expect(resolveStoredEmbeddingModel({ embeddingProviderKind: 'openai' })).toBe(
			'text-embedding-3-small'
		);
	});
});

describe('embedding target', () => {
	it('includes the width Owlat requests from Google', () => {
		const target = storedEmbeddingTarget({
			embeddingProviderKind: 'google',
			embeddingModel: 'gemini-embedding-2',
		});
		expect(target).toMatchObject({
			provider: 'google',
			endpoint: 'native',
			model: 'gemini-embedding-2',
			requestedDimensions: 768,
			source: 'stored_config',
			isLocal: false,
		});
		expect(storedEmbeddingTarget({ embeddingProviderKind: 'google' })).toMatchObject({
			model: 'text-embedding-004',
			requestedDimensions: 'native',
		});
	});

	it('treats an absent model and its resolved value as the same target', () => {
		expect(
			isSameEmbeddingTarget(
				storedEmbeddingTarget({ embeddingProviderKind: 'google' }),
				storedEmbeddingTarget({
					embeddingProviderKind: 'google',
					embeddingModel: 'text-embedding-004',
				})
			)
		).toBe(true);
	});

	it('names a local embedder by the origin it is served from, and probes it', () => {
		expect(storedEmbeddingTarget({ embeddingProviderKind: 'local' })).toMatchObject({
			provider: 'local',
			endpoint: OLLAMA_V1,
			model: 'nomic-embed-text',
			isLocal: true,
			probeBaseUrl: 'http://ollama:11434/v1',
		});
	});

	it('detects env overrides as a new target: LOCAL_EMBEDDING_MODEL and LOCAL_EMBEDDING_BASE_URL', () => {
		const before = storedEmbeddingTarget({ embeddingProviderKind: 'local' });
		vi.stubEnv('LOCAL_EMBEDDING_MODEL', 'mxbai-embed-large');
		const otherModel = storedEmbeddingTarget({ embeddingProviderKind: 'local' });
		expect(isSameEmbeddingTarget(before, otherModel)).toBe(false);
		vi.stubEnv('LOCAL_EMBEDDING_MODEL', undefined);
		vi.stubEnv('LOCAL_EMBEDDING_BASE_URL', 'http://gpu-box:11434/v1');
		const otherServer = storedEmbeddingTarget({ embeddingProviderKind: 'local' });
		expect(otherServer.endpoint).toMatch(/^http:\/\/gpu-box:11434\/~[0-9a-f]{32}$/);
		expect(isSameEmbeddingTarget(before, otherServer)).toBe(false);
	});

	it('detects LLM_EMBEDDING_MODEL as a new env target', () => {
		vi.stubEnv('LLM_API_KEY', 'sk-env');
		const before = envEmbeddingTarget()!;
		vi.stubEnv('LLM_EMBEDDING_MODEL', 'text-embedding-ada-002');
		expect(isSameEmbeddingTarget(before, envEmbeddingTarget()!)).toBe(false);
	});

	it('has no env target when the environment configures no AI', () => {
		expect(envEmbeddingTarget()).toBeNull();
		expect(configuredEmbeddingTarget(null)).toBeNull();
	});

	it('matches a stored OpenAI embedder only through the native OpenAI endpoint', () => {
		vi.stubEnv('LLM_API_KEY', 'sk-env');
		const stored = storedEmbeddingTarget({ embeddingProviderKind: 'openai' });
		const env = envEmbeddingTarget()!;
		expect(env.source).toBe('env');
		expect(isSameEmbeddingTarget(env, stored)).toBe(true);

		vi.stubEnv('LLM_PROVIDER', 'openrouter');
		expect(envEmbeddingTarget()?.endpoint).toBe(endpointIdentity('https://openrouter.ai/api/v1'));
		expect(envEmbeddingTarget()?.isLocal).toBe(false);
		expect(isSameEmbeddingTarget(envEmbeddingTarget()!, stored)).toBe(false);

		vi.stubEnv('LLM_PROVIDER', 'ollama');
		// Probed for its revision, but hosted for payment: the env plane uses the
		// OpenAI adapter, which the ledger's locality rule always prices.
		expect(envEmbeddingTarget()).toMatchObject({
			endpoint: OLLAMA_V1,
			isLocal: false,
			probeBaseUrl: 'http://ollama:11434/v1',
		});
	});

	it('never keeps a credential of a base URL in the endpoint identity', () => {
		const identity = endpointIdentity('https://user:secret@Example.com:8443/v1?key=abc#frag');
		expect(identity).toBe(endpointIdentity('https://Example.com:8443/v1'));
		expect(identity).not.toMatch(/secret|user|key=abc|frag|\/v1/);
		expect(endpointIdentity('https://example.com/')).toBe('https://example.com');
		expect(endpointIdentity('not a url')).toBe('invalid');
	});

	it('tells two services on one origin apart by their base path (F13)', () => {
		const a = endpointIdentity('http://gateway:8080/a/v1');
		const b = endpointIdentity('http://gateway:8080/b/v1');
		expect(a).not.toBe(b);
		expect(a.startsWith('http://gateway:8080/~')).toBe(true);
		// Normalized: a trailing or doubled slash is the same route.
		expect(endpointIdentity('http://gateway:8080//a/v1/')).toBe(a);
	});

	it('prices endpoints by the ledger rule: local kind, private hosts; else hosted (F12)', () => {
		vi.stubEnv('LOCAL_EMBEDDING_BASE_URL', 'https://embeddings.example.com/v1');
		expect(storedEmbeddingTarget({ embeddingProviderKind: 'openaiCompatible' }).isLocal).toBe(
			false
		);
		vi.stubEnv('LOCAL_EMBEDDING_BASE_URL', 'http://10.0.0.5:11434/v1');
		expect(storedEmbeddingTarget({ embeddingProviderKind: 'openaiCompatible' }).isLocal).toBe(true);
		expect(storedEmbeddingTarget({ embeddingProviderKind: 'local' }).isLocal).toBe(true);
		expect(storedEmbeddingTarget({ embeddingProviderKind: 'openai' }).isLocal).toBe(false);
	});
});

describe('nextEmbeddingModelVersion', () => {
	it('moves only when the target moves', () => {
		const google = { embeddingProviderKind: 'google' as const, embeddingModelVersion: 3 };
		expect(nextEmbeddingModelVersion(null, google)).toBe(1);
		expect(
			nextEmbeddingModelVersion(google, {
				embeddingProviderKind: 'google',
				embeddingModel: 'text-embedding-004',
			})
		).toBe(3);
		expect(
			nextEmbeddingModelVersion(google, {
				embeddingProviderKind: 'google',
				embeddingModel: 'gemini-embedding-2',
			})
		).toBe(4);
	});
});

describe('embeddingSelectionForSave', () => {
	const legacyGoogle = { embeddingProviderKind: 'google' as const };

	it('keeps the stored selection when the save omits it', () => {
		expect(embeddingSelectionForSave({}, legacyGoogle)).toEqual({
			embeddingProviderKind: 'google',
			embeddingModel: undefined,
		});
		expect(embeddingSelectionForSave({ kind: 'google', model: '  ' }, legacyGoogle)).toEqual({
			embeddingProviderKind: 'google',
			embeddingModel: undefined,
		});
	});

	it('stores the Google default explicitly for a newly chosen Google embedder', () => {
		expect(embeddingSelectionForSave({ kind: 'google' }, null)).toEqual({
			embeddingProviderKind: 'google',
			embeddingModel: 'gemini-embedding-2',
		});
		expect(
			embeddingSelectionForSave({ kind: 'google' }, { embeddingProviderKind: 'local' })
		).toEqual({ embeddingProviderKind: 'google', embeddingModel: 'gemini-embedding-2' });
	});

	it('defaults to local with no stored row, and trims an explicit model', () => {
		expect(embeddingSelectionForSave({}, null)).toEqual({
			embeddingProviderKind: 'local',
			embeddingModel: undefined,
		});
		expect(embeddingSelectionForSave({ model: ' m ' }, legacyGoogle)).toEqual({
			embeddingProviderKind: 'google',
			embeddingModel: 'm',
		});
	});
});
