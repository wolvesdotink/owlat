/**
 * Frontend catalog + pure helpers for the AI-provider settings page
 * (`pages/dashboard/admin/instance/ai-provider.vue`).
 *
 * A presentational MIRROR of the backend adapter registry
 * (`apps/api/convex/lib/llmProviders/*`). The page runs in the browser and can't
 * import the Node / AI-SDK adapters, so the labels, "get a key" links, and the
 * default model ids the form reveals live here. The backend stays the single
 * source of truth for provider *behaviour*; this module is only the copy +
 * defaults the UI shows. Adding a provider is one entry here + one adapter file
 * there (per the 2026-07-10 pluggable-AI-providers plan, locked decision 4).
 *
 * Two decoupled planes (locked decision 1): a LANGUAGE plane (fully pluggable —
 * hosted or local) and an EMBEDDING plane (local by default, hosted override).
 *
 * Everything here is pure and framework-free so it is unit-tested directly
 * (`__tests__/aiProviders.test.ts`) — no component mount needed.
 */

/** Message-key root for this module; see `i18n/locales/en.json`. */
const K = 'shared.aiProviders';

/**
 * Registry-owned copy carries message KEYS, never sentences: this module is a
 * module-scope catalog, so it cannot call `useI18n`. A message that interpolates
 * a value travels as its key plus those values; the component that renders it is
 * what translates (`t(value)` / `t(value.key, value.params)`).
 */
export type AiProviderText = string | { key: string; params?: Record<string, unknown> };

/** Language provider kinds — mirrors `LANGUAGE_PROVIDER_KINDS` in the backend. */
export type LanguageProviderKind =
	| 'openai'
	| 'anthropic'
	| 'google'
	| 'azure'
	| 'openrouter'
	| 'openaiCompatible';

/** Embedding provider kinds — mirrors `EMBEDDING_PROVIDER_KINDS` in the backend. */
export type EmbeddingProviderKind = 'local' | 'openai' | 'google' | 'openaiCompatible';

/**
 * A `{ value, label }` option for `UiSelect`. `label` is a message key (or a
 * `{ key, params }` pair) wherever it is copy, and a verbatim id — a model id —
 * wherever it is data; the renderer runs it through `t(…)` either way.
 */
export interface SelectOption {
	value: string;
	label: AiProviderText;
}

/** Presentational metadata for one language provider. */
export interface LanguageProviderMeta {
	kind: LanguageProviderKind;
	/** Message key for the label shown in the provider dropdown. */
	label: string;
	/** True for locally-hosted backends (keyless, base-URL driven). */
	isLocal: boolean;
	/** Where to send the admin to get / manage a key. Absent for local. */
	docsUrl?: string;
	/** Default base URL a local provider ships with (an Ollama/vLLM endpoint). */
	defaultBaseUrl?: string;
	/**
	 * Hosted provider that STILL needs an explicit base URL (e.g. Azure's resource
	 * endpoint). The base-URL field is shown by default and required at save.
	 */
	requiresBaseUrl?: boolean;
	/** Per-tier default model ids used when none is entered. */
	defaultModels: { fast: string; capable: string };
	/** Curated model ids offered in the dropdown before the free-text override. */
	curatedModels: readonly string[];
	/**
	 * True when the backend adapter implements `listModels` (OpenRouter's `/models`
	 * or a local server's `/models`), so the settings page can offer a "Load
	 * available models" action to populate the picker with the live catalog.
	 */
	supportsModelListing?: boolean;
	/** Message key for the one-line hint shown under the provider select. */
	hint: string;
}

/** Presentational metadata for one embedding provider. */
export interface EmbeddingProviderMeta {
	kind: EmbeddingProviderKind;
	/** Message key for the label shown in the embedding-provider dropdown. */
	label: string;
	isLocal: boolean;
	/** Native embedding width — shown so an admin sees the re-index implication. */
	dimensions: number;
	defaultModel: string;
	curatedModels: readonly string[];
}

/**
 * The language provider catalog. Values mirror the backend adapters' `label` /
 * `docsUrl` / `defaultBaseUrl` / `defaultModels`. `openaiCompatible` is the
 * local (keyless, base-URL) option; the rest are hosted (encrypted key).
 */
export const LANGUAGE_PROVIDERS: readonly LanguageProviderMeta[] = [
	{
		kind: 'openai',
		label: `${K}.providers.openai.label`,
		isLocal: false,
		docsUrl: 'https://platform.openai.com/api-keys',
		defaultModels: { fast: 'gpt-5.6-luna', capable: 'gpt-5.6-sol' },
		curatedModels: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
		hint: `${K}.providers.openai.hint`,
	},
	{
		kind: 'anthropic',
		label: `${K}.providers.anthropic.label`,
		isLocal: false,
		docsUrl: 'https://console.anthropic.com/settings/keys',
		defaultModels: { fast: 'claude-haiku-4-5', capable: 'claude-opus-4-8' },
		curatedModels: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
		hint: `${K}.providers.anthropic.hint`,
	},
	{
		kind: 'google',
		label: `${K}.providers.google.label`,
		isLocal: false,
		docsUrl: 'https://aistudio.google.com/app/apikey',
		defaultModels: { fast: 'gemini-3.1-flash-lite', capable: 'gemini-3.5-flash' },
		curatedModels: [
			'gemini-3.5-flash',
			'gemini-3.1-pro-preview',
			'gemini-3.1-flash-lite',
			'gemini-2.5-flash',
		],
		hint: `${K}.providers.google.hint`,
	},
	{
		kind: 'azure',
		label: `${K}.providers.azure.label`,
		isLocal: false,
		docsUrl: 'https://learn.microsoft.com/azure/ai-services/openai/',
		requiresBaseUrl: true,
		defaultBaseUrl: 'https://<resource>.openai.azure.com/openai',
		defaultModels: { fast: 'gpt-5.6-luna', capable: 'gpt-5.6-sol' },
		curatedModels: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
		hint: `${K}.providers.azure.hint`,
	},
	{
		kind: 'openrouter',
		label: `${K}.providers.openrouter.label`,
		isLocal: false,
		docsUrl: 'https://openrouter.ai/keys',
		defaultModels: { fast: 'deepseek/deepseek-v4-flash', capable: 'anthropic/claude-sonnet-5' },
		// The platform's most-used models (per openrouter.ai/rankings), most popular
		// first within each tier — not a mirror of the native provider catalogs.
		curatedModels: [
			'anthropic/claude-sonnet-5',
			'anthropic/claude-opus-4.8',
			'deepseek/deepseek-v4-flash',
			'deepseek/deepseek-v4-pro',
			'openai/gpt-5.6-sol',
			'openai/gpt-5.6-luna',
			'google/gemini-3.5-flash',
			'minimax/minimax-m3',
			'xiaomi/mimo-v2.5-pro',
			'moonshotai/kimi-k2.6',
		],
		supportsModelListing: true,
		hint: `${K}.providers.openrouter.hint`,
	},
	{
		kind: 'openaiCompatible',
		label: `${K}.providers.openaiCompatible.label`,
		isLocal: true,
		defaultBaseUrl: 'http://localhost:11434/v1',
		defaultModels: { fast: 'llama3.1', capable: 'llama3.1' },
		curatedModels: ['llama3.1', 'llama3.3', 'qwen3', 'gemma3', 'mistral'],
		supportsModelListing: true,
		hint: `${K}.providers.openaiCompatible.hint`,
	},
] as const;

/**
 * The embedding provider catalog. `local` is the bundled default (locked
 * decision 3) so retrieval works under any language choice; the rest are
 * optional hosted / custom overrides.
 */
export const EMBEDDING_PROVIDERS: readonly EmbeddingProviderMeta[] = [
	{
		kind: 'local',
		label: `${K}.embedders.local.label`,
		isLocal: true,
		dimensions: 768,
		defaultModel: 'nomic-embed-text',
		curatedModels: ['nomic-embed-text'],
	},
	{
		kind: 'openai',
		label: `${K}.embedders.openai.label`,
		isLocal: false,
		dimensions: 1536,
		defaultModel: 'text-embedding-3-small',
		curatedModels: ['text-embedding-3-small', 'text-embedding-3-large'],
	},
	{
		kind: 'google',
		label: `${K}.embedders.google.label`,
		isLocal: false,
		dimensions: 768,
		defaultModel: 'text-embedding-004',
		curatedModels: ['text-embedding-004'],
	},
	{
		kind: 'openaiCompatible',
		label: `${K}.embedders.openaiCompatible.label`,
		isLocal: true,
		dimensions: 768,
		defaultModel: 'nomic-embed-text',
		curatedModels: ['nomic-embed-text'],
	},
] as const;

/** Look up language provider metadata by kind (`undefined` for an unknown kind). */
export function languageProviderMeta(kind: string): LanguageProviderMeta | undefined {
	return LANGUAGE_PROVIDERS.find((p) => p.kind === kind);
}

/** Look up embedding provider metadata by kind (`undefined` for an unknown kind). */
export function embeddingProviderMeta(kind: string): EmbeddingProviderMeta | undefined {
	return EMBEDDING_PROVIDERS.find((p) => p.kind === kind);
}

/**
 * Language provider `UiSelect` options. Typed to the kind union (not bare
 * `string`) so `UiSelect`'s generic infers `LanguageProviderKind` and the
 * bound `v-model` stays the union rather than widening to `string`. Each label
 * is a message key — the renderer translates it.
 */
export function languageProviderOptions(): { value: LanguageProviderKind; label: string }[] {
	return LANGUAGE_PROVIDERS.map((p) => ({ value: p.kind, label: p.label }));
}

/**
 * Embedding provider `UiSelect` options, typed to the embedding kind union.
 * Each label is a message key — the renderer translates it.
 */
export function embeddingProviderOptions(): { value: EmbeddingProviderKind; label: string }[] {
	return EMBEDDING_PROVIDERS.map((p) => ({ value: p.kind, label: p.label }));
}

/** True when the provider needs an API key (i.e. it is not a local backend). */
export function languageProviderRequiresKey(kind: string): boolean {
	return languageProviderMeta(kind)?.isLocal === false;
}

/** Sentinel select value that reveals the free-text model-id override input. */
export const CUSTOM_MODEL_VALUE = '__custom__';

/**
 * Build the model-picker options: the provider's curated model ids, plus the
 * currently-stored id when it isn't one of them (so a custom saved value still
 * shows selected), plus the "Custom model id…" sentinel that reveals the
 * free-text override. `current` is ignored when it is empty or already the
 * sentinel.
 */
export function modelOptions(curated: readonly string[], current: string): SelectOption[] {
	const options: SelectOption[] = curated.map((m) => ({ value: m, label: m }));
	if (current && current !== CUSTOM_MODEL_VALUE && !curated.includes(current)) {
		options.push({
			value: current,
			label: { key: `${K}.currentModel`, params: { model: current } },
		});
	}
	options.push({ value: CUSTOM_MODEL_VALUE, label: `${K}.customModel` });
	return options;
}

/**
 * Merge a provider's live model catalog (from the backend `listModels` action)
 * into its curated list, curated ids first, then any live id not already curated
 * — de-duplicated, order-stable. The result feeds {@link modelOptions} so the
 * picker shows what the provider actually serves instead of free-text only. An
 * empty `live` list leaves the curated list unchanged (a copy).
 */
export function mergeLiveModels(curated: readonly string[], live: readonly string[]): string[] {
	const merged = [...curated];
	const seen = new Set(curated);
	for (const id of live) {
		if (id && !seen.has(id)) {
			seen.add(id);
			merged.push(id);
		}
	}
	return merged;
}

/**
 * Resolve the effective model id from a dropdown `choice` + the free-text
 * `custom` field. When the sentinel is chosen, the trimmed custom text wins;
 * otherwise the chosen id is used verbatim.
 */
export function resolveModelId(choice: string, custom: string): string {
	return choice === CUSTOM_MODEL_VALUE ? custom.trim() : choice;
}

/**
 * Validate the language plane before save. A local provider never needs a key
 * (the field is hidden). A hosted provider needs either a stored key or a
 * freshly-typed one — otherwise saving would persist a config that can't run. A
 * provider flagged `requiresBaseUrl` (Azure) additionally needs its resource
 * base URL. Returns a message KEY the renderer translates, or `null` when the
 * config is savable. The provider is named by the key itself rather than
 * interpolated, so no translated label ever has to be nested into a sentence.
 */
export function validateLanguageConfig(input: {
	kind: string;
	hasStoredKey: boolean;
	apiKey: string;
	baseUrl?: string;
}): string | null {
	const meta = languageProviderMeta(input.kind);
	const provider = meta?.kind ?? 'unknown';
	if (meta?.requiresBaseUrl && !(input.baseUrl ?? '').trim()) {
		return `${K}.validation.baseUrlRequired.${provider}`;
	}
	if (!languageProviderRequiresKey(input.kind)) return null;
	if (input.hasStoredKey || input.apiKey.trim().length > 0) return null;
	return `${K}.validation.apiKeyRequired.${provider}`;
}

/**
 * The Test-connection UI state. `message` carries what the admin reads: the
 * backend's own error text when it sent one, otherwise this module's fallback
 * message KEY — the renderer runs it through `t(…)`, and text with nothing to
 * translate reads as itself.
 */
export type TestConnectionState =
	| { status: 'idle' }
	| { status: 'testing' }
	| { status: 'ok' }
	| { status: 'error'; message: string };

/** Events that drive {@link testConnectionReducer}. */
export type TestConnectionEvent =
	| { type: 'start' }
	| { type: 'result'; ok: boolean; error?: string };

/**
 * Pure reducer for the Test-connection state machine. `start` enters `testing`;
 * a result transitions to `ok` or `error` (carrying a fallback message when the
 * backend omitted one). Any event other than a result from `testing` is ignored,
 * so a stray late result can't clobber a fresh run.
 */
export function testConnectionReducer(
	state: TestConnectionState,
	event: TestConnectionEvent
): TestConnectionState {
	if (event.type === 'start') return { status: 'testing' };
	// Only accept a result while a test is in flight.
	if (state.status !== 'testing') return state;
	if (event.ok) return { status: 'ok' };
	return { status: 'error', message: event.error?.trim() || `${K}.testFailed` };
}
