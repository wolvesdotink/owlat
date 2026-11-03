<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { BudgetHoldReason } from '@owlat/shared/aiRouting';
import { BUDGET_REASON_KEYS, budgetReasonOf } from '~/utils/aiBudget';
import { ArrowTurnDownLeftIcon, SparklesIcon, WalletIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

/**
 * "Ask about this thread": a grounded Q&A about THIS thread (single-turn
 * mail.ai.askThread; ephemeral in-memory history, never saved), opened from
 * the reader's Overview and from Answer mode's top-bar menu. It opens focused
 * and closes with `close`.
 *
 * The strip once also carried the thread's AI summary line; the thread brief
 * replaced it, so Ask is all that is left.
 */
const props = defineProps<{
	messageId: string;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

/** `isTruncated`: the answer stopped at its length limit, and says so. */
type Turn = { question: string; answer: string; isTruncated: boolean };
const question = ref('');
const askHistory = ref<Turn[]>([]);
const askErrored = ref(false);
/**
 * U5: the spend budget refused the question. It is not a failure to retry in
 * a moment, so the strip says which budget and why, in place of the generic
 * line and the toast.
 */
const budgetReason = ref<BudgetHoldReason | null>(null);
const askOp = useBackendOperation(api.mail.ai.assist.askThread, {
	label: () => t('components.postbox.postboxAiStrip.askOperation'),
	type: 'action',
	onError: (op) => {
		budgetReason.value = budgetReasonOf(op);
		return budgetReason.value !== null;
	},
});
const askBusy = computed(() => askOp.isLoading.value);

async function submitAsk() {
	const q = question.value.trim();
	if (!q || askBusy.value) return;
	askErrored.value = false;
	budgetReason.value = null;
	const res = await askOp.run({
		messageId: props.messageId as Id<'mailMessages'>,
		question: q,
		history: askHistory.value.map((t) => ({ question: t.question, answer: t.answer })),
	});
	if (res.ok && res.result.answer) {
		askHistory.value.push({
			question: q,
			answer: res.result.answer,
			isTruncated: res.result.isTruncated === true,
		});
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
		budgetReason.value = null;
	}
);
</script>

<template>
	<div
		class="pbx-ai-strip rounded-lg border border-border-subtle bg-bg-elevated"
		data-testid="postbox-ai-strip"
	>
		<div class="flex items-center gap-2 px-3 py-2">
			<SparklesIcon class="w-3.5 h-3.5 text-text-tertiary shrink-0" />
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
				<p
					v-if="turn.isTruncated"
					class="text-xs text-text-tertiary"
					data-testid="postbox-ask-cut-off"
				>
					{{ t('components.postbox.postboxAiStrip.cutOff') }}
				</p>
			</div>

			<div aria-live="polite" :aria-busy="askBusy">
				<p v-if="askBusy" class="flex items-center gap-1.5 text-xs text-text-tertiary">
					<SpinnerIcon class="w-3.5 h-3.5" />
					{{ t('components.postbox.postboxAiStrip.thinking') }}
				</p>
				<div
					v-else-if="budgetReason"
					class="flex items-start gap-2 rounded-md bg-warning-subtle/50 px-2.5 py-2 text-xs"
					role="status"
					data-testid="postbox-ask-budget"
					:data-reason="budgetReason"
				>
					<WalletIcon class="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
					<p>
						<span class="font-medium text-text-primary">{{ t('shared.aiBudget.title') }}</span>
						{{ ' ' }}
						<span class="text-text-secondary">{{ t(BUDGET_REASON_KEYS[budgetReason]) }}</span>
					</p>
				</div>
				<p v-else-if="askErrored" class="text-xs text-text-tertiary">
					{{ t('components.postbox.postboxAiStrip.askFailed') }}
				</p>
			</div>

			<div class="input input-sm flex items-center gap-2">
				<SparklesIcon class="w-4 h-4 shrink-0 text-text-tertiary" />
				<input
					ref="askInput"
					v-model="question"
					type="text"
					class="input-bare flex-1 text-sm"
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
					<ArrowTurnDownLeftIcon class="w-4 h-4" />
				</button>
			</div>
		</div>
	</div>
</template>
