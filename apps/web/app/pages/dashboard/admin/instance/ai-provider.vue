<script setup lang="ts">
const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.instance.aiProvider.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	// Reachable on-ramp: this is how an admin turns AI on, so it is NOT gated by
	// the `ai` flag (chicken-and-egg). The admin gate is enforced server-side —
	// `saveConfig` requires `organization:manage` and audit-logs the change.
	middleware: ['auth', 'admin'],
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
			to="/dashboard/admin"
			class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded"
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
			{{ t('dashboard.admin.instance.aiProvider.backToSettings') }}
		</NuxtLink>

		<div class="flex items-center gap-4 mb-8">
			<UiIconBox icon="lucide:sparkles" size="xl" variant="brand" rounded="full" />
			<div>
				<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
					{{ t('dashboard.admin.instance.aiProvider.title') }}
				</h1>
				<p class="text-text-secondary mt-1">
					{{ t('dashboard.admin.instance.aiProvider.subtitle') }}
				</p>
			</div>
		</div>

		<UiQueryBoundary :loading="isLoading && !config" :error="error">
			<template #loading>
				<div class="flex items-center justify-center py-16">
					<div class="flex flex-col items-center gap-3">
						<UiSpinner />
						<p class="text-text-secondary text-sm">
							{{ t('dashboard.admin.instance.aiProvider.loading') }}
						</p>
					</div>
				</div>
			</template>

			<form class="space-y-6 max-w-3xl" @submit.prevent="handleSave">
				<UiCard>
					<h2 class="text-lg font-medium text-text-primary mb-1">
						{{ t('dashboard.admin.instance.aiProvider.language.title') }}
					</h2>
					<p class="text-sm text-text-secondary mb-6">
						{{ t('dashboard.admin.instance.aiProvider.language.description') }}
					</p>

					<div class="space-y-6">
						<div>
							<UiSelect
								v-model="form.languageProviderKind"
								:label="t('dashboard.admin.instance.aiProvider.language.providerLabel')"
								:options="providerOptions"
								:disabled="isSaving"
							/>
							<p v-if="languageMeta" class="mt-1.5 text-xs text-text-tertiary">
								{{ t(languageMeta.hint) }}
								<a
									v-if="languageMeta.docsUrl"
									:href="languageMeta.docsUrl"
									target="_blank"
									rel="noopener"
									class="text-brand hover:underline whitespace-nowrap"
								>
									{{ t('dashboard.admin.instance.aiProvider.language.getKey') }} →
								</a>
							</p>
						</div>

						<SettingsAiKeyField
							v-if="requiresKey"
							v-model="form.apiKey"
							:label="t('dashboard.admin.instance.aiProvider.language.apiKeyLabel')"
							:stored-key-set="storedLanguageKeySet"
							:key-preview="keyPreview"
							:error="languageError"
							:disabled="isSaving"
							:help-text="t('dashboard.admin.instance.aiProvider.language.apiKeyHelp')"
						/>

						<div v-if="requiresKey">
							<UiDisclosure
								v-model="showLanguageBaseUrl"
								:label="t('dashboard.admin.instance.aiProvider.language.baseUrlDisclosure')"
								controls="ai-language-base-url"
								:disabled="isSaving"
							>
								<UiInput
									v-model="form.languageBaseUrl"
									type="text"
									:label="t('dashboard.admin.instance.aiProvider.language.baseUrlLabel')"
									:placeholder="languageMeta?.defaultBaseUrl ?? 'https://…'"
									:disabled="isSaving"
									:help-text="
										requiresKey
											? t('dashboard.admin.instance.aiProvider.language.baseUrlHelpHosted')
											: t('dashboard.admin.instance.aiProvider.language.baseUrlHelpLocal')
									"
								/>
							</UiDisclosure>
						</div>

						<div class="grid gap-6 sm:grid-cols-2">
							<SettingsAiModelPicker
								v-model:choice="form.modelCapableChoice"
								v-model:custom="form.modelCapableCustom"
								:label="t('dashboard.admin.instance.aiProvider.language.capableLabel')"
								:options="capableModelOptions"
								:disabled="isSaving"
								:hint="t('dashboard.admin.instance.aiProvider.language.capableHint')"
							/>
							<SettingsAiModelPicker
								v-model:choice="form.modelFastChoice"
								v-model:custom="form.modelFastCustom"
								:label="t('dashboard.admin.instance.aiProvider.language.fastLabel')"
								:options="fastModelOptions"
								:disabled="isSaving"
								:hint="t('dashboard.admin.instance.aiProvider.language.fastHint')"
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
								{{ t('dashboard.admin.instance.aiProvider.language.loadModels') }}
							</UiButton>
							<p v-if="liveModelsError" class="text-xs text-error">{{ liveModelsError }}</p>
							<p v-else-if="liveModels.length" class="text-xs text-success">
								{{
									t('dashboard.admin.instance.aiProvider.language.loadedModels', {
										count: liveModels.length,
									})
								}}
							</p>
							<p v-else-if="isDirty || !config?.configured" class="text-xs text-text-tertiary">
								{{ t('dashboard.admin.instance.aiProvider.language.saveFirstModels') }}
							</p>
						</div>
					</div>
				</UiCard>

				<UiCard>
					<h2 class="text-lg font-medium text-text-primary mb-1">
						{{ t('dashboard.admin.instance.aiProvider.embeddings.title') }}
					</h2>
					<p class="text-sm text-text-secondary mb-4">
						{{ t('dashboard.admin.instance.aiProvider.embeddings.description') }}
					</p>

					<div
						v-if="form.embeddingProviderKind === 'local'"
						class="flex items-start gap-3 rounded-lg bg-success-subtle/50 border border-border-subtle p-4"
					>
						<Icon name="lucide:check-circle-2" class="w-5 h-5 text-success shrink-0 mt-0.5" />
						<div class="text-sm">
							<p class="text-text-primary font-medium">
								{{ t('dashboard.admin.instance.aiProvider.embeddings.localTitle') }}
							</p>
							<p class="text-text-secondary mt-0.5">
								{{ t('dashboard.admin.instance.aiProvider.embeddings.localBody') }}
							</p>
						</div>
					</div>

					<div class="mt-4">
						<UiDisclosure
							v-model="showHostedEmbedder"
							:label="t('dashboard.admin.instance.aiProvider.embeddings.hostedDisclosure')"
							controls="ai-hosted-embedder"
							:disabled="isSaving"
						>
							<div class="space-y-6">
								<UiSelect
									v-model="form.embeddingProviderKind"
									:label="t('dashboard.admin.instance.aiProvider.embeddings.providerLabel')"
									:options="embeddingOptions"
									:disabled="isSaving"
								/>

								<SettingsAiModelPicker
									v-model:choice="form.embeddingModelChoice"
									v-model:custom="form.embeddingModelCustom"
									:label="t('dashboard.admin.instance.aiProvider.embeddings.modelLabel')"
									:options="embeddingModelOptions"
									:disabled="isSaving"
									:hint="
										embeddingMeta
											? t('dashboard.admin.instance.aiProvider.embeddings.dimensionsHint', {
													dimensions: embeddingMeta.dimensions,
												})
											: undefined
									"
								/>

								<SettingsAiKeyField
									v-if="embeddingRequiresKey"
									v-model="form.embeddingApiKey"
									:label="t('dashboard.admin.instance.aiProvider.embeddings.apiKeyLabel')"
									:stored-key-set="storedEmbeddingKeySet"
									:key-preview="embeddingKeyPreview"
									:error="embeddingError"
									:disabled="isSaving"
									:help-text="t('dashboard.admin.instance.aiProvider.embeddings.apiKeyHelp')"
								/>
							</div>
						</UiDisclosure>
					</div>

					<div
						v-if="embeddingChanged"
						class="mt-4 flex items-start gap-3 rounded-lg bg-warning-subtle/50 border border-border-subtle p-4 text-sm"
					>
						<Icon name="lucide:alert-triangle" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
						<div>
							<p class="text-text-primary font-medium">
								{{ t('dashboard.admin.instance.aiProvider.embeddings.reindexTitle') }}
							</p>
							<p class="text-text-secondary mt-0.5">
								{{ t('dashboard.admin.instance.aiProvider.embeddings.reindexBody') }}
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
							{{ t('dashboard.admin.instance.aiProvider.testConnection') }}
						</UiButton>

						<p
							v-if="testState.status === 'ok'"
							class="text-sm text-success flex items-center gap-1.5"
						>
							<Icon name="lucide:check" class="w-4 h-4" />
							{{ t('dashboard.admin.instance.aiProvider.connectionWorks') }}
						</p>
						<p
							v-else-if="testState.status === 'error'"
							class="text-sm text-error flex items-center gap-1.5"
						>
							<Icon name="lucide:x" class="w-4 h-4" />
							{{ testState.message }}
						</p>
						<p v-else-if="isDirty || !config?.configured" class="text-xs text-text-tertiary">
							{{ t('dashboard.admin.instance.aiProvider.saveFirstTest') }}
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
						{{ isSaving ? t('common.saving') : t('dashboard.admin.instance.aiProvider.save') }}
					</UiButton>
				</div>
			</form>
		</UiQueryBoundary>
	</div>
</template>
