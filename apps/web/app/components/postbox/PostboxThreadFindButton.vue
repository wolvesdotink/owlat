<script setup lang="ts">
/**
 * The visible way into find in conversation, beside the thread's verbs; its
 * tooltip names the shortcut as this person has it bound.
 */
import { SearchIcon } from '@coolicons/vue';

const emit = defineEmits<{ click: [] }>();

const { t } = useI18n();
const { ariaFor } = useShortcutLabels();
</script>

<template>
	<UiTooltip :text="t('components.postbox.threadFind.open')">
		<template #shortcut><UiShortcut id="global.findInConversation" /></template>
		<UiButton
			variant="ghost"
			size="sm"
			class="flex-shrink-0"
			:aria-label="t('components.postbox.threadFind.open')"
			:aria-keyshortcuts="ariaFor('global.findInConversation')"
			data-testid="thread-find-open"
			@click="emit('click')"
		>
			<SearchIcon class="w-4 h-4" aria-hidden="true" />
		</UiButton>
	</UiTooltip>
</template>
