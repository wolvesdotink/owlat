import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	EMBEDDING_DEFAULT_MODELS,
	embeddingSelectionForSave,
	envEmbeddingSpace,
	isLocalEmbeddingKind,
	isSameEmbeddingSpace,
	resolveStoredEmbeddingModel,
	storedEmbeddingSpace,
} from '../embeddingSpace';
import { embeddingProviderFor } from '../llmProviders';
import { EMBEDDING_PROVIDER_KINDS } from '../llmProviders/types';

const ENV_KEYS = [
	'LLM_API_KEY',
	'OPENROUTER_API_KEY',
	'OPENAI_API_KEY',
	'LLM_PROVIDER',
	'LLM_BASE_URL',
	'LLM_EMBEDDING_MODEL',
	'LOCAL_EMBEDDING_MODEL',
] as const;

afterEach(() => {
	for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
});

describe('embedding defaults', () => {
	it.each(EMBEDDING_PROVIDER_KINDS)('match the %s adapter', (kind) => {
		const adapter = embeddingProviderFor(kind);
		expect(EMBEDDING_DEFAULT_MODELS[kind]).toBe(adapter.defaultModel);
		expect(isLocalEmbeddingKind(kind)).toBe(adapter.isLocal);
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

describe('embedding space identity', () => {
	it('includes the width Owlat requests from Google', () => {
		expect(
			storedEmbeddingSpace({
				embeddingProviderKind: 'google',
				embeddingModel: 'gemini-embedding-2',
			})
		).toEqual({ provider: 'google', modelId: 'gemini-embedding-2', dimensions: 768 });
		expect(storedEmbeddingSpace({ embeddingProviderKind: 'google' })).toEqual({
			provider: 'google',
			modelId: 'text-embedding-004',
			dimensions: 'native',
		});
	});

	it('treats an absent model and its resolved value as the same space', () => {
		expect(
			isSameEmbeddingSpace(
				storedEmbeddingSpace({ embeddingProviderKind: 'google' }),
				storedEmbeddingSpace({
					embeddingProviderKind: 'google',
					embeddingModel: 'text-embedding-004',
				})
			)
		).toBe(true);
	});

	it('has no env space when the environment configures no AI', () => {
		expect(envEmbeddingSpace()).toBeNull();
	});

	it('matches a stored OpenAI embedder only through the native OpenAI endpoint', () => {
		vi.stubEnv('LLM_API_KEY', 'sk-env');
		const stored = storedEmbeddingSpace({ embeddingProviderKind: 'openai' });
		expect(isSameEmbeddingSpace(envEmbeddingSpace()!, stored)).toBe(true);

		vi.stubEnv('LLM_PROVIDER', 'openrouter');
		expect(envEmbeddingSpace()?.provider).toBe('env:openrouter');
		expect(isSameEmbeddingSpace(envEmbeddingSpace()!, stored)).toBe(false);

		vi.stubEnv('LLM_PROVIDER', undefined);
		vi.stubEnv('LLM_EMBEDDING_MODEL', 'text-embedding-3-large');
		expect(isSameEmbeddingSpace(envEmbeddingSpace()!, stored)).toBe(false);
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
