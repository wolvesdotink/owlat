<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * Auto-summary strip for long threads (advisory AI). Shows a collapsed one-line
 * summary above the messages; click to expand the 2–4 bullets. It reads the
 * cached summary reactively (warm cache paints instantly) and, when the cache is
 * cold, generates one lazily WITHOUT blocking the thread render — a quiet shimmer
 * while it fills in. Fail-soft: on any AI failure the strip disappears entirely.
 *
 * Visibility (feature flag + per-user toggle + "long thread") is decided by the
 * parent (PostboxThreadReader); this component just does warm-read → lazy-gen →
 * render. Keyed by messageId so a new latest message remounts it and the cache is
 * regenerated on the next open (edge-triggered).
 */
const props = defineProps<{ messageId: string }>();

const expanded = ref(false);
// Result of a lazy generation (cold cache). Null until it resolves.
const generated = ref<{ summary: string; messageCount: number } | null>(null);
// Set when generation returned nothing (dispatch failure / empty). The strip
// then stays hidden for this mount.
const failed = ref(false);
// Guards against re-triggering generation on every reactive tick.
let attempted = false;

const cacheQuery = useConvexQuery(api.mail.summaryCache.getThreadSummary, () => ({
	messageId: props.messageId as Id<'mailMessages'>,
}));

const genOp = useBackendOperation(api.mail.ai.getOrGenerateThreadSummary, {
	label: 'Summarize thread',
	type: 'action',
});

const cached = computed(
	() => cacheQuery.data.value as { summary: string; messageCount: number } | null | undefined
);

// The summary to show: warm cache first, else the lazily generated one.
const summaryText = computed(() => cached.value?.summary ?? generated.value?.summary ?? null);

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

const isGenerating = computed(() => genOp.isLoading.value);
// Shimmer while we don't yet know whether a summary exists: the reactive cache
// read is still loading, or a lazy generation is in flight.
const isPending = computed(
	() => !summaryText.value && !failed.value && (cacheQuery.isLoading.value || isGenerating.value)
);

async function maybeGenerate() {
	if (attempted || failed.value) return;
	// Wait for the reactive cache read to settle; a warm cache means no dispatch.
	if (cacheQuery.isLoading.value) return;
	if (cached.value) return;
	attempted = true;
	const res = await genOp.run({ messageId: props.messageId as Id<'mailMessages'> });
	if (res && res.summary) {
		generated.value = { summary: res.summary, messageCount: res.messageCount };
	} else {
		// Null result = AI unavailable/declined: fail soft, hide the strip.
		failed.value = true;
	}
}

watch(
	() => cacheQuery.isLoading.value,
	() => void maybeGenerate(),
	{ immediate: true }
);
</script>

<template>
	<div
		v-if="isPending || summaryText"
		class="rounded-lg border border-border-subtle bg-bg-surface mb-2"
		data-testid="postbox-thread-summary"
	>
		<!-- Loading: quiet shimmer, non-blocking. -->
		<div v-if="isPending" class="flex items-center gap-2 px-3 py-2" aria-hidden="true">
			<Icon name="lucide:sparkles" class="w-3.5 h-3.5 text-text-tertiary shrink-0" />
			<div class="h-3 flex-1 rounded bg-bg-elevated animate-pulse" />
		</div>

		<!-- Ready: collapsed one-line strip; click to expand the bullets. -->
		<template v-else-if="summaryText">
			<button
				type="button"
				class="w-full flex items-center gap-2 px-3 py-2 text-left"
				:aria-expanded="expanded"
				aria-label="Thread summary"
				@click="expanded = !expanded"
			>
				<Icon name="lucide:sparkles" class="w-3.5 h-3.5 text-text-tertiary shrink-0" />
				<span class="text-xs text-text-secondary min-w-0 flex-1" :class="{ truncate: !expanded }">
					<span class="font-medium text-text-tertiary">Summary:</span>
					<template v-if="!expanded"> {{ oneLine }}</template>
				</span>
				<Icon
					:name="expanded ? 'lucide:chevron-up' : 'lucide:chevron-down'"
					class="w-3.5 h-3.5 text-text-tertiary shrink-0"
				/>
			</button>
			<ul
				v-if="expanded"
				class="list-disc pl-9 pr-3 pb-2 space-y-1 text-xs text-text-secondary"
			>
				<li v-for="(b, i) in bullets" :key="i">{{ b }}</li>
			</ul>
		</template>
	</div>
</template>
