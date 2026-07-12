import { computed, reactive, ref, watch } from 'vue';
import { api } from '@owlat/api';
import {
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
	type EmbeddingProviderKind,
	type LanguageProviderKind,
	type TestConnectionState,
} from '~/utils/aiProviders';

/**
 * The AI-provider settings form as a self-contained state machine: the reactive
 * form, its derived option lists / validation, provider-default watchers, config
 * hydration, and the save / test / load-models handlers. Extracted from
 * `pages/dashboard/settings/ai-provider.vue` so the page is a thin template over
 * this logic (and each file stays under the size cap). Everything the template
 * binds is returned; internal derivations (`saved`, `hydrate`, effective-model
 * ids, provider-default appliers) stay private.
 */
export function useAiProviderForm() {
	const { showToast } = useToast();

	// getConfig never returns a secret — only selections, a masked preview, booleans.
	const { data: config, isLoading, error } = useOrganizationQuery(api.aiProviderConfig.getConfig);

	const { run: runSave, isLoading: isSaving } = useBackendOperation(
		api.aiProviderConfigActions.saveConfig,
		{ label: 'Save AI provider', type: 'action' }
	);
	const { run: runTest, isLoading: isTesting } = useBackendOperation(
		api.aiProviderConfigActions.testConnection,
		{ label: 'Test AI connection', type: 'action' }
	);
	const { run: runListModels, isLoading: isLoadingModels } = useBackendOperation(
		api.aiProviderConfigActions.listModels,
		{ label: 'Load available models', type: 'action' }
	);

	const providerOptions = languageProviderOptions();
	const embeddingOptions = embeddingProviderOptions();

	const form = reactive({
		languageProviderKind: 'openai' as LanguageProviderKind,
		languageBaseUrl: '',
		apiKey: '',
		modelFastChoice: 'gpt-5.6-luna',
		modelFastCustom: '',
		modelCapableChoice: 'gpt-5.6-sol',
		modelCapableCustom: '',
		embeddingProviderKind: 'local' as EmbeddingProviderKind,
		embeddingModelChoice: 'nomic-embed-text',
		embeddingModelCustom: '',
		embeddingApiKey: '',
	});

	const languageError = ref<string | null>(null);
	const embeddingError = ref<string | null>(null);
	const showLanguageBaseUrl = ref(false);
	const showHostedEmbedder = ref(false);
	const hydrating = ref(false);
	const isDirty = ref(false);
	const testState = ref<TestConnectionState>({ status: 'idle' });
	// The provider's live model catalog, once "Load available models" has run. Reset
	// whenever the provider changes (a stale list must never leak across backends).
	const liveModels = ref<string[]>([]);
	const liveModelsError = ref<string | null>(null);

	const languageMeta = computed(() => languageProviderMeta(form.languageProviderKind));
	const embeddingMeta = computed(() => embeddingProviderMeta(form.embeddingProviderKind));
	const requiresKey = computed(() => languageProviderRequiresKey(form.languageProviderKind));
	const embeddingRequiresKey = computed(() => embeddingMeta.value?.isLocal === false);
	const supportsModelListing = computed(() => languageMeta.value?.supportsModelListing === true);

	// Curated ids first, then any live id the provider reports that isn't already curated.
	const languageModelIds = computed(() =>
		mergeLiveModels(languageMeta.value?.curatedModels ?? [], liveModels.value)
	);
	const fastModelOptions = computed(() =>
		modelOptions(languageModelIds.value, form.modelFastChoice)
	);
	const capableModelOptions = computed(() =>
		modelOptions(languageModelIds.value, form.modelCapableChoice)
	);
	const embeddingModelOptions = computed(() =>
		modelOptions(embeddingMeta.value?.curatedModels ?? [], form.embeddingModelChoice)
	);

	const effectiveModelFast = computed(() =>
		resolveModelId(form.modelFastChoice, form.modelFastCustom)
	);
	const effectiveModelCapable = computed(() =>
		resolveModelId(form.modelCapableChoice, form.modelCapableCustom)
	);
	const effectiveEmbeddingModel = computed(() =>
		resolveModelId(form.embeddingModelChoice, form.embeddingModelCustom)
	);

	// The stored row once it exists, or null — the secret-free source for the
	// key-set booleans, masked previews, and the re-index diff below.
	const saved = computed(() => {
		const c = config.value;
		return c?.configured ? c : null;
	});
	const storedLanguageKeySet = computed(() => saved.value?.isLanguageKeySet ?? false);
	const storedEmbeddingKeySet = computed(() => saved.value?.isEmbeddingKeySet ?? false);
	const keyPreview = computed(() => saved.value?.keyPreview);
	const embeddingKeyPreview = computed(() => saved.value?.embeddingKeyPreview);

	// Changing the embedding provider/model needs a re-index (embeddingModelVersion bump); warn first.
	const embeddingChanged = computed(() => {
		const c = saved.value;
		if (!c) return false;
		return (
			form.embeddingProviderKind !== c.embeddingProviderKind ||
			effectiveEmbeddingModel.value !== (c.embeddingModel ?? '')
		);
	});

	const liveLanguageError = computed(() =>
		validateLanguageConfig({
			kind: form.languageProviderKind,
			hasStoredKey: storedLanguageKeySet.value,
			apiKey: form.apiKey,
			baseUrl: form.languageBaseUrl,
		})
	);

	/** Apply a provider's defaults when the admin picks a new language backend. */
	function applyLanguageDefaults(kind: LanguageProviderKind) {
		const meta = languageProviderMeta(kind);
		if (!meta) return;
		form.modelFastChoice = meta.defaultModels.fast;
		form.modelCapableChoice = meta.defaultModels.capable;
		form.modelFastCustom = '';
		form.modelCapableCustom = '';
		languageError.value = null;
		testState.value = { status: 'idle' };
		// A live catalog belongs to one provider — drop it when the backend changes.
		liveModels.value = [];
		liveModelsError.value = null;
		if (meta.isLocal) {
			form.apiKey = '';
			if (!form.languageBaseUrl.trim()) form.languageBaseUrl = meta.defaultBaseUrl ?? '';
			showLanguageBaseUrl.value = true;
		} else if (meta.requiresBaseUrl) {
			// Azure's resource endpoint is required, not "advanced" — reveal it, but
			// don't prefill the `<resource>` placeholder (the input's placeholder shows
			// the expected shape).
			showLanguageBaseUrl.value = true;
		}
	}

	function applyEmbeddingDefaults(kind: EmbeddingProviderKind) {
		const meta = embeddingProviderMeta(kind);
		if (!meta) return;
		form.embeddingModelChoice = meta.defaultModel;
		form.embeddingModelCustom = '';
		embeddingError.value = null;
		if (meta.isLocal) form.embeddingApiKey = '';
	}

	// flush:'sync' + `hydrating` guard: fire during assignment to tell a config set from a user pick.
	watch(
		() => form.languageProviderKind,
		(kind) => {
			if (!hydrating.value) applyLanguageDefaults(kind);
		},
		{ flush: 'sync' }
	);
	watch(
		() => form.embeddingProviderKind,
		(kind) => {
			if (!hydrating.value) applyEmbeddingDefaults(kind);
		},
		{ flush: 'sync' }
	);
	watch(
		form,
		() => {
			if (!hydrating.value) isDirty.value = true;
		},
		{ deep: true, flush: 'sync' }
	);

	/** Seed the form from stored config. A custom (non-curated) model id round-trips
	 * as its own select option (see `modelOptions`), so choice = the stored id. */
	function hydrate() {
		const c = config.value;
		if (!c || !c.configured) return;
		hydrating.value = true;
		isDirty.value = false;
		form.languageProviderKind = c.languageProviderKind ?? 'openai';
		form.languageBaseUrl = c.languageBaseUrl ?? '';
		form.apiKey = '';
		const langMeta = languageProviderMeta(form.languageProviderKind);
		form.modelFastChoice = c.modelFast || langMeta?.defaultModels.fast || '';
		form.modelCapableChoice = c.modelCapable || langMeta?.defaultModels.capable || '';
		form.modelFastCustom = '';
		form.modelCapableCustom = '';
		form.embeddingProviderKind = c.embeddingProviderKind ?? 'local';
		const embMeta = embeddingProviderMeta(form.embeddingProviderKind);
		form.embeddingModelChoice = c.embeddingModel || embMeta?.defaultModel || '';
		form.embeddingModelCustom = '';
		form.embeddingApiKey = '';
		showLanguageBaseUrl.value =
			Boolean(c.languageBaseUrl) ||
			langMeta?.isLocal === true ||
			langMeta?.requiresBaseUrl === true;
		showHostedEmbedder.value = embMeta?.isLocal === false;
		hydrating.value = false;
	}

	watch(config, () => hydrate(), { immediate: true });

	// Collapsing "use a hosted embedder" returns the embedding plane to local, so
	// view state and form state can never diverge: the "Local (bundled)" banner
	// (which now keys off `form.embeddingProviderKind`) tells the truth about what
	// Save persists, and no hosted-key requirement lingers behind a hidden panel.
	watch(showHostedEmbedder, (open) => {
		if (!hydrating.value && !open && form.embeddingProviderKind !== 'local') {
			form.embeddingProviderKind = 'local';
		}
	});

	async function handleSave() {
		languageError.value = liveLanguageError.value;
		if (languageError.value) return;

		// A hosted embedder needs a key too (stored or freshly typed).
		embeddingError.value = null;
		if (
			embeddingRequiresKey.value &&
			!storedEmbeddingKeySet.value &&
			!form.embeddingApiKey.trim()
		) {
			embeddingError.value = `${embeddingMeta.value?.label ?? 'This embedder'} needs an API key.`;
			return;
		}

		const apiKey = form.apiKey.trim();
		const embeddingApiKey = form.embeddingApiKey.trim();
		const baseUrl = form.languageBaseUrl.trim();

		const result = await runSave({
			languageProviderKind: form.languageProviderKind,
			languageBaseUrl: baseUrl || undefined,
			modelFast: effectiveModelFast.value || undefined,
			modelCapable: effectiveModelCapable.value || undefined,
			apiKey: apiKey || undefined,
			embeddingProviderKind: form.embeddingProviderKind,
			embeddingModel: effectiveEmbeddingModel.value || undefined,
			embeddingApiKey: embeddingApiKey || undefined,
		});
		if (result === undefined) return;

		// Never keep the plaintext key in memory once persisted.
		form.apiKey = '';
		form.embeddingApiKey = '';
		isDirty.value = false;
		testState.value = { status: 'idle' };
		showToast('AI provider saved');
	}

	/**
	 * Pull the provider's live model catalog (OpenRouter / local `/models`) against
	 * the SAVED config and merge it into the pickers. Like Test connection, it reads
	 * the stored row, so it is only enabled once the config is saved and clean.
	 */
	async function handleLoadModels() {
		liveModelsError.value = null;
		const result = await runListModels({});
		if (result === undefined) {
			liveModelsError.value = 'Could not load models.';
			return;
		}
		if (result.error) {
			liveModelsError.value = result.error;
			return;
		}
		if (!result.supported) {
			liveModelsError.value = 'This provider does not support listing models.';
			return;
		}
		liveModels.value = result.models;
		if (result.models.length === 0) {
			liveModelsError.value = 'No models returned — keep using a custom id.';
		}
	}

	async function handleTest() {
		testState.value = testConnectionReducer(testState.value, { type: 'start' });
		const result = await runTest({});
		if (result === undefined) {
			// The operation layer already toasted the fault; reflect it inline too.
			testState.value = testConnectionReducer(testState.value, {
				type: 'result',
				ok: false,
				error: 'Connection test failed.',
			});
			return;
		}
		testState.value = testConnectionReducer(testState.value, {
			type: 'result',
			ok: result.ok,
			error: result.error,
		});
	}

	return {
		config,
		isLoading,
		error,
		isSaving,
		isTesting,
		isLoadingModels,
		providerOptions,
		embeddingOptions,
		form,
		languageError,
		embeddingError,
		showLanguageBaseUrl,
		showHostedEmbedder,
		isDirty,
		testState,
		liveModels,
		liveModelsError,
		languageMeta,
		embeddingMeta,
		requiresKey,
		embeddingRequiresKey,
		supportsModelListing,
		fastModelOptions,
		capableModelOptions,
		embeddingModelOptions,
		storedLanguageKeySet,
		storedEmbeddingKeySet,
		keyPreview,
		embeddingKeyPreview,
		embeddingChanged,
		liveLanguageError,
		handleSave,
		handleTest,
		handleLoadModels,
	};
}
