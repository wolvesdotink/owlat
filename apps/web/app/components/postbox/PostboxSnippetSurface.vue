<script setup lang="ts">
/**
 * Everything the snippet "/" trigger puts on screen, in one mount point: the
 * caret-anchored dropdown, and the prompt-on-insert dialog a snippet with
 * declared `prompt` variables opens after it (plan idea 13).
 *
 * The two have opposite lifetimes — the dropdown closes the moment a snippet is
 * chosen, which is exactly when the dialog needs to appear — so the dialog
 * cannot live inside the dropdown. This wrapper is always mounted and owns
 * both, which also keeps {@link PostboxBasicEditor} under the file-size
 * ratchet.
 */
import type { SnippetPickerApi } from '~/composables/postbox/usePostboxSnippetPicker';

defineProps<{
	picker: SnippetPickerApi;
	/** The contenteditable the `;` is typed into. */
	field: HTMLElement | null;
}>();
</script>

<template>
	<PostboxSnippetPicker
		v-if="picker.open.value"
		:ref="picker.bindList"
		:items="picker.items.value"
		:anchor="picker.anchor.value"
		:field="field"
		@select="picker.insert"
		@dismiss="picker.dismiss"
	/>
	<PostboxSnippetVariableDialog
		:request="picker.prompt.value"
		@submit="picker.submitPrompt"
		@cancel="picker.cancelPrompt"
	/>
</template>
