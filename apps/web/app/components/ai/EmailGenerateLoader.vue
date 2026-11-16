<script setup lang="ts">
/**
 * Where a host puts the AI generator. The panel, its reference search and its
 * run are a lazy chunk, fetched when this mounts (or earlier, from a hovered
 * entry point: `warmEmailGeneratePanel`), so the template library, the
 * transactional list and the campaign wizard do not carry them. Until the code
 * has arrived a spinner holds about the panel's height, so the dialog opens at
 * once and does not jump when the form replaces it.
 */
import type { GenerationKind } from '~/lib/emailGenerationEntry';
import type { GenerationResult } from '~/composables/useEmailGeneration';

defineProps<{
	kind: GenerationKind;
	/** The language to write in; absent, the language of the prompt. */
	defaultLanguage?: string;
}>();

const emit = defineEmits<{ created: [result: GenerationResult] }>();

const { t } = useI18n();
</script>

<template>
	<Suspense>
		<LazyAiEmailGeneratePanel
			:kind="kind"
			:default-language="defaultLanguage"
			@created="(result: GenerationResult) => emit('created', result)"
		>
			<template #secondary="slotProps">
				<slot name="secondary" v-bind="slotProps" />
			</template>
		</LazyAiEmailGeneratePanel>
		<template #fallback>
			<div
				class="flex min-h-[26rem] items-center justify-center"
				data-testid="email-generate-loading"
			>
				<UiSpinner :label="t('common.loading')" />
			</div>
		</template>
	</Suspense>
</template>
