<script setup lang="ts">
const props = defineProps<{ streaming?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ send: [text: string]; stop: [] }>();

const { t } = useI18n();

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
				:placeholder="
					disabled
						? t('components.assistant.assistantComposer.unavailablePlaceholder')
						: t('components.assistant.assistantComposer.placeholder')
				"
				:disabled="disabled"
				rows="1"
				class="flex-1 resize-none bg-bg-surface border border-border-subtle rounded-xl px-4 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors disabled:opacity-60"
				@keydown="handleKeydown"
				@input="grow"
			/>

			<UiButton
				v-if="streaming"
				variant="secondary"
				class="flex-shrink-0 w-10 h-10 p-0 rounded-xl"
				:title="t('components.assistant.assistantComposer.stop')"
				:aria-label="t('components.assistant.assistantComposer.stop')"
				@click="emit('stop')"
			>
				<Icon name="lucide:square" class="w-4 h-4" />
			</UiButton>
			<!-- Send is `.btn-primary` — monochrome by design. A solid terracotta
			     fill pinned to the bottom of a full-height pane is the most saturated
			     thing on the screen, and this one competed with the assistant's own
			     accents (the sparkles glyph, the user bubble). UiButton also brings
			     the disabled state, which used to be a third recipe written by hand. -->
			<UiButton
				v-else
				variant="primary"
				:disabled="!canSend"
				class="flex-shrink-0 w-10 h-10 p-0 rounded-xl"
				:title="t('common.send')"
				:aria-label="t('common.send')"
				@click="submit"
			>
				<Icon name="lucide:send" class="w-4 h-4" />
			</UiButton>
		</div>
		<p class="text-[11px] text-text-tertiary mt-1.5 px-1">
			{{ t('components.assistant.assistantComposer.hint') }}
		</p>
	</div>
</template>
