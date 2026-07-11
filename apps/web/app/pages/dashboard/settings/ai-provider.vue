<script setup lang="ts">
useHead({ title: 'AI Provider — Owlat' });

definePageMeta({
	layout: 'dashboard',
	// Reachable on-ramp: this is how an admin turns AI on, so it is NOT gated by
	// the `ai` flag (chicken-and-egg). The admin gate is enforced server-side —
	// `saveConfig` requires `organization:manage` and audit-logs the change.
	middleware: 'auth',
});

const {
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
} = useAiProviderForm();
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

						<div v-if="supportsModelListing" class="flex flex-wrap items-center gap-3">
							<UiButton
								type="button"
								variant="secondary"
								size="sm"
								:loading="isLoadingModels"
								:disabled="isSaving || isLoadingModels || isDirty || !config?.configured"
								@click="handleLoadModels"
							>
								<template #iconLeft>
									<Icon v-if="!isLoadingModels" name="lucide:list-restart" class="w-4 h-4" />
								</template>
								Load available models
							</UiButton>
							<p v-if="liveModelsError" class="text-xs text-error">{{ liveModelsError }}</p>
							<p v-else-if="liveModels.length" class="text-xs text-success">
								Loaded {{ liveModels.length }} models from your provider.
							</p>
							<p v-else-if="isDirty || !config?.configured" class="text-xs text-text-tertiary">
								Save first, then load the live model list.
							</p>
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
