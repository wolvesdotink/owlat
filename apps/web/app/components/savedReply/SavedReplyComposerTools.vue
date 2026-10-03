<script setup lang="ts">
/**
 * The saved-reply controls a composer footer carries: the picker button (and
 * the picker ⌘; opens), and the "Save as reply" dialog the picker and the
 * command palette open. Rendered by {@link PostboxComposerFooter} for both
 * composers; the state lives in `useComposerSavedReplyPicker`.
 */
import { htmlToPlainText } from '@owlat/shared/html';
import type { ComposerSavedReplies } from '~/composables/useComposerSavedReplyPicker';
import SavedReplyPicker from './SavedReplyPicker.vue';
import SavedReplySaveDialog from './SavedReplySaveDialog.vue';

const props = defineProps<{ api: ComposerSavedReplies }>();

// Refs, so the dialogs can v-model them directly.
const { pickerOpen, saveOpen } = props.api;

const canSaveCurrent = computed(
	() => htmlToPlainText(props.api.currentBodyHtml.value).trim().length > 0
);
</script>

<template>
	<SavedReplyPicker
		v-if="api.enabled.value"
		v-model:open="pickerOpen"
		:replies="api.replies.value"
		:can-save-current="canSaveCurrent"
		@pick="api.pick"
		@save-current="saveOpen = true"
	/>
	<!-- Mounted while open: each "Save as reply" starts from empty fields. -->
	<SavedReplySaveDialog
		v-if="saveOpen"
		v-model:open="saveOpen"
		:body-html="api.currentBodyHtml.value"
	/>
</template>
