<script setup lang="ts">
/**
 * The generator as a dialog of its own, for entry points that have no create
 * dialog to put it in (the new-campaign flow). Esc and the close button work
 * while a run is in flight: the run keeps going and its draft is offered in a
 * toast (`useEmailGeneration`).
 */
import type { GenerationKind } from '~/lib/emailGenerationEntry';
import type { GenerationResult } from '~/composables/useEmailGeneration';

const open = defineModel<boolean>('open', { required: true });
defineProps<{ kind: GenerationKind; defaultLanguage?: string }>();
const emit = defineEmits<{ created: [result: GenerationResult] }>();

const { t } = useI18n();

function created(result: GenerationResult) {
	open.value = false;
	emit('created', result);
}
</script>

<template>
	<UiModal v-model:open="open" :title="t(`components.ai.emailGenerate.title.${kind}`)" size="2xl">
		<AiEmailGenerateLoader
			v-if="open"
			:kind="kind"
			:default-language="defaultLanguage"
			@created="created"
		>
			<template #secondary>
				<UiButton variant="secondary" @click="open = false">{{ t('common.close') }}</UiButton>
			</template>
		</AiEmailGenerateLoader>
	</UiModal>
</template>
