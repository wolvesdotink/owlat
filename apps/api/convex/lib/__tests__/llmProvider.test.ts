import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';

// Mock @ai-sdk/openai before importing the module under test
const mockLanguageModel = { modelId: '', provider: 'openai' };
const mockEmbeddingModel = { modelId: '', provider: 'openai' };
const mockOpenAIFactory = vi.fn().mockReturnValue(mockLanguageModel) as ReturnType<typeof vi.fn> & {
	embedding: ReturnType<typeof vi.fn>;
};
mockOpenAIFactory.embedding = vi.fn().mockReturnValue(mockEmbeddingModel);
const mockCreateOpenAI = vi.fn().mockReturnValue(mockOpenAIFactory);

vi.mock('@ai-sdk/openai', () => ({
	createOpenAI: mockCreateOpenAI,
}));

// The `openaiCompatible` / `local` adapters build through `@ai-sdk/openai-compatible`.
// Stub its SDK: the client is callable (chat) AND exposes `.textEmbeddingModel`
// (the local embedding plane), so the test doesn't depend on the real package.
const mockCompatEmbeddingModel = { modelId: '', provider: 'openai-compatible' };
const mockCompatTextEmbedding = vi.fn().mockReturnValue(mockCompatEmbeddingModel);
const mockCompatClient = Object.assign(vi.fn().mockReturnValue(mockLanguageModel), {
	textEmbeddingModel: mockCompatTextEmbedding,
});
const mockCreateOpenAICompatible = vi.fn().mockReturnValue(mockCompatClient);
vi.mock('@ai-sdk/openai-compatible', () => ({
	createOpenAICompatible: mockCreateOpenAICompatible,
}));

/** A mock ActionCtx whose `_getConfigRow` returns `row` and decrypt yields a key. */
function makeCtx(row: Doc<'aiProviderConfig'> | null) {
	const runQuery = vi.fn(async () => row);
	const runAction = vi.fn(async () => 'decrypted-key');
	const ctx = { runQuery, runAction } as unknown as ActionCtx;
	return { ctx, runQuery, runAction };
}

/** A minimal stored config row, overridable per field. */
function storedRow(over: Partial<Doc<'aiProviderConfig'>> = {}): Doc<'aiProviderConfig'> {
	return {
		_id: 'cfg1' as Doc<'aiProviderConfig'>['_id'],
		_creationTime: 0,
		languageProviderKind: 'openai',
		modelFast: 'stored-fast',
		modelCapable: 'stored-capable',
		embeddingProviderKind: 'local',
		embeddingModelVersion: 1,
		updatedAt: 123,
		...over,
	} as Doc<'aiProviderConfig'>;
}

describe('llmProvider', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllEnvs();
		mockCreateOpenAI.mockClear();
		mockOpenAIFactory.mockClear();
		mockOpenAIFactory.embedding.mockClear();
		mockCreateOpenAICompatible.mockClear();
		mockCompatClient.mockClear();
		mockCompatTextEmbedding.mockClear();
		// Reset return values
		mockCreateOpenAI.mockReturnValue(mockOpenAIFactory);
		mockOpenAIFactory.mockReturnValue(mockLanguageModel);
		mockOpenAIFactory.embedding.mockReturnValue(mockEmbeddingModel);
		mockCreateOpenAICompatible.mockReturnValue(mockCompatClient);
		mockCompatClient.mockReturnValue(mockLanguageModel);
		mockCompatTextEmbedding.mockReturnValue(mockCompatEmbeddingModel);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// ============ resolveLanguageModel (env fallback path) ============

	describe('resolveLanguageModel — env fallback', () => {
		it('returns a fast-tier model for classify', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			const { resolveLanguageModel } = await import('../llmProvider');
			const { ctx } = makeCtx(null);
			const model = await resolveLanguageModel(ctx, 'classify');
			expect(model).toBeDefined();
			expect(mockOpenAIFactory).toHaveBeenCalledWith('gpt-4o-mini');
		});

		it('returns a capable-tier model for draft', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			const { resolveLanguageModel } = await import('../llmProvider');
			const { ctx } = makeCtx(null);
			const model = await resolveLanguageModel(ctx, 'draft');
			expect(model).toBeDefined();
			expect(mockOpenAIFactory).toHaveBeenCalledWith('gpt-4o');
		});

		it('routes classify/extract/guard/summarize to the fast tier', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			vi.stubEnv('LLM_MODEL_FAST', 'gpt-4o-mini-test');
			const { resolveLanguageModel } = await import('../llmProvider');
			const { ctx } = makeCtx(null);
			for (const task of ['classify', 'extract', 'guard', 'summarize'] as const) {
				mockOpenAIFactory.mockClear();
				await resolveLanguageModel(ctx, task);
				expect(mockOpenAIFactory).toHaveBeenCalledWith('gpt-4o-mini-test');
			}
		});

		it('routes draft/plan to the capable tier', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			vi.stubEnv('LLM_MODEL_CAPABLE', 'gpt-4o-test');
			const { resolveLanguageModel } = await import('../llmProvider');
			const { ctx } = makeCtx(null);
			for (const task of ['draft', 'plan'] as const) {
				mockOpenAIFactory.mockClear();
				await resolveLanguageModel(ctx, task);
				expect(mockOpenAIFactory).toHaveBeenCalledWith('gpt-4o-test');
			}
		});

		it('throws when no API key is set and the provider is not ollama', async () => {
			delete process.env['LLM_API_KEY'];
			delete process.env['OPENROUTER_API_KEY'];
			delete process.env['OPENAI_API_KEY'];
			const { resolveLanguageModel } = await import('../llmProvider');
			const { ctx } = makeCtx(null);
			await expect(resolveLanguageModel(ctx, 'classify')).rejects.toThrow('LLM API not configured');
		});

		it('does not throw for ollama even without an API key', async () => {
			vi.stubEnv('LLM_PROVIDER', 'ollama');
			delete process.env['LLM_API_KEY'];
			delete process.env['OPENROUTER_API_KEY'];
			delete process.env['OPENAI_API_KEY'];
			const { resolveLanguageModel } = await import('../llmProvider');
			const { ctx } = makeCtx(null);
			await expect(resolveLanguageModel(ctx, 'classify')).resolves.toBeDefined();
		});

		it('prefers LLM_API_KEY over OPENAI_API_KEY', async () => {
			vi.stubEnv('LLM_API_KEY', 'primary-key');
			vi.stubEnv('OPENAI_API_KEY', 'fallback-key');
			const { resolveLanguageModel } = await import('../llmProvider');
			const { ctx } = makeCtx(null);
			await resolveLanguageModel(ctx, 'classify');
			expect(mockCreateOpenAI).toHaveBeenCalledWith(
				expect.objectContaining({ apiKey: 'primary-key' })
			);
		});

		it('defaults to the draft task when none is specified', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			const { resolveLanguageModel } = await import('../llmProvider');
			const { ctx } = makeCtx(null);
			await resolveLanguageModel(ctx);
			expect(mockOpenAIFactory).toHaveBeenCalledWith('gpt-4o');
		});
	});

	// ============ resolveAiConfig (dual source + memoization) ============

	describe('resolveAiConfig', () => {
		it('falls back to env when no stored row exists', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'env-key');
			const { resolveAiConfig } = await import('../llmProvider');
			const { ctx, runAction } = makeCtx(null);
			const cfg = await resolveAiConfig(ctx);
			expect(cfg.source).toBe('env');
			expect(cfg.language.kind).toBe('openai');
			expect(cfg.language.models.capable).toBe('gpt-4o');
			expect(cfg.language.clientConfig.apiKey).toBe('env-key');
			// No stored hosted key ⇒ the Node decrypt action is never invoked.
			expect(runAction).not.toHaveBeenCalled();
		});

		it('prefers the stored hosted config over env and decrypts via the Node action', async () => {
			// Env is configured too — the stored row must still win.
			vi.stubEnv('OPENAI_API_KEY', 'env-key');
			const { resolveAiConfig } = await import('../llmProvider');
			const { ctx, runAction } = makeCtx(
				storedRow({
					languageProviderKind: 'openai',
					modelFast: 'stored-fast',
					modelCapable: 'stored-capable',
					secretCiphertext: 'ct',
					secretIv: 'iv',
					secretAuthTag: 'tag',
					secretEnvelopeVersion: 1,
				})
			);
			const cfg = await resolveAiConfig(ctx);
			expect(cfg.source).toBe('stored');
			expect(cfg.language.models.fast).toBe('stored-fast');
			expect(cfg.language.models.capable).toBe('stored-capable');
			// The plaintext key came back from the Node decrypt action, not env.
			expect(cfg.language.clientConfig.apiKey).toBe('decrypted-key');
			expect(runAction).toHaveBeenCalledTimes(1);
		});

		it('resolves a stored local provider without decrypting (keyless)', async () => {
			const { resolveAiConfig } = await import('../llmProvider');
			const { ctx, runAction } = makeCtx(
				storedRow({
					languageProviderKind: 'openaiCompatible',
					languageBaseUrl: 'http://localhost:11434/v1',
					modelFast: 'local-fast',
					modelCapable: 'local-capable',
				})
			);
			const cfg = await resolveAiConfig(ctx);
			expect(cfg.source).toBe('stored');
			expect(cfg.language.kind).toBe('openaiCompatible');
			expect(cfg.language.clientConfig.baseUrl).toBe('http://localhost:11434/v1');
			expect(cfg.language.clientConfig.apiKey).toBeUndefined();
			expect(runAction).not.toHaveBeenCalled();
		});

		it('memoizes within the TTL and re-reads after a cache reset', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'env-key');
			const { resolveAiConfig, __resetAiConfigCacheForTests } = await import('../llmProvider');
			const { ctx, runQuery } = makeCtx(null);
			await resolveAiConfig(ctx);
			await resolveAiConfig(ctx);
			// Second call is served from the in-process cache — no second read.
			expect(runQuery).toHaveBeenCalledTimes(1);
			__resetAiConfigCacheForTests();
			await resolveAiConfig(ctx);
			expect(runQuery).toHaveBeenCalledTimes(2);
		});
	});

	// ============ resolveLanguageModelForClassifiedDraft ============

	describe('resolveLanguageModelForClassifiedDraft', () => {
		const trivial = { category: 'other', intent: 'praise', priority: 'low', confidence: 0.95 };
		const complex = { category: 'support', intent: 'question', priority: 'high', confidence: 0.95 };

		it('keeps the capable tier when complexity routing is off (default)', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			const { resolveLanguageModelForClassifiedDraft } = await import('../llmProvider');
			const { ctx } = makeCtx(null);
			await resolveLanguageModelForClassifiedDraft(ctx, trivial);
			expect(mockOpenAIFactory).toHaveBeenCalledWith('gpt-4o');
		});

		it('downgrades a trivial message to the fast tier when routing is on', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			vi.stubEnv('LLM_COMPLEXITY_ROUTING', '1');
			const { resolveLanguageModelForClassifiedDraft } = await import('../llmProvider');
			const { ctx } = makeCtx(null);
			await resolveLanguageModelForClassifiedDraft(ctx, trivial);
			expect(mockOpenAIFactory).toHaveBeenCalledWith('gpt-4o-mini');
		});

		it('keeps a complex message on the capable tier even when routing is on', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			vi.stubEnv('LLM_COMPLEXITY_ROUTING', '1');
			const { resolveLanguageModelForClassifiedDraft } = await import('../llmProvider');
			const { ctx } = makeCtx(null);
			await resolveLanguageModelForClassifiedDraft(ctx, complex);
			expect(mockOpenAIFactory).toHaveBeenCalledWith('gpt-4o');
		});
	});

	// ============ rename surface ============

	describe('resolver export surface', () => {
		it('no longer exports the former sync getLLMProvider* names', async () => {
			const mod = await import('../llmProvider');
			expect('getLLMProvider' in mod).toBe(false);
			expect('getLLMProviderForUserText' in mod).toBe(false);
			expect('getLLMProviderForClassifiedDraft' in mod).toBe(false);
			expect(typeof mod.resolveLanguageModel).toBe('function');
			expect(typeof mod.resolveAiConfig).toBe('function');
		});
	});

	// ============ getLLMConfig ============

	describe('getLLMConfig', () => {
		it('should return config metadata with defaults', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			const { getLLMConfig } = await import('../llmProvider');
			const config = getLLMConfig();

			expect(config.provider).toBe('openai');
			expect(config.modelFast).toBe('gpt-4o-mini');
			expect(config.modelCapable).toBe('gpt-4o');
			expect(config.embeddingModel).toBe('text-embedding-3-small');
			expect(config.hasApiKey).toBe(true);
		});

		it('should reflect custom environment variables', async () => {
			vi.stubEnv('LLM_PROVIDER', 'openrouter');
			vi.stubEnv('LLM_MODEL_FAST', 'fast-model');
			vi.stubEnv('LLM_MODEL_CAPABLE', 'capable-model');
			vi.stubEnv('LLM_EMBEDDING_MODEL', 'custom-embed');
			vi.stubEnv('LLM_API_KEY', 'my-key');
			const { getLLMConfig } = await import('../llmProvider');
			const config = getLLMConfig();

			expect(config.provider).toBe('openrouter');
			expect(config.modelFast).toBe('fast-model');
			expect(config.modelCapable).toBe('capable-model');
			expect(config.embeddingModel).toBe('custom-embed');
			expect(config.baseURL).toBe('https://openrouter.ai/api/v1');
			expect(config.hasApiKey).toBe(true);
		});

		it('should report hasApiKey as false when no keys set', async () => {
			delete process.env['LLM_API_KEY'];
			delete process.env['OPENROUTER_API_KEY'];
			delete process.env['OPENAI_API_KEY'];
			const { getLLMConfig } = await import('../llmProvider');
			const config = getLLMConfig();
			expect(config.hasApiKey).toBe(false);
		});
	});

	// ============ resolveEmbeddingModel — env fallback ============

	describe('resolveEmbeddingModel — env fallback', () => {
		it('resolves the default embedding model via the openai adapter', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			const { resolveEmbeddingModel } = await import('../llmProvider');
			const { ctx } = makeCtx(null);
			const model = await resolveEmbeddingModel(ctx);
			expect(model).toBeDefined();
			expect(mockOpenAIFactory.embedding).toHaveBeenCalledWith('text-embedding-3-small');
		});

		it('honors a custom LLM_EMBEDDING_MODEL from env', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			// A 1536-dim model is honored as-is (matches the vector index width).
			vi.stubEnv('LLM_EMBEDDING_MODEL', 'text-embedding-ada-002');
			const { resolveEmbeddingModel } = await import('../llmProvider');
			const { ctx } = makeCtx(null);
			await resolveEmbeddingModel(ctx);
			expect(mockOpenAIFactory.embedding).toHaveBeenCalledWith('text-embedding-ada-002');
		});

		it('rejects a known embedding model whose dimension differs from the index', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			// text-embedding-3-large is 3072-dim and won't fit the 1536 index.
			vi.stubEnv('LLM_EMBEDDING_MODEL', 'text-embedding-3-large');
			const { resolveEmbeddingModel } = await import('../llmProvider');
			const { ctx } = makeCtx(null);
			await expect(resolveEmbeddingModel(ctx)).rejects.toThrow(/1536/);
		});

		it('throws when no API key and provider is not ollama', async () => {
			delete process.env['LLM_API_KEY'];
			delete process.env['OPENROUTER_API_KEY'];
			delete process.env['OPENAI_API_KEY'];
			const { resolveEmbeddingModel } = await import('../llmProvider');
			const { ctx } = makeCtx(null);
			await expect(resolveEmbeddingModel(ctx)).rejects.toThrow('LLM API not configured');
		});
	});

	// ============ resolveEmbeddingModel — local-by-default embedding plane ============

	describe('resolveEmbeddingModel — stored config (two decoupled planes)', () => {
		it('resolves the LOCAL embedder by default under an Anthropic language config', async () => {
			// Anthropic has no embeddings API, so retrieval must still work via the
			// local-by-default embedding plane — resolved INDEPENDENTLY of language.
			vi.stubEnv('LOCAL_EMBEDDING_BASE_URL', 'http://ollama:11434/v1');
			const { resolveEmbeddingModel } = await import('../llmProvider');
			const { ctx, runAction } = makeCtx(
				storedRow({
					languageProviderKind: 'anthropic',
					secretCiphertext: 'ct',
					secretIv: 'iv',
					secretAuthTag: 'tag',
					secretEnvelopeVersion: 1,
					embeddingProviderKind: 'local',
				})
			);
			const model = await resolveEmbeddingModel(ctx);
			expect(model).toBe(mockCompatEmbeddingModel);
			// Built through the OpenAI-compatible sidecar at the local base URL,
			// using the default local model, with NO OpenAI embedding call.
			expect(mockCreateOpenAICompatible).toHaveBeenCalledWith(
				expect.objectContaining({ baseURL: 'http://ollama:11434/v1' })
			);
			expect(mockCompatTextEmbedding).toHaveBeenCalledWith('nomic-embed-text');
			expect(mockOpenAIFactory.embedding).not.toHaveBeenCalled();
			// The local embedder is keyless — only the hosted LANGUAGE key is decrypted.
			expect(runAction).toHaveBeenCalledTimes(1);
		});

		it('honors LOCAL_EMBEDDING_MODEL for the local plane', async () => {
			vi.stubEnv('LOCAL_EMBEDDING_BASE_URL', 'http://ollama:11434/v1');
			vi.stubEnv('LOCAL_EMBEDDING_MODEL', 'mxbai-embed-large');
			const { resolveEmbeddingModel } = await import('../llmProvider');
			const { ctx } = makeCtx(storedRow({ embeddingProviderKind: 'local' }));
			await resolveEmbeddingModel(ctx);
			expect(mockCompatTextEmbedding).toHaveBeenCalledWith('mxbai-embed-large');
		});

		it('resolves a HOSTED embedder override, decrypting its own key', async () => {
			const { resolveEmbeddingModel } = await import('../llmProvider');
			const { ctx, runAction } = makeCtx(
				storedRow({
					languageProviderKind: 'anthropic', // keyless-in-this-test (no lang envelope)
					embeddingProviderKind: 'openai',
					embeddingModel: 'text-embedding-3-small',
					embeddingSecretCiphertext: 'ect',
					embeddingSecretIv: 'eiv',
					embeddingSecretAuthTag: 'etag',
					embeddingSecretEnvelopeVersion: 1,
				})
			);
			const model = await resolveEmbeddingModel(ctx);
			expect(model).toBe(mockEmbeddingModel);
			expect(mockCreateOpenAI).toHaveBeenCalledWith(
				expect.objectContaining({ apiKey: 'decrypted-key' })
			);
			expect(mockOpenAIFactory.embedding).toHaveBeenCalledWith('text-embedding-3-small');
			// Only the embedding key is decrypted (the anthropic language row has no key).
			expect(runAction).toHaveBeenCalledTimes(1);
		});

		it('raises an ACTIONABLE error for a hosted embedder with no key (never an empty vector)', async () => {
			const { resolveEmbeddingModel } = await import('../llmProvider');
			// Hosted embedder selected but no embedding key envelope stored.
			const { ctx } = makeCtx(
				storedRow({ languageProviderKind: 'openaiCompatible', embeddingProviderKind: 'openai' })
			);
			await expect(resolveEmbeddingModel(ctx)).rejects.toThrow(/API key/i);
			// It failed BEFORE building any embedding model — no silent empty vector.
			expect(mockOpenAIFactory.embedding).not.toHaveBeenCalled();
		});
	});

	// ============ embedding-model provenance invariant ============

	describe('default embedding model provenance', () => {
		it('resolves the same model id that gets stamped on rows (CURRENT_EMBEDDING_MODEL)', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			delete process.env['LLM_EMBEDDING_MODEL'];
			const [{ getLLMConfig }, { CURRENT_EMBEDDING_MODEL }] = await Promise.all([
				import('../llmProvider'),
				import('../constants'),
			]);
			// The resolved default must equal the stamped provenance constant, or
			// rows are tagged with a model the provider never used — breaking the
			// schema's "re-embed when the model changes" invariant.
			expect(getLLMConfig().embeddingModel).toBe(CURRENT_EMBEDDING_MODEL);
		});

		it('builds the default embedding model from CURRENT_EMBEDDING_MODEL', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			delete process.env['LLM_EMBEDDING_MODEL'];
			const [{ resolveEmbeddingModel }, { CURRENT_EMBEDDING_MODEL }] = await Promise.all([
				import('../llmProvider'),
				import('../constants'),
			]);
			const { ctx } = makeCtx(null);
			await resolveEmbeddingModel(ctx);
			expect(mockOpenAIFactory.embedding).toHaveBeenCalledWith(CURRENT_EMBEDDING_MODEL);
		});
	});
});
