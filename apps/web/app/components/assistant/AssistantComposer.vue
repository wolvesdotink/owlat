<script setup lang="ts">
import { useAcknowledgedDraft } from '~/composables/useAcknowledgedDraft';

const props = defineProps<{
	/**
	 * Delivers the question. An awaited callback rather than an event, because
	 * the composer needs the answer: the question stays put until this resolves
	 * `ok`, so a failed send is still there to retry (same contract as ChatInput).
	 */
	send: (text: string) => Promise<{ ok: boolean }>;
	streaming?: boolean;
	disabled?: boolean;
}>();
const emit = defineEmits<{ stop: [] }>();

const { t } = useI18n();

const text = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const { isSending, submit } = useAcknowledgedDraft(text);
// The last send was refused or failed. The operation has toasted it; this
// keeps the way back (Retry) next to the question it is about.
const failed = ref(false);

const canSend = computed(() => text.value.trim().length > 0 && !props.disabled && !isSending.value);

const grow = () => {
	const ta = textareaRef.value;
	if (!ta) return;
	ta.style.height = 'auto';
	ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
};

const send = async () => {
	if (!canSend.value) return;
	failed.value = false;
	const outcome = await submit((snapshot) => props.send(snapshot.trim()));
	if (!outcome) return;
	failed.value = !outcome.ok;
	nextTick(grow);
};

/**
 * Send a ready-made question (an example prompt) through the same path as a
 * typed one, so a failure leaves it here with Retry. A draft the member has
 * already started is never replaced: the prompt is added below it instead, and
 * nothing is sent until they press Send.
 */
const sendText = async (value: string) => {
	if (isSending.value) return;
	if (text.value.trim()) {
		text.value = `${text.value.replace(/\s+$/, '')}\n${value}`;
		nextTick(() => {
			grow();
			textareaRef.value?.focus();
		});
		return;
	}
	text.value = value;
	await send();
};

const focus = () => textareaRef.value?.focus();

defineExpose({ sendText, focus });

const handleKeydown = (event: KeyboardEvent) => {
	if (event.key === 'Enter' && !event.shiftKey) {
		event.preventDefault();
		void send();
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
				:aria-busy="isSending || undefined"
				data-testid="assistant-send"
				@click="send"
			>
				<Icon
					v-if="isSending"
					name="lucide:loader-2"
					class="w-4 h-4 animate-spin motion-reduce:animate-none"
				/>
				<Icon v-else name="lucide:send" class="w-4 h-4" />
			</UiButton>
		</div>
		<div aria-live="polite">
			<p
				v-if="failed"
				class="text-xs text-error mt-1.5 px-1 flex flex-wrap items-center gap-x-1.5"
				data-testid="assistant-send-failed"
			>
				<span>{{ t('components.assistant.assistantComposer.sendFailed') }}</span>
				<button
					type="button"
					class="font-medium underline underline-offset-2 rounded hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60"
					:disabled="!canSend"
					@click="send"
				>
					{{ t('common.retry') }}
				</button>
			</p>
		</div>
		<p class="text-[11px] text-text-tertiary mt-1.5 px-1">
			{{ t('components.assistant.assistantComposer.hint') }}
		</p>
	</div>
</template>
