<script setup lang="ts">
import { api } from '@owlat/api';
import {
	embeddingProviderMeta,
	embeddingProviderOptions,
	languageProviderMeta,
	languageProviderOptions,
	languageProviderRequiresKey,
	modelOptions,
	resolveModelId,
	testConnectionReducer,
	validateLanguageConfig,
	type EmbeddingProviderKind,
	type LanguageProviderKind,
	type TestConnectionState,
} from '~/utils/aiProviders';

useHead({ title: 'AI Provider — Owlat' });

definePageMeta({
	layout: 'dashboard',
	// Reachable on-ramp: this is how an admin turns AI on, so it is NOT gated by
	// the `ai` flag (chicken-and-egg). The admin gate is enforced server-side —
	// `saveConfig` requires `organization:manage` and audit-logs the change.
	middleware: 'auth',
});

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

const providerOptions = languageProviderOptions();
const embeddingOptions = embeddingProviderOptions();

const form = reactive({
	languageProviderKind: 'openai' as LanguageProviderKind,
	languageBaseUrl: '',
	apiKey: '',
	modelFastChoice: 'gpt-4o-mini',
	modelFastCustom: '',
	modelCapableChoice: 'gpt-4o',
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

const languageMeta = computed(() => languageProviderMeta(form.languageProviderKind));
const embeddingMeta = computed(() => embeddingProviderMeta(form.embeddingProviderKind));
const requiresKey = computed(() => languageProviderRequiresKey(form.languageProviderKind));
const embeddingRequiresKey = computed(() => embeddingMeta.value?.isLocal === false);

const fastModelOptions = computed(() =>
	modelOptions(languageMeta.value?.curatedModels ?? [], form.modelFastChoice)
);
const capableModelOptions = computed(() =>
	modelOptions(languageMeta.value?.curatedModels ?? [], form.modelCapableChoice)
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
		Boolean(c.languageBaseUrl) || langMeta?.isLocal === true || langMeta?.requiresBaseUrl === true;
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
	if (embeddingRequiresKey.value && !storedEmbeddingKeySet.value && !form.embeddingApiKey.trim()) {
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
</script>

<template>
	<div class="p-6 lg:p-8">
		<NuxtLink
			to="/dashboard/settings"
			class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded"
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
			Back to Settings
		</NuxtLink>

		<div class="flex items-center gap-4 mb-8">
			<UiIconBox icon="lucide:sparkles" size="xl" variant="brand" rounded="full" />
			<div>
				<h1 class="text-2xl font-semibold text-text-primary">AI Provider</h1>
				<p class="text-text-secondary mt-1">
					Choose the AI backend every AI feature uses. Pick a hosted provider and paste a key, or
					point at a model you host yourself.
				</p>
			</div>
		</div>

		<UiQueryBoundary :loading="isLoading && !config" :error="error">
			<template #loading>
				<div class="flex items-center justify-center py-16">
					<div class="flex flex-col items-center gap-3">
						<UiSpinner />
						<p class="text-text-secondary text-sm">Loading AI settings…</p>
					</div>
				</div>
			</template>

			<form class="space-y-6 max-w-3xl" @submit.prevent="handleSave">
				<UiCard>
					<h2 class="text-lg font-medium text-text-primary mb-1">Language model</h2>
					<p class="text-sm text-text-secondary mb-6">
						Powers every text feature — drafting replies, the assistant, summaries, translation, and
						more.
					</p>

					<div class="space-y-6">
						<div>
							<UiSelect
								v-model="form.languageProviderKind"
								label="Provider"
								:options="providerOptions"
								:disabled="isSaving"
							/>
							<p v-if="languageMeta" class="mt-1.5 text-xs text-text-tertiary">
								{{ languageMeta.hint }}
								<a
									v-if="languageMeta.docsUrl"
									:href="languageMeta.docsUrl"
									target="_blank"
									rel="noopener"
									class="text-brand hover:underline whitespace-nowrap"
								>
									Get a key →
								</a>
							</p>
						</div>

						<SettingsAiKeyField
							v-if="requiresKey"
							v-model="form.apiKey"
							label="API key"
							:stored-key-set="storedLanguageKeySet"
							:key-preview="keyPreview"
							:error="languageError"
							:disabled="isSaving"
							help-text="Sent once over TLS, encrypted at rest, and never shown again."
						/>

						<div v-if="requiresKey">
							<SettingsDisclosureToggle
								v-model:open="showLanguageBaseUrl"
								label="Advanced: custom base URL (proxy / gateway)"
								controls="ai-language-base-url"
								:disabled="isSaving"
							/>
						</div>
						<div v-if="showLanguageBaseUrl" id="ai-language-base-url">
							<UiInput
								v-model="form.languageBaseUrl"
								type="text"
								label="Base URL"
								:placeholder="languageMeta?.defaultBaseUrl ?? 'https://…'"
								:disabled="isSaving"
								:help-text="
									requiresKey
										? 'Route requests through a custom endpoint. Leave blank to use the provider default.'
										: 'The address of your local server (Ollama, vLLM, llama.cpp).'
								"
							/>
						</div>

						<div class="grid gap-6 sm:grid-cols-2">
							<SettingsAiModelPicker
								v-model:choice="form.modelCapableChoice"
								v-model:custom="form.modelCapableCustom"
								label="Capable model"
								:options="capableModelOptions"
								:disabled="isSaving"
								hint="Used for hard tasks — reasoning, long drafts."
							/>
							<SettingsAiModelPicker
								v-model:choice="form.modelFastChoice"
								v-model:custom="form.modelFastCustom"
								label="Fast model"
								:options="fastModelOptions"
								:disabled="isSaving"
								hint="Used for quick tasks — classification, short replies."
							/>
						</div>
					</div>
				</UiCard>

				<UiCard>
					<h2 class="text-lg font-medium text-text-primary mb-1">Embeddings</h2>
					<p class="text-sm text-text-secondary mb-4">
						Power semantic search and the knowledge graph. These run separately from your language
						model, so retrieval works with any provider above.
					</p>

					<div
						v-if="form.embeddingProviderKind === 'local'"
						class="flex items-start gap-3 rounded-lg bg-success-subtle/50 border border-border-subtle p-4"
					>
						<Icon name="lucide:check-circle-2" class="w-5 h-5 text-success shrink-0 mt-0.5" />
						<div class="text-sm">
							<p class="text-text-primary font-medium">Local (bundled) — no setup needed</p>
							<p class="text-text-secondary mt-0.5">
								A local embedding model ships with your deployment, so search works out of the box.
							</p>
						</div>
					</div>

					<div class="mt-4">
						<SettingsDisclosureToggle
							v-model:open="showHostedEmbedder"
							label="Advanced: use a hosted embedder instead"
							controls="ai-hosted-embedder"
							:disabled="isSaving"
						/>
					</div>

					<div v-if="showHostedEmbedder" id="ai-hosted-embedder" class="mt-4 space-y-6">
						<UiSelect
							v-model="form.embeddingProviderKind"
							label="Embedding provider"
							:options="embeddingOptions"
							:disabled="isSaving"
						/>

						<SettingsAiModelPicker
							v-model:choice="form.embeddingModelChoice"
							v-model:custom="form.embeddingModelCustom"
							label="Embedding model"
							:options="embeddingModelOptions"
							:disabled="isSaving"
							:hint="embeddingMeta ? `${embeddingMeta.dimensions}-dimensional vectors.` : undefined"
						/>

						<SettingsAiKeyField
							v-if="embeddingRequiresKey"
							v-model="form.embeddingApiKey"
							label="Embedding API key"
							:stored-key-set="storedEmbeddingKeySet"
							:key-preview="embeddingKeyPreview"
							:error="embeddingError"
							:disabled="isSaving"
							help-text="Encrypted at rest, never shown again."
						/>
					</div>

					<div
						v-if="embeddingChanged"
						class="mt-4 flex items-start gap-3 rounded-lg bg-warning-subtle/50 border border-border-subtle p-4 text-sm"
					>
						<Icon name="lucide:alert-triangle" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
						<div>
							<p class="text-text-primary font-medium">Changing embeddings needs a re-index</p>
							<p class="text-text-secondary mt-0.5">
								New and old vectors aren't comparable. After saving, re-index your knowledge so
								search stays accurate.
							</p>
						</div>
					</div>
				</UiCard>

				<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
					<div class="flex items-center gap-3">
						<UiButton
							type="button"
							variant="secondary"
							:loading="isTesting"
							:disabled="isSaving || isTesting || isDirty || !config?.configured"
							@click="handleTest"
						>
							<template #iconLeft>
								<Icon v-if="!isTesting" name="lucide:plug-zap" class="w-4 h-4" />
							</template>
							Test connection
						</UiButton>

						<p
							v-if="testState.status === 'ok'"
							class="text-sm text-success flex items-center gap-1.5"
						>
							<Icon name="lucide:check" class="w-4 h-4" />
							Connection works
						</p>
						<p
							v-else-if="testState.status === 'error'"
							class="text-sm text-error flex items-center gap-1.5"
						>
							<Icon name="lucide:x" class="w-4 h-4" />
							{{ testState.message }}
						</p>
						<p v-else-if="isDirty || !config?.configured" class="text-xs text-text-tertiary">
							Save first, then test.
						</p>
					</div>

					<UiButton
						type="submit"
						:loading="isSaving"
						:disabled="isSaving || Boolean(liveLanguageError)"
					>
						<template #iconLeft>
							<Icon v-if="!isSaving" name="lucide:check" class="w-4 h-4" />
						</template>
						{{ isSaving ? 'Saving…' : 'Save AI provider' }}
					</UiButton>
				</div>
			</form>
		</UiQueryBoundary>
	</div>
</template>
