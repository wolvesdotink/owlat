<script setup lang="ts">
/**
 * One message of the thread reader under the chat layout: its bubble, or the
 * ordinary card (the slot) with a way back to the bubble. Without the chat
 * layout it is the card alone.
 */
import type { PostboxReaderMessage } from '~/composables/postbox/postboxReaderMessage';
import type { PostboxThreadChat } from '~/composables/postbox/usePostboxThreadChat';

const props = defineProps<{ chat: PostboxThreadChat; message: PostboxReaderMessage }>();

const { t } = useI18n();
const own = computed(() => props.chat.isOwn(props.message));
</script>

<template>
	<PostboxChatBubble
		v-if="chat.isBubble(message)"
		:message="message"
		:own="own"
		@show-full="chat.showFull(message._id)"
		@secure="chat.keepCard(message._id)"
		@preview="(att, all) => chat.previewAttachment(message._id, att, all)"
		@download="(att) => chat.downloadAttachment(message._id, att)"
	/>
	<div v-else-if="chat.isShownFull(message._id)" class="space-y-1">
		<button
			type="button"
			class="flex items-center gap-1 rounded px-1 text-xs text-text-tertiary outline-none hover:text-text-primary focus-visible:ring-1 focus-visible:ring-brand/40"
			:class="own ? 'ml-auto' : ''"
			data-testid="chat-show-bubble"
			@click="chat.showBubble(message._id)"
		>
			<Icon name="lucide:message-circle" class="h-3.5 w-3.5" aria-hidden="true" />
			{{ t('components.postbox.threadChat.backToChat') }}
		</button>
		<slot />
	</div>
	<slot v-else />
</template>
