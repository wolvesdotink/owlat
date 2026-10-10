<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * "Ask about this thread": a grounded Q&A about THIS thread (single-turn
 * mail.ai.askThread; ephemeral in-memory history, never saved), opened from
 * the reader's Overview and from Answer mode's top-bar menu. It opens focused
 * and closes with `close`.
 *
 * The strip once also carried the thread's AI summary line; the thread brief
 * replaced it (ADR-0072), so Ask is all that is left.
 */
const props = defineProps<{
	messageId: string;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

type Turn = { question: string; answer: string };
const question = ref('');
const askHistory = ref<Turn[]>([]);
const askErrored = ref(false);
const askOp = useBackendOperation(api.mail.ai.assist.askThread, {
	label: () => t('components.postbox.postboxAiStrip.askOperation'),
	type: 'action',
});
const askBusy = computed(() => askOp.isLoading.value);

async function submitAsk() {
	const q = question.value.trim();
	if (!q || askBusy.value) return;
	askErrored.value = false;
	const res = await askOp.run({
		messageId: props.messageId as Id<'mailMessages'>,
		question: q,
		history: askHistory.value.map((t) => ({ question: t.question, answer: t.answer })),
	});
	if (res.ok && res.result.answer) {
		askHistory.value.push({ question: q, answer: res.result.answer });
		question.value = '';
	} else {
		askErrored.value = true;
	}
}
function clearAsk() {
	question.value = '';
	askErrored.value = false;
}

const askInput = ref<HTMLInputElement | null>(null);
onMounted(() => askInput.value?.focus());

// Reset every ephemeral bit of state when the open thread changes.
watch(
	() => props.messageId,
	() => {
		question.value = '';
		askHistory.value = [];
		askErrored.value = false;
	}
);
</script>

<template>
	<div
		class="pbx-ai-strip rounded-lg border border-border-subtle bg-bg-elevated"
		data-testid="postbox-ai-strip"
	>
		<div class="flex items-center gap-2 px-3 py-2">
			<Icon name="lucide:sparkles" class="w-3.5 h-3.5 text-text-tertiary shrink-0" />
			<p class="flex-1 text-xs font-medium text-text-secondary">
				{{ t('components.postbox.postboxAiStrip.askAbout') }}
			</p>
			<button
				type="button"
				class="shrink-0 text-xs text-text-tertiary hover:text-text-primary"
				data-testid="postbox-ask-close"
				@click="emit('close')"
			>
				{{ t('common.close') }}
			</button>
		</div>
		<!-- Ask: grounded Q&A about THIS thread (ephemeral history). -->
		<div class="px-3 pb-3 space-y-3" data-testid="postbox-ask-thread">
			<div
				v-for="(turn, i) in askHistory"
				:key="i"
				class="space-y-1.5 rounded-lg border border-border-subtle bg-bg-surface p-3"
			>
				<p class="text-xs font-medium text-text-tertiary">{{ turn.question }}</p>
				<AssistantMarkdown :source="turn.answer" />
			</div>

			<div aria-live="polite" :aria-busy="askBusy">
				<p v-if="askBusy" class="flex items-center gap-1.5 text-xs text-text-tertiary">
					<Icon
						name="lucide:loader-2"
						class="w-3.5 h-3.5 animate-spin motion-reduce:animate-none"
					/>
					{{ t('components.postbox.postboxAiStrip.thinking') }}
				</p>
				<p v-else-if="askErrored" class="text-xs text-text-tertiary">
					{{ t('components.postbox.postboxAiStrip.askFailed') }}
				</p>
			</div>

			<div
				class="input input-sm flex items-center gap-2 rounded-full py-1.5 focus-within:ring-1 focus-within:ring-brand"
			>
				<Icon name="lucide:sparkles" class="w-4 h-4 shrink-0 text-text-tertiary" />
				<input
					ref="askInput"
					v-model="question"
					type="text"
					class="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
					:placeholder="t('components.postbox.postboxAiStrip.askPlaceholder')"
					:aria-label="t('components.postbox.postboxAiStrip.askAbout')"
					:disabled="askBusy"
					@keydown.enter.prevent="submitAsk"
					@keydown.esc.prevent="clearAsk"
				/>
				<button
					v-if="question.trim()"
					type="button"
					class="shrink-0 text-text-tertiary hover:text-text-primary disabled:opacity-50"
					:aria-label="t('components.postbox.postboxAiStrip.ask')"
					:disabled="askBusy"
					@click="submitAsk"
				>
					<Icon name="lucide:corner-down-left" class="w-4 h-4" />
				</button>
			</div>
		</div>
	</div>
</template>
