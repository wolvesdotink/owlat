<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * The reader's ONE AI home — a single quiet strip that consolidates the three
 * advisory surfaces that used to stack under a thread (the TL;DR summary banner,
 * the Summarize/Suggest pills, and the "Ask about this thread…" input). It shows
 * a one-line gist of the cached thread summary (click "more" to expand the
 * bullets inline) and two ghost actions:
 *
 *   • "Ask"         — expands a grounded Q&A about THIS thread inline (single-turn
 *                     mail.ai.askThread; ephemeral in-memory history, never saved).
 *   • "Draft reply" — runs mail.ai.suggestReplies; each suggestion card emits
 *                     `use-reply` so the reader opens the existing prefilled
 *                     composer unchanged.
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

const emit = defineEmits<{
	// A chosen reply suggestion — the reader opens the prefilled composer with it.
	(e: 'use-reply', text: string): void;
}>();

// --- Summary (formerly PostboxThreadSummary): warm-read → lazy-gen → render.
const summaryExpanded = ref(false);
const generated = ref<{ summary: string; messageCount: number } | null>(null);
const summaryFailed = ref(false);
let summaryAttempted = false;

const cacheQuery = useConvexQuery(api.mail.summaryCache.getThreadSummary, () => ({
	messageId: props.messageId as Id<'mailMessages'>,
}));
const summaryGenOp = useBackendOperation(api.mail.ai.getOrGenerateThreadSummary, {
	label: 'Summarize thread',
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
	if (res && res.summary) {
		generated.value = { summary: res.summary, messageCount: res.messageCount };
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
const askOp = useBackendOperation(api.mail.ai.askThread, {
	label: 'Ask about this thread',
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
	if (res && res.answer) {
		askHistory.value.push({ question: q, answer: res.answer });
		question.value = '';
	} else {
		askErrored.value = true;
	}
}
function clearAsk() {
	question.value = '';
	askErrored.value = false;
}

// --- Draft reply (formerly PostboxAiAssist suggest): reply suggestions.
const suggestions = ref<string[]>([]);
const suggestOp = useBackendOperation(api.mail.ai.suggestReplies, {
	label: 'Suggest replies',
	type: 'action',
});
const suggestBusy = computed(() => suggestOp.isLoading.value);

async function runSuggest() {
	const res = await suggestOp.run({ messageId: props.messageId as Id<'mailMessages'> });
	suggestions.value = res ? res.replies : [];
}

// --- One expandable section at a time (Ask XOR Draft reply), mutually exclusive.
type Section = 'ask' | 'suggest';
const openSection = ref<Section | null>(null);

function toggleAsk() {
	openSection.value = openSection.value === 'ask' ? null : 'ask';
}
async function toggleSuggest() {
	if (openSection.value === 'suggest') {
		openSection.value = null;
		return;
	}
	openSection.value = 'suggest';
	if (suggestions.value.length === 0 && !suggestBusy.value) await runSuggest();
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
		suggestions.value = [];
		openSection.value = null;
	}
);

// The gist line is present when a summary exists or is being fetched.
const hasGist = computed(() => summaryPending.value || !!summaryText.value);
// The whole strip disappears (zero height) when there's nothing to show: no
// summary, not warranting one, and the user hasn't opened Ask / Draft reply.
const visible = computed(
	() => hasGist.value || props.warrantsSummary || openSection.value !== null
);
</script>

<template>
	<div
		v-if="visible"
		class="pbx-ai-strip rounded-lg border border-border-subtle bg-bg-elevated"
		data-testid="postbox-ai-strip"
	>
		<!-- Gist: one-line thread summary (shimmer while it fills in). "more"
		     expands the bullets inline; fail-soft — absent when unavailable. -->
		<template v-if="hasGist">
			<div v-if="summaryPending" class="flex items-center gap-2 px-3 py-2" aria-hidden="true">
				<Icon name="lucide:sparkles" class="w-3.5 h-3.5 text-text-tertiary shrink-0" />
				<div class="h-3 flex-1 rounded bg-bg-surface animate-pulse" />
			</div>
			<div v-else class="flex items-center gap-2 px-3 py-2">
				<Icon name="lucide:sparkles" class="w-3.5 h-3.5 text-text-tertiary shrink-0" />
				<p
					class="text-xs text-text-secondary min-w-0 flex-1"
					:class="{ truncate: !summaryExpanded }"
				>
					<span class="font-medium text-text-tertiary">Summary:</span>
					<template v-if="!summaryExpanded"> {{ oneLine }}</template>
				</p>
				<button
					type="button"
					class="shrink-0 text-xs text-text-tertiary hover:text-text-primary"
					:aria-expanded="summaryExpanded"
					aria-label="Toggle summary detail"
					@click="summaryExpanded = !summaryExpanded"
				>
					{{ summaryExpanded ? 'less' : 'more' }}
				</button>
			</div>
			<ul
				v-if="summaryExpanded"
				class="list-disc pl-9 pr-3 pb-2 space-y-1 text-xs text-text-secondary"
			>
				<li v-for="(b, i) in bullets" :key="i">{{ b }}</li>
			</ul>
		</template>

		<!-- Divider between the gist and the actions (only when both are present). -->
		<div v-if="hasGist" class="border-t border-border-subtle" />

		<!-- Two ghost actions. -->
		<div class="flex items-center gap-1 px-2 py-1">
			<button
				type="button"
				class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-surface"
				:aria-expanded="openSection === 'ask'"
				aria-label="Ask about this thread"
				@click="toggleAsk"
			>
				<Icon name="lucide:message-circle-question" class="w-3.5 h-3.5" />
				Ask
			</button>
			<button
				type="button"
				class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-surface disabled:opacity-50"
				:aria-expanded="openSection === 'suggest'"
				:disabled="suggestBusy"
				aria-label="Draft a reply"
				@click="toggleSuggest"
			>
				<Icon
					:name="suggestBusy ? 'lucide:loader-2' : 'lucide:wand-2'"
					class="w-3.5 h-3.5"
					:class="{ 'animate-spin': suggestBusy }"
				/>
				Draft reply
			</button>
		</div>

		<!-- Ask: grounded Q&A about THIS thread (ephemeral history). -->
		<div v-if="openSection === 'ask'" class="px-3 pb-3 space-y-3" data-testid="postbox-ask-thread">
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
					<Icon name="lucide:loader-2" class="w-3.5 h-3.5 animate-spin" />
					Thinking…
				</p>
				<p v-else-if="askErrored" class="text-xs text-text-tertiary">
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
					:disabled="askBusy"
					@keydown.enter.prevent="submitAsk"
					@keydown.esc.prevent="clearAsk"
				/>
				<button
					v-if="question.trim()"
					type="button"
					class="shrink-0 text-text-tertiary hover:text-text-primary disabled:opacity-50"
					aria-label="Ask"
					:disabled="askBusy"
					@click="submitAsk"
				>
					<Icon name="lucide:corner-down-left" class="w-4 h-4" />
				</button>
			</div>
		</div>

		<!-- Draft reply: suggestion cards; each opens the prefilled composer. -->
		<div
			v-else-if="openSection === 'suggest'"
			class="px-3 pb-3"
			aria-live="polite"
			:aria-busy="suggestBusy"
		>
			<span v-if="suggestBusy" class="sr-only">Working…</span>
			<div
				v-if="suggestions.length > 0"
				role="group"
				aria-label="Suggested replies"
				class="flex flex-wrap gap-2"
			>
				<button
					v-for="(r, i) in suggestions"
					:key="i"
					type="button"
					class="text-left text-xs px-3 py-2 rounded-lg border border-border-subtle hover:border-brand hover:bg-bg-surface max-w-xs"
					@click="emit('use-reply', r)"
				>
					{{ r }}
				</button>
			</div>
			<p v-else-if="!suggestBusy" class="text-xs text-text-tertiary">
				No suggestions right now. Try again in a moment.
			</p>
		</div>
	</div>
</template>
