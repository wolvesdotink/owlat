<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { AssistantToolCall } from '~/components/assistant/AssistantToolCalls.vue';

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
	// AI assistant reply fields (set only for @assistant messages).
	isAssistant?: boolean;
	aiStatus?: 'streaming' | 'complete' | 'stopped' | 'error';
	toolCalls?: AssistantToolCall[];
}

interface Props {
	message: Message;
	isOwnMessage: boolean;
	currentUserId: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
	edit: [messageId: Id<'chatMessages'>, text: string];
	delete: [messageId: Id<'chatMessages'>];
}>();

const isEditing = ref(false);
const editText = ref(props.message.text);

const displayName = computed(() => {
	if (props.message.author.name) return props.message.author.name;
	if (props.message.author.email) return props.message.author.email;
	return 'Unknown';
});

const avatarSeed = computed(
	() => props.message.author.name ?? props.message.author.email ?? props.message.authorId,
);

const formattedTime = computed(() => {
	const date = new Date(props.message.createdAt);
	return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
});

const isMentioned = computed(() =>
	(props.message.mentions ?? []).includes(props.currentUserId),
);

// Render the text with @-mentions visually emphasized.
const segments = computed(() => {
	const text = props.message.text;
	const parts: { kind: 'text' | 'mention'; value: string }[] = [];
	const regex = /@([a-zA-Z0-9_\-.]{1,64})/g;
	let cursor = 0;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(text)) !== null) {
		if (match.index > cursor) {
			parts.push({ kind: 'text', value: text.slice(cursor, match.index) });
		}
		parts.push({ kind: 'mention', value: match[0] });
		cursor = match.index + match[0].length;
	}
	if (cursor < text.length) {
		parts.push({ kind: 'text', value: text.slice(cursor) });
	}
	return parts;
});

const startEdit = () => {
	if (props.message.deletedAt) return;
	editText.value = props.message.text;
	isEditing.value = true;
};
const cancelEdit = () => {
	isEditing.value = false;
};
const saveEdit = () => {
	const trimmed = editText.value.trim();
	if (!trimmed || trimmed === props.message.text) {
		cancelEdit();
		return;
	}
	emit('edit', props.message._id, trimmed);
	isEditing.value = false;
};
const doDelete = () => {
	emit('delete', props.message._id);
};

const attachmentIds = computed(() => props.message.attachmentIds ?? []);
const hasAttachments = computed(() => attachmentIds.value.length > 0);
const { attachments } = useChatAttachmentDetails(() =>
	hasAttachments.value ? props.message._id : null,
);

// AI assistant reply rendering (@assistant messages).
const isAssistant = computed(() => props.message.isAssistant === true);
const aiToolCalls = computed(() => props.message.toolCalls ?? []);
const aiStreaming = computed(() => props.message.aiStatus === 'streaming');
const aiHasText = computed(() => props.message.text.trim().length > 0);
const aiTyping = computed(
	() => aiStreaming.value && !aiHasText.value && aiToolCalls.value.length === 0,
);
</script>

<template>
	<div
		class="group flex gap-3 px-2 py-1 rounded transition-colors"
		:class="isMentioned ? 'bg-warning/5 -mx-2' : 'hover:bg-bg-surface/50 -mx-2'"
	>
		<!-- Avatar -->
		<div
			v-if="isAssistant"
			class="w-9 h-9 rounded-full bg-brand-subtle text-brand flex-shrink-0 flex items-center justify-center"
		>
			<Icon name="lucide:sparkles" class="w-4 h-4" />
		</div>
		<UiAvatar
			v-else
			:name="avatarSeed"
			:image="message.author.image"
			size="lg"
			class="flex-shrink-0"
		/>

		<div class="flex-1 min-w-0">
			<div class="flex items-baseline gap-2">
				<span class="text-sm font-semibold text-text-primary truncate">{{ displayName }}</span>
				<span class="text-[11px] text-text-tertiary">{{ formattedTime }}</span>
				<span v-if="message.editedAt" class="text-[11px] text-text-tertiary italic">edited</span>
			</div>

			<!-- Edit mode -->
			<div v-if="isEditing" class="mt-1">
				<textarea
					v-model="editText"
					rows="2"
					class="w-full input text-sm resize-none"
					@keydown.enter.exact.prevent="saveEdit"
					@keydown.escape.prevent="cancelEdit"
				/>
				<div class="flex gap-2 mt-1">
					<button class="btn btn-secondary btn-sm" @click="cancelEdit">Cancel</button>
					<button class="btn btn-primary btn-sm" @click="saveEdit">Save</button>
				</div>
			</div>

			<!-- Display mode -->
			<template v-else>
				<div
					v-if="message.deletedAt"
					class="text-sm text-text-tertiary italic"
				>
					(this message was deleted)
				</div>
				<!-- AI assistant reply: tool cards + streamed Markdown -->
				<div v-else-if="isAssistant">
					<AssistantToolCalls v-if="aiToolCalls.length > 0" :tool-calls="aiToolCalls" />
					<div v-if="aiTyping" class="flex items-center gap-1 py-1" aria-label="Assistant is typing">
						<span class="w-1.5 h-1.5 rounded-full bg-text-tertiary animate-bounce" style="animation-delay: 0ms" />
						<span class="w-1.5 h-1.5 rounded-full bg-text-tertiary animate-bounce" style="animation-delay: 150ms" />
						<span class="w-1.5 h-1.5 rounded-full bg-text-tertiary animate-bounce" style="animation-delay: 300ms" />
					</div>
					<div v-else-if="aiHasText" class="relative">
						<AssistantMarkdown :source="message.text" />
						<span
							v-if="aiStreaming"
							class="inline-block w-1.5 h-4 align-text-bottom bg-text-secondary animate-pulse ml-0.5"
						/>
					</div>
				</div>
				<div
					v-else
					class="text-sm leading-relaxed whitespace-pre-wrap break-words text-text-primary"
				>
					<template v-for="(segment, idx) in segments" :key="idx">
						<span
							v-if="segment.kind === 'mention'"
							class="px-1 py-0.5 rounded bg-brand-subtle text-brand font-medium"
						>{{ segment.value }}</span>
						<template v-else>{{ segment.value }}</template>
					</template>
				</div>

				<!-- Attachments -->
				<div v-if="hasAttachments" class="mt-2 flex flex-wrap gap-2">
					<ChatAttachmentChip
						v-for="attachment in attachments"
						:key="attachment._id"
						:attachment="attachment"
					/>
				</div>
			</template>
		</div>

		<!-- Hover actions -->
		<div
			v-if="!isEditing && !message.deletedAt && isOwnMessage"
			class="opacity-0 group-hover:opacity-100 transition-opacity flex items-start gap-1"
		>
			<button
				class="w-7 h-7 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary flex items-center justify-center"
				title="Edit"
				@click="startEdit"
			>
				<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
			</button>
			<button
				class="w-7 h-7 rounded hover:bg-bg-elevated text-text-tertiary hover:text-error flex items-center justify-center"
				title="Delete"
				@click="doDelete"
			>
				<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
			</button>
		</div>
	</div>
</template>
