<script setup lang="ts">
import type { AssistantToolCall } from './AssistantToolCalls.vue';

export interface AssistantMessageData {
	_id: string;
	role: 'user' | 'assistant';
	text: string;
	status: 'streaming' | 'complete' | 'stopped' | 'error';
	toolCalls: AssistantToolCall[];
	errorMessage: string | null;
	model?: string | null;
	createdAt: number;
}

const props = defineProps<{ message: AssistantMessageData }>();

const isUser = computed(() => props.message.role === 'user');
const isStreaming = computed(() => props.message.status === 'streaming');
const hasText = computed(() => props.message.text.trim().length > 0);
// Typing indicator only before any text or tool activity has surfaced.
const showTyping = computed(
	() => isStreaming.value && !hasText.value && props.message.toolCalls.length === 0,
);
</script>

<template>
	<!-- User turn: right-aligned bubble -->
	<div v-if="isUser" class="flex justify-end">
		<div
			class="max-w-[85%] rounded-2xl rounded-br-sm bg-brand-subtle text-text-primary px-4 py-2 text-sm whitespace-pre-wrap break-words"
		>
			{{ message.text }}
		</div>
	</div>

	<!-- Assistant turn: full-width block -->
	<div v-else class="flex gap-3">
		<div
			class="w-8 h-8 rounded-full bg-brand-subtle text-brand flex-shrink-0 flex items-center justify-center"
		>
			<Icon name="lucide:sparkles" class="w-4 h-4" />
		</div>
		<div class="flex-1 min-w-0">
			<div class="text-xs font-semibold text-text-secondary mb-1">Assistant</div>

			<AssistantToolCalls v-if="message.toolCalls.length > 0" :tool-calls="message.toolCalls" />

			<!-- Typing indicator before any output -->
			<div v-if="showTyping" class="flex items-center gap-1 py-1" aria-label="Assistant is typing">
				<span class="w-1.5 h-1.5 rounded-full bg-text-tertiary animate-bounce" style="animation-delay: 0ms" />
				<span class="w-1.5 h-1.5 rounded-full bg-text-tertiary animate-bounce" style="animation-delay: 150ms" />
				<span class="w-1.5 h-1.5 rounded-full bg-text-tertiary animate-bounce" style="animation-delay: 300ms" />
			</div>

			<div v-else-if="hasText" class="relative">
				<AssistantMarkdown :source="message.text" />
				<span
					v-if="isStreaming"
					class="inline-block w-1.5 h-4 align-text-bottom bg-text-secondary animate-pulse ml-0.5"
				/>
			</div>

			<p v-if="message.status === 'error'" class="mt-1 text-xs text-error">
				{{ message.errorMessage || 'The assistant could not complete this reply.' }}
			</p>
			<p v-else-if="message.status === 'stopped'" class="mt-1 text-xs text-text-tertiary italic">
				Stopped
			</p>
		</div>
	</div>
</template>
