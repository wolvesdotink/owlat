<script setup lang="ts">
/**
 * Where a host puts the AI generator. The panel, its reference search and its
 * run are a lazy chunk, fetched when this mounts (or earlier, from a hovered
 * entry point: `warmEmailGeneratePanel`), so the template library, the
 * transactional list and the campaign wizard do not carry them. Until the code
 * has arrived a spinner holds about the panel's height, so the dialog opens at
 * once and does not jump when the form replaces it.
 *
 * The fetch can fail: the author is offline, or the tab is older than the
 * deployment and the chunk it names is gone. That is shown in the panel's
 * place with a way to ask again, and the host's own way out stays reachable.
 */
import type { Component } from 'vue';
import { loadEmailGeneratePanel, type GenerationKind } from '~/lib/emailGenerationEntry';
import type { GenerationResult } from '~/composables/useEmailGeneration';

defineProps<{
	kind: GenerationKind;
	/** The language to write in; absent, the language of the prompt. */
	defaultLanguage?: string;
}>();

const emit = defineEmits<{ created: [result: GenerationResult] }>();

const { t } = useI18n();

const panel = shallowRef<Component | null>(null);
const hasLoadFailed = ref(false);

async function load() {
	hasLoadFailed.value = false;
	try {
		panel.value = await loadEmailGeneratePanel();
	} catch {
		hasLoadFailed.value = true;
	}
}

onMounted(load);
</script>

<template>
	<component
		:is="panel"
		v-if="panel"
		:kind="kind"
		:default-language="defaultLanguage"
		@created="(result: GenerationResult) => emit('created', result)"
	>
		<template #secondary="slotProps">
			<slot name="secondary" v-bind="slotProps" />
		</template>
	</component>
	<div
		v-else-if="hasLoadFailed"
		class="flex min-h-[26rem] flex-col items-center justify-center gap-4 text-center"
		role="alert"
		data-testid="email-generate-load-failed"
	>
		<p class="max-w-sm text-sm text-text-secondary">
			{{ t('components.ai.emailGenerate.loadFailed') }}
		</p>
		<div class="flex flex-col-reverse gap-3 sm:flex-row sm:items-center">
			<slot name="secondary" :is-generating="false" />
			<UiButton data-testid="email-generate-retry" @click="load">
				{{ t('common.tryAgain') }}
			</UiButton>
		</div>
	</div>
	<div
		v-else
		class="flex min-h-[26rem] items-center justify-center"
		data-testid="email-generate-loading"
	>
		<UiSpinner :label="t('common.loading')" />
	</div>
</template>
