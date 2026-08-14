<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

interface Author {
	name: string | null;
	email: string | null;
	image: string | null;
}

interface Message {
	_id: Id<'chatMessages'>;
	authorId: string;
	text: string;
	mentions?: string[];
	attachmentIds?: Id<'mediaAssets'>[];
	editedAt?: number;
	deletedAt?: number;
	createdAt: number;
	author: Author;
}

interface Props {
	messages: Message[];
	currentUserId: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
	edit: [messageId: Id<'chatMessages'>, text: string];
	delete: [messageId: Id<'chatMessages'>];
}>();

const { t, locale } = useI18n();

const messagesEndRef = ref<HTMLElement | null>(null);

// Group messages by date for date separators.
const groupedMessages = computed(() => {
	const dateFormat = new Intl.DateTimeFormat(locale.value, {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	});
	const groups: { date: string; messages: Message[] }[] = [];
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

const isOwnMessage = (message: Message) => message.authorId === props.currentUserId;

const scrollToBottom = () => {
	nextTick(() => {
		messagesEndRef.value?.scrollIntoView({ behavior: 'smooth' });
	});
};

watch(() => props.messages.length, scrollToBottom);
onMounted(scrollToBottom);
</script>

<template>
	<div class="flex-1 overflow-y-auto px-4 py-4">
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

		<div ref="messagesEndRef" />
	</div>
</template>
