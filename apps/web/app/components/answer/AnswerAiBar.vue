<script setup lang="ts">
/**
 * Answer mode's one AI entry point (plan §04): "What should the reply say?"
 * with an optional instruction, and "Draft with AI".
 *
 * Cmd/Ctrl+J inside Answer mode lands in the instruction field (the page asks
 * `useAnswerAiFocus`, this bar registers how). Enter drafts. While the AI
 * checks for gaps or writes, the bar says so and stays out of the way; once an
 * AI draft is in the editor a quiet "AI draft · Discard" tag offers to take it
 * back out. The page hides the bar when AI is off.
 */
import { useAnswerAiFocus } from '~/composables/useAnswerMode';
import type { AskPhase } from '~/composables/useAnswerAskSession';

const props = withDefaults(
	defineProps<{
		phase?: AskPhase;
		busy?: boolean;
		/** An AI draft is in the editor (offer Discard). */
		hasAiDraft?: boolean;
		/** The draft may repeat instructions hidden in the mail. */
		injectionFlagged?: boolean;
	}>(),
	{ phase: 'idle', busy: false, hasAiDraft: false, injectionFlagged: false }
);

const emit = defineEmits<{
	draft: [instruction: string];
	discard: [];
}>();

const { t } = useI18n();

const instruction = ref('');
const inputEl = ref<HTMLInputElement | null>(null);

function submit() {
	if (props.busy) return;
	emit('draft', instruction.value);
}

const unregister = useAnswerAiFocus().register(() => inputEl.value?.focus());
onBeforeUnmount(unregister);

const statusLine = computed(() => {
	if (props.phase === 'checking') return t('components.answer.aiBar.checking');
	if (props.phase === 'drafting') return t('components.answer.aiBar.drafting');
	if (props.phase === 'error') return t('components.answer.aiBar.failed');
	return '';
});

const inputId = useId();
</script>

<template>
	<div
		class="border-b border-border-subtle px-3 py-2"
		:aria-busy="busy"
		data-testid="answer-ai-bar"
	>
		<form class="flex items-center gap-2" @submit.prevent="submit">
			<Icon name="lucide:sparkles" class="size-4 shrink-0 text-brand" aria-hidden="true" />
			<label :for="inputId" class="sr-only">{{ t('components.answer.aiBar.label') }}</label>
			<input
				:id="inputId"
				ref="inputEl"
				v-model="instruction"
				type="text"
				class="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
				:placeholder="t('components.answer.aiBar.placeholder')"
				:disabled="busy"
				maxlength="500"
				data-testid="answer-ai-instruction"
			/>
			<UiButton
				type="submit"
				size="sm"
				variant="secondary"
				class="shrink-0"
				:disabled="busy"
				:title="t('components.answer.aiBar.shortcut')"
				data-testid="answer-ai-draft"
			>
				<Icon
					v-if="busy"
					name="lucide:loader-2"
					class="mr-1 size-3.5 animate-spin motion-reduce:animate-none"
					aria-hidden="true"
				/>
				{{ t('components.answer.aiBar.draft') }}
			</UiButton>
		</form>
		<p
			v-if="statusLine"
			class="mt-1 text-xs"
			:class="phase === 'error' ? 'text-error' : 'text-text-tertiary'"
			role="status"
			data-testid="answer-ai-status"
		>
			{{ statusLine }}
		</p>
		<p
			v-if="hasAiDraft && !busy"
			class="mt-1 flex items-center gap-1.5 text-xs text-text-tertiary"
			data-testid="answer-ai-draft-tag"
		>
			<span>{{ t('components.answer.aiBar.aiDraft') }}</span>
			<span aria-hidden="true">·</span>
			<button
				type="button"
				class="underline-offset-2 hover:text-text-primary hover:underline"
				data-testid="answer-ai-discard"
				@click="emit('discard')"
			>
				{{ t('components.answer.aiBar.discard') }}
			</button>
		</p>
		<p
			v-if="injectionFlagged && hasAiDraft"
			class="mt-1 text-xs text-warning"
			role="note"
			data-testid="answer-ai-injection"
		>
			{{ t('components.answer.aiBar.injectionFlagged') }}
		</p>
	</div>
</template>
