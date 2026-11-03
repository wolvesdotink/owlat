<script setup lang="ts">
/**
 * The reader header's switch between the stacked conversation and the chat
 * layout (usePostboxThreadChat), beside the thread's verbs. Its tooltip names
 * the shortcut as this person has it bound.
 */
import type { PostboxThreadChat } from '~/composables/postbox/usePostboxThreadChat';

defineProps<{ chat: PostboxThreadChat }>();

const { t } = useI18n();
const { ariaFor } = useShortcutLabels();
</script>

<template>
	<UiTooltip
		v-if="chat.isAvailable.value"
		:text="
			chat.isOn.value
				? t('components.postbox.threadChat.showConversation')
				: t('components.postbox.threadChat.showChat')
		"
	>
		<template #shortcut><UiShortcut id="postbox.chatView" /></template>
		<UiButton
			variant="ghost"
			size="sm"
			class="flex-shrink-0"
			:class="{ 'bg-bg-surface text-text-primary': chat.isOn.value }"
			:aria-label="t('components.postbox.threadChat.toggle')"
			:aria-pressed="chat.isOn.value"
			:aria-keyshortcuts="ariaFor('postbox.chatView')"
			data-testid="thread-chat-toggle"
			@click="chat.toggle()"
		>
			<Icon name="lucide:message-circle" class="w-4 h-4" aria-hidden="true" />
		</UiButton>
	</UiTooltip>
</template>
