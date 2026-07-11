import { describe, it, expect } from 'vitest';
import {
	CUSTOM_MODEL_VALUE,
	EMBEDDING_PROVIDERS,
	LANGUAGE_PROVIDERS,
	embeddingProviderMeta,
	embeddingProviderOptions,
	languageProviderMeta,
	languageProviderOptions,
	languageProviderRequiresKey,
	mergeLiveModels,
	modelOptions,
	resolveModelId,
	testConnectionReducer,
	validateLanguageConfig,
	type TestConnectionState,
} from '../aiProviders';

describe('provider catalog', () => {
	it('exposes exactly the six language kinds and four embedding kinds', () => {
		expect(LANGUAGE_PROVIDERS.map((p) => p.kind)).toEqual([
			'openai',
			'anthropic',
			'google',
			'azure',
			'openrouter',
			'openaiCompatible',
		]);
		expect(EMBEDDING_PROVIDERS.map((p) => p.kind)).toEqual([
			'local',
			'openai',
			'google',
			'openaiCompatible',
		]);
	});

	it('marks only openaiCompatible as a local language provider (base URL, no docs)', () => {
		const local = languageProviderMeta('openaiCompatible');
		expect(local?.isLocal).toBe(true);
		expect(local?.defaultBaseUrl).toBeTruthy();
		expect(local?.docsUrl).toBeUndefined();
		expect(languageProviderMeta('openai')?.isLocal).toBe(false);
		expect(languageProviderMeta('openai')?.docsUrl).toBeTruthy();
	});

	it('defaults the embedding plane to a keyless local provider first', () => {
		const first = EMBEDDING_PROVIDERS[0];
		expect(first?.kind).toBe('local');
		expect(first?.isLocal).toBe(true);
	});

	it('returns undefined metadata for unknown kinds', () => {
		expect(languageProviderMeta('nope')).toBeUndefined();
		expect(embeddingProviderMeta('nope')).toBeUndefined();
	});
});

describe('select options', () => {
	it('maps providers to value/label options', () => {
		expect(languageProviderOptions()).toContainEqual({
			value: 'anthropic',
			label: 'Anthropic (Claude)',
		});
		expect(embeddingProviderOptions()[0]).toEqual({
			value: 'local',
			label: 'Local (bundled) — no setup needed',
		});
	});
});

describe('languageProviderRequiresKey — local hides the key field', () => {
	it('is false for the local provider and true for hosted ones', () => {
		expect(languageProviderRequiresKey('openaiCompatible')).toBe(false);
		expect(languageProviderRequiresKey('openai')).toBe(true);
		expect(languageProviderRequiresKey('anthropic')).toBe(true);
	});

	it('treats an unknown kind as not requiring a key', () => {
		expect(languageProviderRequiresKey('mystery')).toBe(false);
	});
});

describe('modelOptions — model-picker option mapping', () => {
	it('maps curated ids and always appends the custom sentinel last', () => {
		const opts = modelOptions(['gpt-4o', 'gpt-4o-mini'], '');
		expect(opts).toEqual([
			{ value: 'gpt-4o', label: 'gpt-4o' },
			{ value: 'gpt-4o-mini', label: 'gpt-4o-mini' },
			{ value: CUSTOM_MODEL_VALUE, label: 'Custom model id…' },
		]);
	});

	it('injects the current value when it is not among the curated ids', () => {
		const opts = modelOptions(['gpt-4o'], 'ft:my-model');
		expect(opts).toContainEqual({ value: 'ft:my-model', label: 'ft:my-model (current)' });
		// current is inserted before the sentinel
		expect(opts.at(-1)?.value).toBe(CUSTOM_MODEL_VALUE);
	});

	it('does not duplicate a current value already in the curated list', () => {
		const opts = modelOptions(['gpt-4o', 'gpt-4o-mini'], 'gpt-4o');
		expect(opts.filter((o) => o.value === 'gpt-4o')).toHaveLength(1);
	});

	it('ignores an empty or sentinel current value', () => {
		expect(modelOptions(['a'], '')).toHaveLength(2);
		expect(modelOptions(['a'], CUSTOM_MODEL_VALUE)).toHaveLength(2);
	});
});

describe('mergeLiveModels — live catalog merged into curated', () => {
	it('appends live ids not already curated, order-stable and de-duplicated', () => {
		expect(mergeLiveModels(['gpt-4o', 'gpt-4o-mini'], ['gpt-4o', 'o3', 'o3'])).toEqual([
			'gpt-4o',
			'gpt-4o-mini',
			'o3',
		]);
	});

	it('returns a copy of curated when there is no live catalog', () => {
		const curated = ['llama3.1'] as const;
		const merged = mergeLiveModels(curated, []);
		expect(merged).toEqual(['llama3.1']);
		expect(merged).not.toBe(curated);
	});

	it('drops empty-string live ids', () => {
		expect(mergeLiveModels([], ['', 'qwen2.5'])).toEqual(['qwen2.5']);
	});
});

describe('resolveModelId', () => {
	it('returns the chosen id verbatim when not the sentinel', () => {
		expect(resolveModelId('gpt-4o', 'ignored')).toBe('gpt-4o');
	});

	it('returns the trimmed custom text when the sentinel is chosen', () => {
		expect(resolveModelId(CUSTOM_MODEL_VALUE, '  my-model  ')).toBe('my-model');
	});
});

describe('validateLanguageConfig', () => {
	it('passes a local provider with no key', () => {
		expect(
			validateLanguageConfig({ kind: 'openaiCompatible', hasStoredKey: false, apiKey: '' })
		).toBeNull();
	});

	it('rejects a hosted provider with neither a stored nor a typed key', () => {
		const err = validateLanguageConfig({ kind: 'openai', hasStoredKey: false, apiKey: '   ' });
		expect(err).toBe('OpenAI needs an API key. Paste one above to continue.');
	});

	it('passes a hosted provider when a key is stored', () => {
		expect(
			validateLanguageConfig({ kind: 'anthropic', hasStoredKey: true, apiKey: '' })
		).toBeNull();
	});

	it('passes a hosted provider when a key is freshly typed', () => {
		expect(
			validateLanguageConfig({ kind: 'google', hasStoredKey: false, apiKey: 'sk-abc' })
		).toBeNull();
	});

	it('requires Azure to carry its resource base URL even with a key', () => {
		const err = validateLanguageConfig({
			kind: 'azure',
			hasStoredKey: true,
			apiKey: '',
			baseUrl: '  ',
		});
		expect(err).toBe('Azure OpenAI needs its resource base URL. Add it above to continue.');
	});

	it('passes Azure when both a key and a base URL are present', () => {
		expect(
			validateLanguageConfig({
				kind: 'azure',
				hasStoredKey: false,
				apiKey: 'k',
				baseUrl: 'https://acme.openai.azure.com/openai',
			})
		).toBeNull();
	});
});

describe('testConnectionReducer — Test-connection state machine', () => {
	it('enters testing on start from any state', () => {
		expect(testConnectionReducer({ status: 'idle' }, { type: 'start' })).toEqual({
			status: 'testing',
		});
		expect(testConnectionReducer({ status: 'ok' }, { type: 'start' })).toEqual({
			status: 'testing',
		});
	});

	it('transitions testing → ok on a successful result', () => {
		expect(testConnectionReducer({ status: 'testing' }, { type: 'result', ok: true })).toEqual({
			status: 'ok',
		});
	});

	it('transitions testing → error carrying the message', () => {
		expect(
			testConnectionReducer({ status: 'testing' }, { type: 'result', ok: false, error: 'bad key' })
		).toEqual({ status: 'error', message: 'bad key' });
	});

	it('supplies a fallback message when the backend omits one', () => {
		expect(testConnectionReducer({ status: 'testing' }, { type: 'result', ok: false })).toEqual({
			status: 'error',
			message: 'Connection test failed.',
		});
	});

	it('ignores a stray result that arrives when not testing', () => {
		const idle: TestConnectionState = { status: 'idle' };
		expect(testConnectionReducer(idle, { type: 'result', ok: true })).toBe(idle);
	});
});
