<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { useReducedMotion } from '@owlat/ui/composables/useReducedMotion';
import type { ChatMessageRow } from '~/composables/chat/useChatRoom';

interface Props {
	messages: ChatMessageRow[];
	currentUserId: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
	edit: [messageId: Id<'chatMessages'>, text: string];
	delete: [messageId: Id<'chatMessages'>];
}>();

const { t, locale } = useI18n();

const scrollerRef = ref<HTMLElement | null>(null);
const reducedMotion = useReducedMotion();

// Group messages by date for date separators.
const groupedMessages = computed(() => {
	const dateFormat = new Intl.DateTimeFormat(locale.value, {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	});
	const groups: { date: string; messages: ChatMessageRow[] }[] = [];
	let currentDate = '';
	for (const message of props.messages) {
		const messageDate = dateFormat.format(new Date(message.createdAt));
		if (messageDate !== currentDate) {
			currentDate = messageDate;
			groups.push({ date: messageDate, messages: [] });
		}
		groups[groups.length - 1]!.messages.push(message);
	}
	return groups;
});

const isOwnMessage = (message: ChatMessageRow) => message.authorId === props.currentUserId;

/**
 * How close to the bottom (px) still counts as "reading the latest". Someone
 * scrolled up further than this is reading history, and a new message must not
 * yank them away from it.
 */
const STICK_TO_BOTTOM_PX = 80;

const scrollToBottom = (behavior: ScrollBehavior) => {
	const el = scrollerRef.value;
	if (!el) return;
	el.scrollTo({ top: el.scrollHeight, behavior });
};

// Opening a room lands on the newest message at once. A smooth scroll here
// animated through the whole history on every open.
onMounted(() => scrollToBottom('auto'));

// A new message at the end follows the conversation only if the viewer was
// already at the bottom, or it is their own (they just sent it). This watcher
// runs before the DOM patch, so the distance is measured on the old content.
// Keyed on the last message id, not the length: older messages loaded above
// and edits are not new arrivals, and neither is the last message being
// deleted (the previous last id is then gone from the list).
watch(
	() => props.messages.at(-1)?._id,
	(lastId, previousLastId) => {
		if (!lastId || lastId === previousLastId) return;
		if (previousLastId && !props.messages.some((m) => m._id === previousLastId)) return;
		const el = scrollerRef.value;
		if (!el) return;
		const wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_PX;
		const newest = props.messages.at(-1);
		if (!wasNearBottom && !(newest && isOwnMessage(newest))) return;
		const behavior: ScrollBehavior = reducedMotion.value ? 'auto' : 'smooth';
		nextTick(() => scrollToBottom(behavior));
	}
);
</script>

<template>
	<div ref="scrollerRef" class="flex-1 overflow-y-auto px-4 py-4">
		<div
			v-if="messages.length === 0"
			class="flex flex-col items-center justify-center h-full text-center py-12"
		>
			<div
				class="w-12 h-12 rounded-full bg-bg-surface border border-border-subtle flex items-center justify-center mb-4"
			>
				<Icon name="lucide:message-circle" class="w-6 h-6 text-text-tertiary" />
			</div>
			<p class="text-text-secondary font-medium">
				{{ t('components.chat.chatMessageList.emptyTitle') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1">
				{{ t('components.chat.chatMessageList.emptyBody') }}
			</p>
		</div>

		<template v-else>
			<div v-for="group in groupedMessages" :key="group.date" class="mb-4">
				<div class="flex items-center gap-4 mb-2">
					<div class="flex-1 h-px bg-border-subtle" />
					<span class="text-[11px] text-text-tertiary font-medium flex-shrink-0">
						{{ group.date }}
					</span>
					<div class="flex-1 h-px bg-border-subtle" />
				</div>

				<div class="space-y-0.5">
					<ChatMessage
						v-for="message in group.messages"
						:key="message._id"
						:message="message"
						:is-own-message="isOwnMessage(message)"
						:current-user-id="currentUserId"
						@edit="(id, text) => emit('edit', id, text)"
						@delete="(id) => emit('delete', id)"
					/>
				</div>
			</div>
		</template>
	</div>
</template>
