/**
 * Browser-safe model defaults, shared by adapters and settings/setup clients.
 * Reviewed 2026-10-11 against provider catalogs. Defaults are explicit IDs:
 * changing them does not rewrite an operator's saved configuration.
 * Azure IDs are deployment-name suggestions; local IDs must be installed.
 */
export const LANGUAGE_MODEL_CATALOG = {
	openai: {
		defaults: { fast: 'gpt-6-luna', capable: 'gpt-6.1-sol' },
		models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'],
	},
	anthropic: {
		defaults: { fast: 'claude-haiku-5-5', capable: 'claude-sonnet-5-5' },
		models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'],
	},
	google: {
		defaults: { fast: 'gemini-3.5-flash-lite', capable: 'gemini-3.8-flash' },
		models: ['gemini-3.5-flash-lite', 'gemini-3.8-flash'],
	},
	azure: {
		defaults: { fast: 'gpt-6-luna', capable: 'gpt-6.1-sol' },
		models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'],
	},
	openrouter: {
		defaults: { fast: 'openai/gpt-6-luna', capable: 'anthropic/claude-sonnet-5.5' },
		models: [
			'openai/gpt-6-luna',
			'anthropic/claude-haiku-5.5',
			'anthropic/claude-sonnet-5.5',
			'anthropic/claude-opus-5.5',
			'openai/gpt-6.1-sol',
			'google/gemini-3.8-flash',
			'deepseek/deepseek-v4-flash',
			'deepseek/deepseek-v4-pro',
		],
	},
	openaiCompatible: {
		// Both tiers use the smaller current Qwen variant (18–19 GB weights).
		// Operators with less memory should choose an installed smaller model.
		defaults: { fast: 'qwen3.6:27b', capable: 'qwen3.6:27b' },
		models: ['qwen3.6:27b', 'qwen3.6:35b'],
	},
} as const;

export const GOOGLE_EMBEDDING_DEFAULT = { model: 'gemini-embedding-2', dimensions: 768 } as const;

/** Old rows omitted the model ID. Resolve their implicit choice without changing vector spaces. */
export const LEGACY_GOOGLE_EMBEDDING_MODEL = 'text-embedding-004';
