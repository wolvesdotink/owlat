<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * The reader's ONE AI home, now one LINE: the gist of the cached thread summary
 * (click "more" for the bullets) and an "Ask" link that expands a grounded Q&A
 * about THIS thread inline (single-turn mail.ai.askThread; ephemeral in-memory
 * history, never saved).
 *
 * "Draft reply" used to live here too, at the top of the thread — a long way
 * from the reply box it feeds. It moved into PostboxInlineReply (plan §05),
 * where the reply actually gets written; the same `ai` flag gates both.
 *
 * Fail-soft throughout: the summary reads the cache reactively and generates
 * lazily WITHOUT blocking the thread render; any AI failure just hides that part.
 * The whole strip renders NOTHING (zero height) when there is no summary and the
 * thread is too short to warrant one — the parent passes `warrants-summary` (the
 * long-thread predicate + the per-user auto-summary toggle) for that decision.
 *
 * Presentation consolidation only: the underlying mail.ai actions are unchanged.
 */
const props = defineProps<{
	messageId: string;
	// Whether this thread is long enough (and auto-summary is on) to eagerly
	// generate a summary. When false the summary line is only shown if one is
	// already cached; if neither, the strip collapses to nothing.
	warrantsSummary: boolean;
}>();

const { t } = useI18n();

// --- Summary (formerly PostboxThreadSummary): warm-read → lazy-gen → render.
const summaryExpanded = ref(false);
const generated = ref<{ summary: string; messageCount: number } | null>(null);
const summaryFailed = ref(false);
let summaryAttempted = false;

const cacheQuery = useConvexQuery(api.mail.ai.summaryCache.getThreadSummary, () => ({
	messageId: props.messageId as Id<'mailMessages'>,
}));
const summaryGenOp = useBackendOperation(api.mail.ai.assist.getOrGenerateThreadSummary, {
	label: () => t('components.postbox.postboxAiStrip.summarizeOperation'),
	type: 'action',
});

const cachedSummary = computed(
	() => cacheQuery.data.value as { summary: string; messageCount: number } | null | undefined
);
const summaryText = computed(
	() => cachedSummary.value?.summary ?? generated.value?.summary ?? null
);

// Split the plain-text summary (2–4 lines/bullets) into clean bullet strings,
// stripping any leading "-", "*", "•" or "1." markers the model added.
const bullets = computed(() => {
	const raw = summaryText.value;
	if (!raw) return [];
	return raw
		.split('\n')
		.map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
		.filter((l) => l.length > 0);
});
const oneLine = computed(() => bullets.value.join(' · '));

const summaryPending = computed(
	() =>
		props.warrantsSummary &&
		!summaryText.value &&
		!summaryFailed.value &&
		(cacheQuery.isLoading.value || summaryGenOp.isLoading.value)
);

async function maybeGenerateSummary() {
	if (!props.warrantsSummary || summaryAttempted || summaryFailed.value) return;
	// Wait for the reactive cache read to settle; a warm cache means no dispatch.
	if (cacheQuery.isLoading.value) return;
	if (cachedSummary.value) return;
	summaryAttempted = true;
	const res = await summaryGenOp.run({ messageId: props.messageId as Id<'mailMessages'> });
	if (res.ok && res.result && res.result.summary) {
		generated.value = { summary: res.result.summary, messageCount: res.result.messageCount };
	} else {
		summaryFailed.value = true;
	}
}

watch(
	[() => cacheQuery.isLoading.value, () => props.warrantsSummary],
	() => void maybeGenerateSummary(),
	{ immediate: true }
);

// --- Ask (formerly PostboxAskThread): single-turn grounded Q&A, ephemeral.
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

// --- Ask is the strip's only expandable section; closed until asked for.
const askOpen = ref(false);

function toggleAsk() {
	askOpen.value = !askOpen.value;
}

// Reset every ephemeral bit of state when the open thread changes.
watch(
	() => props.messageId,
	() => {
		summaryExpanded.value = false;
		generated.value = null;
		summaryFailed.value = false;
		summaryAttempted = false;
		question.value = '';
		askHistory.value = [];
		askErrored.value = false;
		askOpen.value = false;
	}
);

// The gist line is present when a summary exists or is being fetched.
const hasGist = computed(() => summaryPending.value || !!summaryText.value);
// The whole strip disappears (zero height) when there's nothing to show: no
// summary, not warranting one, and the user hasn't opened Ask.
const visible = computed(() => hasGist.value || props.warrantsSummary || askOpen.value);
</script>

<template>
	<div
		v-if="visible"
		class="pbx-ai-strip rounded-lg border border-border-subtle bg-bg-elevated"
		data-testid="postbox-ai-strip"
	>
		<!-- ONE line: the gist (shimmer while it fills in), "more" for the bullets,
		     and the Ask link. Fail-soft — the gist is simply absent when there is no
		     summary and the thread never warranted one. -->
		<div class="flex items-center gap-2 px-3 py-2">
			<Icon name="lucide:sparkles" class="w-3.5 h-3.5 text-text-tertiary shrink-0" />
			<div
				v-if="summaryPending"
				class="h-3 flex-1 rounded bg-bg-surface animate-pulse motion-reduce:animate-none"
				aria-hidden="true"
			/>
			<p
				v-else-if="hasGist"
				class="text-xs text-text-secondary min-w-0 flex-1"
				:class="{ truncate: !summaryExpanded }"
			>
				<span class="font-medium text-text-tertiary">{{
					t('components.postbox.postboxAiStrip.summaryLabel')
				}}</span>
				<template v-if="!summaryExpanded"> {{ oneLine }}</template>
			</p>
			<span v-else class="flex-1" />
			<button
				v-if="hasGist && !summaryPending"
				type="button"
				class="shrink-0 text-xs text-text-tertiary hover:text-text-primary"
				:aria-expanded="summaryExpanded"
				:aria-label="t('components.postbox.postboxAiStrip.toggleSummaryDetail')"
				@click="summaryExpanded = !summaryExpanded"
			>
				{{
					summaryExpanded
						? t('components.postbox.postboxAiStrip.less')
						: t('components.postbox.postboxAiStrip.more')
				}}
			</button>
			<button
				type="button"
				class="shrink-0 text-xs text-brand hover:underline"
				:aria-expanded="askOpen"
				:aria-label="t('components.postbox.postboxAiStrip.askAbout')"
				@click="toggleAsk"
			>
				{{ t('components.postbox.postboxAiStrip.ask') }}
			</button>
		</div>
		<ul
			v-if="summaryExpanded && hasGist"
			class="list-disc pl-9 pr-3 pb-2 space-y-1 text-xs text-text-secondary"
		>
			<li v-for="(b, i) in bullets" :key="i">{{ b }}</li>
		</ul>

		<!-- Ask: grounded Q&A about THIS thread (ephemeral history). -->
		<div v-if="askOpen" class="px-3 pb-3 space-y-3" data-testid="postbox-ask-thread">
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
