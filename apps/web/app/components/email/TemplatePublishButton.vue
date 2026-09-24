<script setup lang="ts">
/**
 * The Email template editor's Publish / Unpublish toolbar button.
 *
 * Publish puts the row's stored HTML live, so it waits for unsaved edits to be
 * saved (and for there to be stored HTML at all). Unpublish stays available
 * with unsaved edits: it renders nothing, and a published template refuses
 * saves until it is unpublished, so holding it too would leave the edits with
 * no way to be saved.
 */
const props = defineProps<{
	isPublished: boolean;
	hasChanges: boolean;
	/** The row holds rendered HTML (it was saved from the editor at least once). */
	hasStoredHtml: boolean;
	loading: boolean;
}>();

const emit = defineEmits<{ toggle: [] }>();

const { t } = useI18n();

const holdPublish = computed(() => !props.isPublished && props.hasChanges);
</script>

<template>
	<UiButton
		variant="secondary"
		size="sm"
		:loading="loading"
		:disabled="!isPublished && (hasChanges || !hasStoredHtml)"
		:title="holdPublish ? t('dashboard.send.emails.detail.edit.saveBeforePublishHint') : undefined"
		@click="emit('toggle')"
	>
		<template #iconLeft>
			<Icon :name="isPublished ? 'lucide:undo-2' : 'lucide:send'" class="w-4 h-4" />
		</template>
		{{
			isPublished
				? t('dashboard.send.emails.detail.edit.unpublish')
				: t('dashboard.send.emails.detail.edit.publish')
		}}
	</UiButton>
</template>
