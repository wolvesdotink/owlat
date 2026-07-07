<script setup lang="ts">
/**
 * The Daily Brief card — the greeting moment at the top of the Today view
 * (the a1a Brief slot). A serif time-of-day greeting plus at most three
 * template sentences composed from cached counts (mail/brief.ts): what
 * arrived, what the agent already handled, and what is blocked on the owner.
 * Every concrete count is a weight-550 LINK to the surface holding the real
 * rows (Today section, Reply Queue, For-you section) — the brief points at
 * the next task instead of competing with it.
 *
 * Reads are stale-while-revalidate: the cached card paints instantly and a
 * stale read triggers one background refresh. Everything is fail-soft — no
 * session, no cache, or a failed refresh means the card simply does not
 * render (never an error card). Dismiss (x, hover/focus-revealed,
 * opacity-only) hides it until the next local day, persisted server-side.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	briefGreeting,
	composeBriefSentences,
	localDayOf,
	localDayStartOf,
	type BriefSentence,
} from '~/utils/postboxDailyBrief';

const props = defineProps<{ mailboxId: Id<'mailboxes'> }>();

// Local clock: localDay keys the cache + dismissal; re-checked each minute so
// the card rolls over at midnight (and the greeting with the hour) without a
// reload — same pattern as the Today partition clock.
const now = ref(new Date());
let clock: number | undefined;
onMounted(() => {
	clock = window.setInterval(() => {
		now.value = new Date();
	}, 60_000);
});
onUnmounted(() => {
	if (clock !== undefined) window.clearInterval(clock);
});

const localDay = computed(() => localDayOf(now.value));
const greeting = computed(() => briefGreeting(now.value.getHours()));

const { data } = useConvexQuery(api.mail.brief.getBriefCard, () => ({
	mailboxId: props.mailboxId,
	localDay: localDay.value,
}));

// Stale-while-revalidate: a stale read triggers ONE background refresh per
// (mailbox, day). The key deliberately excludes generatedAt — a refresh that
// leaves the card stale (cold cache) re-emits with a NEW generation, and
// keying on it would re-fire the write in a loop. A genuinely fresh read
// re-arms the guard, so a later same-day fresh→stale transition (≥5 new
// items) still refreshes exactly once. Fail-soft: a refresh failure is
// swallowed; whatever is cached keeps rendering (or nothing does).
const client = useConvex();
const lastRefreshKey = ref<string | null>(null);
watch(
	() => data.value,
	(res) => {
		if (!res) return;
		if (!res.isStale) {
			// Fresh read: re-arm so the NEXT staleness (new day or ≥5 new
			// items later today) triggers its own single refresh.
			lastRefreshKey.value = null;
			return;
		}
		const key = `${props.mailboxId}:${localDay.value}`;
		if (lastRefreshKey.value === key) return;
		lastRefreshKey.value = key;
		client
			.mutation(api.mail.brief.refresh, {
				mailboxId: props.mailboxId,
				localDay: localDay.value,
				dayStartTs: localDayStartOf(now.value),
			})
			.catch(() => {
				// Fail-soft: no brief is better than an error card.
			});
	},
	{ immediate: true }
);

// Dismiss: optimistic hide for the rest of the local day; persisted next to
// the cache so the dismissal follows the owner across devices. A failed write
// only means the card returns on the next load — still never an error.
const dismissedLocally = ref<string | null>(null);
function dismiss() {
	dismissedLocally.value = localDay.value;
	client
		.mutation(api.mail.brief.dismiss, { mailboxId: props.mailboxId, localDay: localDay.value })
		.catch(() => {
			// Fail-soft (see above).
		});
}

const sentences = computed<BriefSentence[]>(() =>
	data.value?.card ? composeBriefSentences(data.value.card.counts) : []
);

/**
 * Same-page anchors (#postbox-today / #postbox-for-you) live inside the Today
 * view's own scroll container, which router hash navigation (window-scoped)
 * misses — scroll the section into view directly. Reduced motion jumps.
 */
function scrollToAnchor(hash: string) {
	const el = document.querySelector(hash);
	if (!el) return;
	const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	el.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
}
const isVisible = computed(
	() =>
		!!data.value?.card &&
		!data.value.isDismissed &&
		dismissedLocally.value !== localDay.value &&
		sentences.value.length > 0
);
</script>

<template>
	<!-- The a1a Brief slot: a quiet greeting region, not a boxed card — the
	     Today list below stays the focal point. -->
	<Transition name="pbx-fade">
		<section
			v-if="isVisible"
			data-postbox-brief-slot
			aria-label="Daily brief"
			class="group relative"
		>
			<button
				type="button"
				aria-label="Hide the brief until tomorrow"
				title="Hide until tomorrow"
				class="absolute -top-1 -right-1 flex items-center justify-center w-8 h-8 rounded text-text-tertiary hover:text-text-primary opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-brand/40 outline-none transition-opacity duration-(--motion-fast)"
				@click="dismiss"
			>
				<Icon name="lucide:x" class="w-3.5 h-3.5" />
			</button>
			<h2 class="font-display text-xl text-text-primary">
				{{ greeting }} — here's where things stand
			</h2>
			<p class="mt-1.5 text-[13px] leading-relaxed text-text-secondary">
				<template v-for="(sentence, si) in sentences" :key="si">
					<template v-for="(seg, gi) in sentence" :key="`${si}-${gi}`">
						<a
							v-if="seg.to && seg.to.startsWith('#')"
							:href="seg.to"
							class="font-semibold text-text-primary tabular-nums hover:text-brand hover:underline focus-visible:ring-1 focus-visible:ring-brand/40 rounded outline-none"
							@click.prevent="scrollToAnchor(seg.to)"
							>{{ seg.text }}</a
						>
						<NuxtLink
							v-else-if="seg.to"
							:to="seg.to"
							class="font-semibold text-text-primary tabular-nums hover:text-brand hover:underline focus-visible:ring-1 focus-visible:ring-brand/40 rounded outline-none"
							>{{ seg.text }}</NuxtLink
						>
						<template v-else>{{ seg.text }}</template>
					</template>
					{{ si < sentences.length - 1 ? ' ' : '' }}
				</template>
			</p>
		</section>
	</Transition>
</template>
