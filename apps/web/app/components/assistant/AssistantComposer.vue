<script setup lang="ts">
import { useAcknowledgedDraft } from '~/composables/useAcknowledgedDraft';
import { useComposerDraft } from '~/composables/useComposerDrafts';
import { isImeComposing } from '~/utils/imeComposition';
import {
	caretOnFirstLine,
	caretOnLastLine,
	composerRecallDirection,
	stepPromptHistory,
	type ComposerRecallDirection,
	type PromptHistoryEntry,
	type PromptHistoryPosition,
} from '~/utils/composerRecall';
import { PaperPlaneIcon, SquareIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const props = defineProps<{
	/**
	 * Delivers the question. An awaited callback rather than an event, because
	 * the composer needs the answer: the question stays put until this resolves
	 * `ok`, so a failed send is still there to retry (same contract as ChatInput).
	 */
	send: (text: string) => Promise<{ ok: boolean }>;
	streaming?: boolean;
	disabled?: boolean;
	/** Keeps the unsent question on this device under this name. */
	draftTarget?: string | null;
	/** The questions asked in the open conversation, oldest first, for ↑ / ↓. */
	promptHistory?: readonly PromptHistoryEntry[];
	/**
	 * The conversation `promptHistory` belongs to. One box serves every
	 * conversation, so a question recalled in one is never stepped from in
	 * another.
	 */
	historyKey?: string | null;
}>();
const emit = defineEmits<{ stop: [] }>();

const { t } = useI18n();

const { draft, pin } = useComposerDraft('assistant', () => props.draftTarget, { text: '' });
const text = computed({
	get: () => draft.value.text,
	set: (next: string) => (draft.value = { text: next }),
});
const textareaRef = ref<HTMLTextAreaElement | null>(null);
// The placeholder disappears once the member types, so the field carries its
// own name, and the Enter / Shift+Enter hint is wired to it as its description.
const fieldId = useId();
const hintId = useId();

// A send settles the question it started from, even after an account switch.
const { isSending, submit } = useAcknowledgedDraft(text, () => {
	const settle = pin();
	return (update) => settle((now) => ({ text: update(now.text) }));
});
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

// The entry ↑ / ↓ last put in the box, and the conversation it came from.
const recalled = shallowRef<{
	key: string | null | undefined;
	position: PromptHistoryPosition;
} | null>(null);

/**
 * ↑ in an empty box brings back the last question; further ↑ / ↓ step through
 * the earlier ones while the box still holds exactly the recalled text and the
 * caret has no line left to move to. True when the key was used.
 */
const stepHistory = (direction: ComposerRecallDirection, field: HTMLTextAreaElement): boolean => {
	if (props.disabled || isSending.value) return false;
	const last = recalled.value;
	const position = last && last.key === props.historyKey ? last.position : null;
	if (position === null && text.value !== '') return false;
	if (!(direction === 'older' ? caretOnFirstLine(field) : caretOnLastLine(field))) return false;
	const step = stepPromptHistory({
		direction,
		entries: props.promptHistory ?? [],
		position,
		current: text.value,
	});
	if (!step) return false;
	recalled.value = step.position ? { key: props.historyKey, position: step.position } : null;
	text.value = step.prompt;
	nextTick(() => {
		grow();
		field.setSelectionRange(field.value.length, field.value.length);
	});
	return true;
};

const focus = () => textareaRef.value?.focus();

defineExpose({ sendText, focus });

const handleKeydown = (event: KeyboardEvent) => {
	// An IME's confirming Enter finishes the word, it does not send.
	if (isImeComposing(event)) return;
	const direction = composerRecallDirection(event);
	if (direction && textareaRef.value && stepHistory(direction, textareaRef.value)) {
		event.preventDefault();
		return;
	}
	if (event.key === 'Enter' && !event.shiftKey) {
		event.preventDefault();
		void send();
	}
};
</script>

<template>
	<div class="border-t border-border-subtle bg-bg-elevated px-4 py-3">
		<!-- The conversation above is a max-w-3xl column; the composer shares it,
		     so on a wide screen the field and Send stay under the messages
		     instead of spanning the whole pane. -->
		<div class="mx-auto max-w-3xl">
			<div class="flex items-end gap-2">
				<label :for="fieldId" class="sr-only">
					{{ t('components.assistant.assistantComposer.label') }}
				</label>
				<textarea
					:id="fieldId"
					ref="textareaRef"
					v-model="text"
					:placeholder="
						disabled
							? t('components.assistant.assistantComposer.unavailablePlaceholder')
							: t('components.assistant.assistantComposer.placeholder')
					"
					:disabled="disabled"
					:aria-describedby="hintId"
					rows="1"
					class="input flex-1 resize-none disabled:opacity-60"
					@keydown="handleKeydown"
					@input="grow"
				/>

				<UiTooltip v-if="streaming" :text="t('components.assistant.assistantComposer.stop')">
					<UiButton
						variant="secondary"
						class="flex-shrink-0 w-10 h-10 p-0 rounded-xl"
						:aria-label="t('components.assistant.assistantComposer.stop')"
						@click="emit('stop')"
					>
						<SquareIcon class="w-4 h-4" />
					</UiButton>
				</UiTooltip>
				<!-- Send is `.btn-primary` — monochrome by design. A solid terracotta
				     fill pinned to the bottom of a full-height pane is the most saturated
				     thing on the screen, and this one competed with the assistant's own
				     accents (the sparkles glyph, the user bubble). UiButton also brings
				     the disabled state, so this button needs no recipe of its own. -->
				<UiTooltip v-else :text="t('common.send')">
					<UiButton
						variant="primary"
						:disabled="!canSend"
						class="flex-shrink-0 w-10 h-10 p-0 rounded-xl"
						:aria-label="t('common.send')"
						:aria-busy="isSending || undefined"
						data-testid="assistant-send"
						@click="send"
					>
						<SpinnerIcon v-if="isSending" class="w-4 h-4" />
						<PaperPlaneIcon v-else class="w-4 h-4" />
					</UiButton>
				</UiTooltip>
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
			<p :id="hintId" class="text-[11px] text-text-tertiary mt-1.5 px-1">
				{{ t('components.assistant.assistantComposer.hint') }}
			</p>
		</div>
	</div>
</template>
