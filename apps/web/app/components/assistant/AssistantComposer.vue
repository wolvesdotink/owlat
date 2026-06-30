<script setup lang="ts">
const props = defineProps<{ streaming?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ send: [text: string]; stop: [] }>();

const text = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const canSend = computed(() => text.value.trim().length > 0 && !props.disabled);

const grow = () => {
	const ta = textareaRef.value;
	if (!ta) return;
	ta.style.height = 'auto';
	ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
};

const submit = () => {
	if (!canSend.value) return;
	emit('send', text.value.trim());
	text.value = '';
	nextTick(() => {
		if (textareaRef.value) textareaRef.value.style.height = 'auto';
	});
};

const handleKeydown = (event: KeyboardEvent) => {
	if (event.key === 'Enter' && !event.shiftKey) {
		event.preventDefault();
		submit();
	}
};
</script>

<template>
	<div class="border-t border-border-subtle bg-bg-elevated px-4 py-3">
		<div class="flex items-end gap-2">
			<textarea
				ref="textareaRef"
				v-model="text"
				:placeholder="disabled ? 'Assistant is unavailable' : 'Ask the assistant anything…'"
				:disabled="disabled"
				rows="1"
				class="flex-1 resize-none bg-bg-surface border border-border-subtle rounded-xl px-4 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors disabled:opacity-60"
				@keydown="handleKeydown"
				@input="grow"
			/>

			<button
				v-if="streaming"
				class="flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center bg-bg-surface border border-border-subtle text-text-secondary hover:text-text-primary transition-colors"
				title="Stop generating"
				aria-label="Stop generating"
				@click="emit('stop')"
			>
				<Icon name="lucide:square" class="w-4 h-4" />
			</button>
			<button
				v-else
				:disabled="!canSend"
				class="flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-colors"
				:class="
					canSend
						? 'bg-brand text-white hover:bg-brand/90'
						: 'bg-bg-surface text-text-tertiary border border-border-subtle cursor-not-allowed'
				"
				title="Send"
				aria-label="Send"
				@click="submit"
			>
				<Icon name="lucide:send" class="w-4 h-4" />
			</button>
		</div>
		<p class="text-[11px] text-text-tertiary mt-1.5 px-1">
			Enter to send · Shift+Enter for newline · the assistant can search your workspace and draft copy
		</p>
	</div>
</template>
