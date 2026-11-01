<script setup lang="ts">
import { useId } from 'vue';
import { useUiI18n } from '../../composables/useUiI18n';
import UiButton from './Button.vue';
import UiModal from './Modal.vue';
import { TriangleWarningIcon } from '@coolicons/vue';

/**
 * The leave prompt every page with a dirty form shows. It lived in
 * @owlat/email-builder with English copy, though the settings, admin and
 * translation pages render it too; @owlat/email-builder still re-exports it.
 */
defineProps<{
	show: boolean;
	/**
	 * A Save is in flight. Save shows its progress and Discard waits for it;
	 * Cancel stays available and only dismisses the prompt.
	 */
	saving?: boolean;
}>();

const emit = defineEmits<{
	(e: 'close'): void;
	(e: 'discard'): void;
	(e: 'save'): void;
}>();

const { t } = useUiI18n();
// The paragraph says why the prompt opened and what the buttons do; linked as
// the dialog's description so a screen reader reads it with the title.
const descriptionId = useId();
</script>

<template>
	<UiModal
		:open="show"
		:title="t('ui.unsavedChanges.title')"
		:described-by="descriptionId"
		@update:open="emit('close')"
	>
		<div class="flex items-center gap-3 mb-4">
			<div class="p-2 rounded-full bg-warning/10">
				<TriangleWarningIcon class="w-5 h-5 text-warning" />
			</div>
			<p :id="descriptionId" class="text-text-secondary">
				{{ t('ui.unsavedChanges.description') }}
			</p>
		</div>

		<template #footer>
			<UiButton variant="danger-outline" :disabled="saving" @click="emit('discard')">
				{{ t('ui.unsavedChanges.discard') }}
			</UiButton>
			<UiButton variant="secondary" @click="emit('close')">
				{{ t('ui.actions.cancel') }}
			</UiButton>
			<UiButton variant="primary" :loading="saving" @click="emit('save')">
				{{ t('ui.unsavedChanges.save') }}
			</UiButton>
		</template>
	</UiModal>
</template>
