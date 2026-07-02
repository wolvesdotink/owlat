<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * "Ask about this thread…" — a one-line input at the reader footer that runs the
 * advisory assistant grounded in THIS conversation. Calls the single-turn
 * mail.ai.askThread action (thread transcript + prior Q/A, no tools), renders
 * the answer inline below the question, and keeps a small per-thread in-memory
 * history that is NOT persisted (it resets when the reader unmounts / the thread
 * changes). Fully fail-soft: an AI failure shows a quiet error line and leaves
 * the reader untouched — nothing is ever auto-sent.
 */
const props = defineProps<{
	messageId: string;
}>();

type Turn = { question: string; answer: string };

const question = ref('');
const history = ref<Turn[]>([]);
const errored = ref(false);

const askOp = useBackendOperation(api.mail.ai.askThread, {
	label: 'Ask about this thread',
	type: 'action',
});

const busy = computed(() => askOp.isLoading.value);

// Reset the ephemeral conversation whenever the open thread changes.
watch(
	() => props.messageId,
	() => {
		history.value = [];
		question.value = '';
		errored.value = false;
	}
);

async function submit() {
	const q = question.value.trim();
	if (!q || busy.value) return;
	errored.value = false;
	const res = await askOp.run({
		messageId: props.messageId as Id<'mailMessages'>,
		question: q,
		history: history.value.map((t) => ({ question: t.question, answer: t.answer })),
	});
	if (res && res.answer) {
		history.value.push({ question: q, answer: res.answer });
		question.value = '';
	} else {
		errored.value = true;
	}
}

function clear() {
	question.value = '';
	errored.value = false;
}
</script>

<template>
	<div class="mt-3 space-y-3" data-testid="postbox-ask-thread">
		<!-- Prior turns: the question, then the assistant's grounded answer. -->
		<div
			v-for="(turn, i) in history"
			:key="i"
			class="space-y-1.5 rounded-lg border border-border-subtle bg-bg-surface p-3"
		>
			<p class="text-xs font-medium text-text-tertiary">{{ turn.question }}</p>
			<AssistantMarkdown :source="turn.answer" />
		</div>

		<div aria-live="polite" :aria-busy="busy">
			<p v-if="busy" class="flex items-center gap-1.5 text-xs text-text-tertiary">
				<Icon name="lucide:loader-2" class="w-3.5 h-3.5 animate-spin" />
				Thinking…
			</p>
			<p v-else-if="errored" class="text-xs text-text-tertiary">
				Couldn't answer that right now. Try again in a moment.
			</p>
		</div>

		<div
			class="flex items-center gap-2 rounded-full border border-border-subtle bg-bg-surface px-3 py-1.5 focus-within:border-brand"
		>
			<Icon name="lucide:sparkles" class="w-4 h-4 shrink-0 text-text-tertiary" />
			<input
				v-model="question"
				type="text"
				class="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
				placeholder="Ask about this thread…"
				aria-label="Ask about this thread"
				:disabled="busy"
				@keydown.enter.prevent="submit"
				@keydown.esc.prevent="clear"
			/>
			<button
				v-if="question.trim()"
				type="button"
				class="shrink-0 text-text-tertiary hover:text-text-primary disabled:opacity-50"
				aria-label="Ask"
				:disabled="busy"
				@click="submit"
			>
				<Icon name="lucide:corner-down-left" class="w-4 h-4" />
			</button>
		</div>
	</div>
</template>
