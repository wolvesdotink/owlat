<script setup lang="ts">
/**
 * The choice a stale-revision save refusal offers in the Email template and
 * Transactional email editors: the email changed somewhere else (another tab,
 * the Translations page, a saved-block edit) after this draft was loaded.
 *
 * "Keep my version" merges the draft onto the latest version (the fields the
 * user changed win) and saves it; "Load latest" discards the draft and shows
 * the server's copy. Closing the dialog keeps the draft unsaved, as it was.
 *
 * `mustReload`: the draft no longer fits the latest version (its default
 * language changed), so keeping it is not offered.
 */
defineProps<{
	open: boolean;
	isResolving: boolean;
	mustReload?: boolean;
}>();

const emit = defineEmits<{
	keep: [];
	load: [];
	close: [];
}>();

const { t } = useI18n();
</script>

<template>
	<UiModal
		:open="open"
		:title="t('components.email.editorConflictDialog.title')"
		size="md"
		:persistent="isResolving"
		@update:open="!$event && emit('close')"
	>
		<p class="text-sm text-text-secondary">
			{{
				mustReload
					? t('components.email.editorConflictDialog.languageChanged')
					: t('components.email.editorConflictDialog.description')
			}}
		</p>

		<template #footer>
			<UiButton
				:variant="mustReload ? 'primary' : 'secondary'"
				:disabled="isResolving"
				@click="emit('load')"
			>
				{{ t('components.email.editorConflictDialog.loadLatest') }}
			</UiButton>
			<UiButton v-if="!mustReload" variant="primary" :loading="isResolving" @click="emit('keep')">
				{{ t('components.email.editorConflictDialog.keepMine') }}
			</UiButton>
		</template>
	</UiModal>
</template>
