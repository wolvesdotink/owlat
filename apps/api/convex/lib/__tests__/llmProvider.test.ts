import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

describe('llmProvider', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllEnvs();
		mockCreateOpenAI.mockClear();
		mockOpenAIFactory.mockClear();
		mockOpenAIFactory.embedding.mockClear();
		// Reset return values
		mockCreateOpenAI.mockReturnValue(mockOpenAIFactory);
		mockOpenAIFactory.mockReturnValue(mockLanguageModel);
		mockOpenAIFactory.embedding.mockReturnValue(mockEmbeddingModel);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// ============ getLLMProvider ============

	describe('getLLMProvider', () => {
		it('should return a model for classify task (fast tier)', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			const { getLLMProvider } = await import('../llmProvider');
			const model = getLLMProvider('classify');
			expect(model).toBeDefined();
			expect(mockOpenAIFactory).toHaveBeenCalledWith('gpt-4o-mini');
		});

		it('should return a model for draft task (capable tier)', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			const { getLLMProvider } = await import('../llmProvider');
			const model = getLLMProvider('draft');
			expect(model).toBeDefined();
			expect(mockOpenAIFactory).toHaveBeenCalledWith('gpt-4o');
		});

		it('should route classify/extract/guard/summarize to fast tier', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			vi.stubEnv('LLM_MODEL_FAST', 'gpt-4o-mini-test');
			const { getLLMProvider } = await import('../llmProvider');

			for (const task of ['classify', 'extract', 'guard', 'summarize'] as const) {
				mockOpenAIFactory.mockClear();
				getLLMProvider(task);
				expect(mockOpenAIFactory).toHaveBeenCalledWith('gpt-4o-mini-test');
			}
		});

		it('should route draft/plan to capable tier', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			vi.stubEnv('LLM_MODEL_CAPABLE', 'gpt-4o-test');
			const { getLLMProvider } = await import('../llmProvider');

			for (const task of ['draft', 'plan'] as const) {
				mockOpenAIFactory.mockClear();
				getLLMProvider(task);
				expect(mockOpenAIFactory).toHaveBeenCalledWith('gpt-4o-test');
			}
		});

		it('should throw when no API key is set and provider is not ollama', async () => {
			// Ensure no API keys
			delete process.env['LLM_API_KEY'];
			delete process.env['OPENROUTER_API_KEY'];
			delete process.env['OPENAI_API_KEY'];

			const { getLLMProvider } = await import('../llmProvider');
			expect(() => getLLMProvider('classify')).toThrow('LLM API not configured');
		});

		it('should not throw when provider is ollama even without API key', async () => {
			vi.stubEnv('LLM_PROVIDER', 'ollama');
			delete process.env['LLM_API_KEY'];
			delete process.env['OPENROUTER_API_KEY'];
			delete process.env['OPENAI_API_KEY'];

			const { getLLMProvider } = await import('../llmProvider');
			expect(() => getLLMProvider('classify')).not.toThrow();
		});

		it('should use LLM_API_KEY over OPENAI_API_KEY', async () => {
			vi.stubEnv('LLM_API_KEY', 'primary-key');
			vi.stubEnv('OPENAI_API_KEY', 'fallback-key');
			const { getLLMProvider } = await import('../llmProvider');
			getLLMProvider('classify');
			expect(mockCreateOpenAI).toHaveBeenCalledWith(
				expect.objectContaining({ apiKey: 'primary-key' })
			);
		});

		it('should fall back to OPENROUTER_API_KEY then OPENAI_API_KEY', async () => {
			vi.stubEnv('OPENROUTER_API_KEY', 'router-key');
			delete process.env['LLM_API_KEY'];
			delete process.env['OPENAI_API_KEY'];
			const { getLLMProvider } = await import('../llmProvider');
			getLLMProvider('classify');
			expect(mockCreateOpenAI).toHaveBeenCalledWith(
				expect.objectContaining({ apiKey: 'router-key' })
			);
		});

		it('should use LLM_MODEL as fallback for fast tier when LLM_MODEL_FAST is not set', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			vi.stubEnv('LLM_MODEL', 'custom-model');
			delete process.env['LLM_MODEL_FAST'];
			const { getLLMProvider } = await import('../llmProvider');
			getLLMProvider('classify');
			expect(mockOpenAIFactory).toHaveBeenCalledWith('custom-model');
		});

		it('should default to draft task when no task is specified', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			const { getLLMProvider } = await import('../llmProvider');
			getLLMProvider();
			expect(mockOpenAIFactory).toHaveBeenCalledWith('gpt-4o');
		});
	});

	// ============ getLLMProviderForClassifiedDraft ============

	describe('getLLMProviderForClassifiedDraft', () => {
		const trivial = { category: 'other', intent: 'praise', priority: 'low', confidence: 0.95 };
		const complex = { category: 'support', intent: 'question', priority: 'high', confidence: 0.95 };

		it('keeps the capable tier when complexity routing is off (default), even for a trivial message', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			// LLM_COMPLEXITY_ROUTING unset ⇒ off
			const { getLLMProviderForClassifiedDraft } = await import('../llmProvider');
			getLLMProviderForClassifiedDraft(trivial);
			expect(mockOpenAIFactory).toHaveBeenCalledWith('gpt-4o');
		});

		it('downgrades a trivial message to the fast tier when routing is on', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			vi.stubEnv('LLM_COMPLEXITY_ROUTING', '1');
			const { getLLMProviderForClassifiedDraft } = await import('../llmProvider');
			getLLMProviderForClassifiedDraft(trivial);
			expect(mockOpenAIFactory).toHaveBeenCalledWith('gpt-4o-mini');
		});

		it('keeps a complex message on the capable tier even when routing is on', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			vi.stubEnv('LLM_COMPLEXITY_ROUTING', '1');
			const { getLLMProviderForClassifiedDraft } = await import('../llmProvider');
			getLLMProviderForClassifiedDraft(complex);
			expect(mockOpenAIFactory).toHaveBeenCalledWith('gpt-4o');
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

	// ============ getEmbeddingModel ============

	describe('getEmbeddingModel', () => {
		it('should return an embedding model', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			const { getEmbeddingModel } = await import('../llmProvider');
			const model = getEmbeddingModel();
			expect(model).toBeDefined();
			expect(mockOpenAIFactory.embedding).toHaveBeenCalledWith('text-embedding-3-small');
		});

		it('should use custom embedding model from env', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			// A 1536-dim model is honored as-is (matches the vector index width).
			vi.stubEnv('LLM_EMBEDDING_MODEL', 'text-embedding-ada-002');
			const { getEmbeddingModel } = await import('../llmProvider');
			getEmbeddingModel();
			expect(mockOpenAIFactory.embedding).toHaveBeenCalledWith('text-embedding-ada-002');
		});

		it('rejects a known embedding model whose dimension differs from the index', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			// text-embedding-3-large is 3072-dim and won't fit the 1536 index.
			vi.stubEnv('LLM_EMBEDDING_MODEL', 'text-embedding-3-large');
			const { getEmbeddingModel } = await import('../llmProvider');
			expect(() => getEmbeddingModel()).toThrow(/1536/);
		});

		it('should throw when no API key and provider is not ollama', async () => {
			delete process.env['LLM_API_KEY'];
			delete process.env['OPENROUTER_API_KEY'];
			delete process.env['OPENAI_API_KEY'];
			const { getEmbeddingModel } = await import('../llmProvider');
			expect(() => getEmbeddingModel()).toThrow('LLM API not configured');
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
			const [{ getEmbeddingModel }, { CURRENT_EMBEDDING_MODEL }] = await Promise.all([
				import('../llmProvider'),
				import('../constants'),
			]);
			getEmbeddingModel();
			expect(mockOpenAIFactory.embedding).toHaveBeenCalledWith(CURRENT_EMBEDDING_MODEL);
		});
	});
});
