<script setup lang="ts">
/**
 * Asked only when leaving the open step could lose work: its save failed, or
 * the step was changed elsewhere while it held unsaved edits. Every other exit
 * (Close, Add step, another step, a reorder) waits for the save and moves on.
 */
defineProps<{
	open: boolean;
	/** The step was changed elsewhere; the choice is whose version to keep. */
	conflict: boolean;
	/** Retry (or Keep mine) is running. */
	retrying: boolean;
}>();

const emit = defineEmits<{ retry: []; discard: []; stay: [] }>();

const { t } = useI18n();
</script>

<template>
	<UiModal
		:open="open"
		:title="t('components.automations.stepSaveFailedDialog.title')"
		size="sm"
		@update:open="emit('stay')"
	>
		<div class="flex items-start gap-3">
			<div class="p-2 rounded-full bg-warning/10 shrink-0">
				<Icon name="lucide:alert-triangle" class="w-5 h-5 text-warning" />
			</div>
			<p class="text-text-secondary">
				{{
					conflict
						? t('components.automations.stepEditorPanel.conflict.body')
						: t('components.automations.stepSaveFailedDialog.body')
				}}
			</p>
		</div>

		<template #footer>
			<UiButton variant="danger-outline" :disabled="retrying" @click="emit('discard')">
				{{
					conflict
						? t('components.automations.stepEditorPanel.conflict.useTheirs')
						: t('components.automations.stepSaveFailedDialog.discard')
				}}
			</UiButton>
			<UiButton variant="secondary" @click="emit('stay')">
				{{ t('components.automations.stepSaveFailedDialog.stay') }}
			</UiButton>
			<UiButton :loading="retrying" @click="emit('retry')">
				{{
					conflict
						? t('components.automations.stepEditorPanel.conflict.keepMine')
						: t('components.automations.stepSaveStatus.retry')
				}}
			</UiButton>
		</template>
	</UiModal>
</template>
