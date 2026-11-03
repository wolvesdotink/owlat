<script setup lang="ts">
/**
 * The Postbox "Priority" landing surface — the focused single-column view the
 * inbox opens on (stored mode 'today'; the list + reader UI is "All mail",
 * stored as 'browse'). The folder rail stays beside it. One task at a time,
 * top to bottom:
 *
 *   - minimal header ("Inbox (n)" + the shared Priority|All mail switch)
 *   - the pinned band (PostboxPinnedBand), when anything is pinned
 *   - the Brief slot (the Daily Brief greeting card)
 *   - "NEEDS YOU": the Reply Queue's rows (they open the Answer queue,
 *     filtered to this mailbox) and the threads placed `needs_me`
 *   - "EVERYTHING ELSE": the `today` placement (the Categories view's word;
 *     "Today" names the home page)
 *   - "UPDATES · NO REPLY NEEDED": three rows, then a fold
 *   - "N newsletters and promotions · in your digest": the `digest` placement
 *     as a count, linking to All mail filtered to it
 *   - for rows without an arrival placement, the old grouping: received today
 *     (under "Everything else"), auto-filed categories rolled up into one
 *     quiet line, the rest past mail
 *   - a centered "Show past mails (n)" affordance that expands older mail
 *     inline (same rows, same pagination).
 *
 * The groups come from each row's placement (utils/postboxPriorityGroups,
 * read on arrival §3). Rows are one line each (POSTBOX_PRIORITY_ROWS) but stay
 * PostboxThreadList rows, so hover quick-actions, unread emphasis, j/k/Enter
 * and single-key triage carry over unchanged.
 *
 * Opening a row renders the conversation in PostboxTodayReaderOverlay — a
 * centered pane over the list, so the column (scroll + selection) stays put
 * underneath; j/k inside the overlay swap the thread in place and Esc/scrim
 * return to the list. Presentation follows the shared brief: weight-based
 * emphasis, at most one accent per region, pbx-* motion tiers (opacity-only
 * under prefers-reduced-motion).
 */
import { api } from '@owlat/api';
import { prefersReducedMotion } from '@owlat/ui/composables/useReducedMotion';
import type { Id } from '@owlat/api/dataModel';
import { usePostboxListNow } from '~/composables/postbox/usePostboxListClock';
import { provide } from 'vue';
import { POSTBOX_READER_HOST_KEY } from '~/composables/postbox/usePostboxReaderActions';
import type { PostboxInboxMode } from '~/utils/postboxInboxMode';
import { formatAutoFiledLine, startOfLocalDay } from '~/utils/postboxTodayPartition';
import { POSTBOX_PRIORITY_ROWS, groupPriorityRows } from '~/utils/postboxPriorityGroups';
import { provideBriefLines } from '~/composables/postbox/usePostboxBriefLines';
import { answerQueueHrefFor } from '~/utils/postboxReplyQueue';
import { PanelLeftIcon } from '@coolicons/vue';

/**
 * Client detection that is both SSR-safe (no `window` on the server) and
 * test-friendly (happy-dom provides `window`), unlike Nuxt's compile-time
 * `import.meta.client` which is undefined under vitest — the same pattern as
 * usePostboxOfflineCache.
 */
const IS_CLIENT = typeof window !== 'undefined';

const { t } = useI18n();

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	/** Deep-link seed (/dashboard/postbox/inbox/<id> in Today mode): open this
	 * conversation in the overlay on mount. */
	initialMessageId?: string | null;
}>();

const emit = defineEmits<{
	/** Switch to All mail, the list + reader (header switch / B / Cmd-B). */
	browse: [];
	/** Open the folder drawer (below lg, where the rail is off-canvas). */
	'open-rail': [];
	/** Open the auto-filed mail: browse mode with the Categories view. */
	'view-auto-filed': [];
	/** Open All mail filtered to the digest placement. */
	'view-digest': [];
	/** The reader overlay closed (Esc / scrim / advance past the ends) — the
	 * host clears a deep-linked message route back to the plain inbox URL. */
	'reader-closed': [];
}>();

const mailboxIdRef = computed(() => props.mailboxId);
const folderRef = computed(() => 'inbox');

// Same inbox feed the browse list reads (the Convex client dedupes the
// subscription), so triaging here and there stays perfectly consistent.
const { messages, isLoading, hasMore, loadMore, error, refetch } = usePostboxThreads({
	mailboxId: computed<Id<'mailboxes'> | null>(() => props.mailboxId),
	folderRole: folderRef,
});

// The list clock both thread lists below share for their row timestamps
// (provided here, so the two lists and the partition run off one timer).
const now = usePostboxListNow();
// The partition only depends on which local day it is. The clock ticks every
// minute; this number changes once, at midnight, and a computed that returns
// the same number does not wake its readers, so the rows are re-split then and
// not 1,440 times a day.
const todayStart = computed(() => startOfLocalDay(new Date(now.value)));

// "Needs you" starts with the Reply Queue feed (usePostboxReplyQueue already
// ranks by priority). Its rows stay compact: the Answer queue remains the
// doing-surface, so every row routes there, filtered to this mailbox.
const FOR_YOU_CAP = 5;
const answerQueueHref = computed(() => answerQueueHrefFor(props.mailboxId));
const { items: forYouItems, count: forYouCount } = usePostboxReplyQueue(mailboxIdRef);
const forYouVisible = computed(() => forYouItems.value.slice(0, FOR_YOU_CAP));
const queuedThreadIds = computed(() => new Set(forYouItems.value.map((item) => item.threadId)));

// One line per thread (PostboxThreadRowBody reads this), the subject in place
// of the AI's line when the viewer turned the brief off.
provide(POSTBOX_PRIORITY_ROWS, true);
const { autoSummarize } = usePostboxSettings();
provideBriefLines(autoSummarize);

const groups = computed(() =>
	// Each row carries its thread's placement and advisory category (attached
	// server-side), so a row on a later page groups exactly like one on the
	// first. Fail-open: an unclassified, unplaced row is never auto-filed.
	groupPriorityRows(messages.value, {
		now: new Date(todayStart.value),
		queuedThreadIds: queuedThreadIds.value,
	})
);
const needsRows = computed(() => groups.value.needsMe);
const todayRows = computed(() => groups.value.today);
const updateRows = computed(() => groups.value.updates);
const digestCount = computed(() => groups.value.digest.length);
const olderRows = computed(() => groups.value.older);
const autoFiledLine = computed(() => formatAutoFiledLine(groups.value.autoFiledCounts));
const needsCount = computed(() => forYouCount.value + needsRows.value.length);
const shownCount = computed(
	() => needsRows.value.length + todayRows.value.length + updateRows.value.length
);
/** Nothing to show in any group: the quiet "All clear" line. */
const isInboxZero = computed(
	() => shownCount.value === 0 && forYouCount.value === 0 && digestCount.value === 0
);

// Deep link target for the desktop titlebar unread pill
// (/dashboard/postbox/inbox#postbox-for-you). The section renders only once the
// reply-queue feed resolves, so scroll to it when it actually mounts — a watch
// on the count + hash rather than a fire-and-forget scroll at navigation time,
// which would no-op on a cold load where the section is not in the DOM yet.
//
// One-shot: the deep link is CONSUMED once. We arm a pending flag when the hash
// is present (at mount, or when a later navigation re-sets it — e.g. re-clicking
// the pill from another section) and disarm it after the first successful
// scroll. Otherwise a live reply-queue count change (a new item arrives, or the
// user answers one) would re-fire scrollIntoView and yank the viewport back to
// the For-you section mid-read — live subscriptions must never move the user.
const route = useRoute();
const router = useRouter();
const forYouSection = ref<HTMLElement | null>(null);
const pendingForYouScroll = ref(route.hash === '#postbox-for-you');
watch(
	() => route.hash,
	(hash) => {
		if (hash === '#postbox-for-you') pendingForYouScroll.value = true;
	}
);
watch(
	[forYouCount, pendingForYouScroll],
	([count, pending]) => {
		if (!IS_CLIENT || !pending || count <= 0) return;
		void nextTick(() => {
			const el = forYouSection.value;
			if (!el) return;
			el.scrollIntoView({
				block: 'start',
				behavior: prefersReducedMotion() ? 'auto' : 'smooth',
			});
			pendingForYouScroll.value = false;
			// Strip the consumed fragment so re-clicking the titlebar pill (which
			// navigates to the same URL) re-sets the hash → re-arms the flag →
			// re-scrolls. Without this the second click is a no-op duplicate nav.
			void router.replace({ query: route.query, hash: '' });
		});
	},
	{ immediate: true }
);

// The column scrolls as one: both lists sit in auto-height boxes inside it, so
// they window and auto-load against this scroller, not their own boxes (which
// never scroll and would mount every loaded row).
const scrollHost = ref<HTMLElement | null>(null);

// Older mail stays one interaction away: collapsed behind the centered
// affordance, expanded inline with the same rows + pagination.
const showPast = ref(false);
const olderCountLabel = computed(() => `${olderRows.value.length}${hasMore.value ? '+' : ''}`);
const hasOlder = computed(() => olderRows.value.length > 0 || hasMore.value);

// --- Centered reader overlay -------------------------------------------------
// Rows open IN PLACE (the lists are `selectable`, so Enter/click emit
// `select` instead of navigating): the column stays mounted, preserving
// scroll and the j/k selection. Deep links seed the same state.
const openMessageId = ref<string | null>(props.initialMessageId ?? null);
// The Postbox page stays mounted across /inbox ↔ /inbox/<id>, so a later deep
// link (palette, notification, browser back/forward) re-seeds the overlay here
// instead of through a fresh mount. Opening a row in place never touches the
// route, so this only follows real navigations.
watch(
	() => props.initialMessageId,
	(id) => {
		openMessageId.value = id ?? null;
	}
);

// The visible row order the overlay's j/k and the reader's triage
// auto-advance walk: today's rows, then the expanded past rows.
const overlayAdvanceIds = computed(() => [
	...needsRows.value.map((m) => m._id),
	...todayRows.value.map((m) => m._id),
	...updateRows.value.map((m) => m._id),
	...(showPast.value ? olderRows.value.map((m) => m._id) : []),
]);

// The reader needs the full row; deep-linked messages outside the loaded feed
// (an old conversation reached via bookmark/notification) are fetched by id —
// same fallback the three-pane layout uses.
const openListMessage = computed(() =>
	openMessageId.value ? messages.value.find((m) => m._id === openMessageId.value) : undefined
);
const { data: fetchedOpenMessage } = useConvexQuery(api.mail.mailbox.messages.getMessage, () =>
	openMessageId.value && !openListMessage.value
		? { messageId: openMessageId.value as Id<'mailMessages'> }
		: 'skip'
);
const overlayMessage = computed(() =>
	openMessageId.value ? (openListMessage.value ?? fetchedOpenMessage.value ?? undefined) : undefined
);

function closeOverlay() {
	openMessageId.value = null;
	emit('reader-closed');
}

// A reader triage advances before its mutation lands; if it then fails, the
// reader (already swapped out) reopens its message through this host.
provide(POSTBOX_READER_HOST_KEY, {
	openId: () => openMessageId.value,
	open: (id) => {
		openMessageId.value = id;
	},
});

/**
 * The mode switch is two-way, but this surface IS 'today' — only the other
 * segment has anywhere to go, and the host owns the move (it persists the mode).
 */
function onModeSelect(mode: PostboxInboxMode) {
	if (mode === 'browse') emit('browse');
}
</script>

<template>
	<div ref="scrollHost" class="flex-1 overflow-y-auto bg-bg-base">
		<div class="max-w-xl mx-auto px-4 py-8 flex flex-col gap-8">
			<!-- Minimal header: the count + the two-way switch to the full UI. The
			     same control the browse list header carries, so the two surfaces
			     name each other instead of each offering a one-way exit. -->
			<header class="flex items-center justify-between gap-3">
				<!-- Folder drawer handle (below lg, where the rail is off-canvas). -->
				<button
					type="button"
					class="lg:hidden -ml-2 w-11 h-11 flex items-center justify-center flex-shrink-0 rounded text-text-secondary hover:text-text-primary hover:bg-bg-surface focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
					:aria-label="t('components.postbox.postboxLayout.openFolders')"
					@click="emit('open-rail')"
				>
					<PanelLeftIcon class="w-4 h-4" />
				</button>
				<h1 class="flex-1 min-w-0 text-lg font-semibold text-text-primary">
					{{ t('components.postbox.postboxTodayView.inbox') }}
					<span class="font-normal text-text-tertiary tabular-nums">({{ shownCount }})</span>
				</h1>
				<PostboxInboxModeToggle class="flex-shrink-0" mode="today" @select="onModeSelect" />
			</header>

			<!-- Pinned conversations, above everything else until unpinned. -->
			<PostboxPinnedBand
				:mailbox-id="mailboxId"
				selectable
				framed
				:active-message-id="openMessageId"
				@select="openMessageId = $event"
			/>

			<!-- Brief slot: the Daily Brief greeting card (fail-soft — renders
			     nothing while there is no cached brief, so the list below stays
			     the focal point). Its counts deep-link to the sections below. -->
			<PostboxDailyBrief :mailbox-id="mailboxId" />

			<!-- NEEDS YOU: the Reply Queue, then the threads placed needs_me. -->
			<section
				v-if="needsCount > 0"
				id="postbox-for-you"
				ref="forYouSection"
				:aria-label="t('postbox.priority.needsYou.title')"
			>
				<h2
					class="flex items-baseline text-[11px] font-semibold uppercase tracking-wider text-text-tertiary tabular-nums"
				>
					{{ t('postbox.priority.needsYou.title') }}
					<NuxtLink
						v-if="forYouCount > 0"
						:to="answerQueueHref"
						class="ml-auto normal-case tracking-normal text-xs font-normal text-brand hover:underline"
						>{{ t('postbox.priority.needsYou.queue', { count: forYouCount }) }}</NuxtLink
					>
				</h2>
				<div
					class="mt-2 divide-y divide-border-subtle rounded-lg border border-border-subtle bg-bg-surface overflow-hidden"
				>
					<PostboxPriorityQueueList
						v-if="forYouVisible.length > 0"
						:items="forYouVisible"
						:href="answerQueueHref"
						:show-brief="autoSummarize"
					/>
					<PostboxThreadList
						v-if="needsRows.length > 0"
						:mailbox-id="mailboxId"
						:messages="needsRows"
						:loading="false"
						folder-role="inbox"
						:scroll-parent="scrollHost"
						selectable
						:active-message-id="openMessageId"
						@select="openMessageId = $event"
					/>
				</div>
			</section>

			<!-- EVERYTHING ELSE: the today placement (and today's unplaced mail), same rows/shortcuts as the full list. -->
			<section
				v-if="todayRows.length > 0 || error || isLoading || isInboxZero || autoFiledLine"
				id="postbox-today"
				:aria-label="t('postbox.priority.everythingElse.title')"
			>
				<h2 class="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
					{{ t('postbox.priority.everythingElse.title') }}
				</h2>
				<div
					v-if="todayRows.length > 0"
					class="mt-2 rounded-lg border border-border-subtle bg-bg-surface overflow-hidden"
				>
					<PostboxThreadList
						:mailbox-id="mailboxId"
						:messages="todayRows"
						:loading="false"
						folder-role="inbox"
						:scroll-parent="scrollHost"
						selectable
						:active-message-id="openMessageId"
						@select="openMessageId = $event"
					/>
				</div>
				<!-- A failed read is not inbox zero. -->
				<UiQueryBoundary v-else-if="error" :error="error" @retry="refetch" />
				<PostboxThreadListSkeleton v-else-if="isLoading" class="mt-2" />
				<!-- Inbox zero: one quiet line; the Brief + past mail stay put. -->
				<p v-else-if="isInboxZero" class="mt-3 text-sm text-text-tertiary">
					{{ t('components.postbox.postboxTodayView.allClear') }}
				</p>
				<p
					v-if="autoFiledLine"
					class="mt-2 text-xs text-text-tertiary"
					data-testid="auto-filed-line"
				>
					{{ t(autoFiledLine.key, autoFiledLine.params) }} ·
					<button
						type="button"
						class="text-brand hover:underline focus-visible:ring-1 focus-visible:ring-brand/40 rounded outline-none"
						@click="emit('view-auto-filed')"
					>
						{{ t('components.postbox.postboxTodayView.view') }}
					</button>
				</p>
			</section>

			<!-- UPDATES: three one-liners, then the fold. -->
			<PostboxPriorityUpdates
				:mailbox-id="mailboxId"
				:rows="updateRows"
				:scroll-parent="scrollHost"
				:active-message-id="openMessageId"
				@select="openMessageId = $event"
			/>

			<!-- Newsletters and promotions are a count and a way to the digest. -->
			<button
				v-if="digestCount > 0"
				type="button"
				class="flex items-baseline gap-2 rounded-lg border border-dashed border-border-subtle px-4 py-2.5 text-left text-sm text-text-secondary hover:bg-bg-surface focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
				data-testid="priority-digest-fold"
				@click="emit('view-digest')"
			>
				<b class="font-medium text-text-primary">{{
					t('postbox.priority.digest.count', { count: digestCount }, digestCount)
				}}</b>
				<span>· {{ t('postbox.priority.digest.inDigest') }}</span>
				<span class="ml-auto text-xs text-brand">{{ t('postbox.priority.digest.open') }}</span>
			</button>

			<!-- Older mail: collapsed by default, expands inline with the same rows. -->
			<Transition name="pbx-fade" mode="out-in">
				<div v-if="hasOlder && !showPast" class="text-center">
					<button
						type="button"
						class="px-3 py-2 rounded text-sm text-text-secondary hover:text-text-primary hover:bg-bg-surface focus-visible:ring-1 focus-visible:ring-brand/40 outline-none tabular-nums"
						@click="showPast = true"
					>
						{{ t('components.postbox.postboxTodayView.showPast', { count: olderCountLabel }) }}
					</button>
				</div>
				<section
					v-else-if="showPast"
					:aria-label="t('components.postbox.postboxTodayView.pastMails')"
				>
					<h2 class="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
						{{ t('components.postbox.postboxTodayView.past') }}
					</h2>
					<div class="mt-2 rounded-lg border border-border-subtle bg-bg-surface overflow-hidden">
						<PostboxThreadList
							:mailbox-id="mailboxId"
							:messages="olderRows"
							:loading="isLoading"
							folder-role="inbox"
							:scroll-parent="scrollHost"
							:has-more="hasMore"
							selectable
							:active-message-id="openMessageId"
							@select="openMessageId = $event"
							@load-more="loadMore"
						/>
					</div>
				</section>
			</Transition>
		</div>

		<!-- Centered reader: the ONE doing-surface while a conversation is open.
		     Fades in with the reader's enter-only swap and closes in the same
		     frame; the list underneath keeps its scroll and selection for
		     Esc/scrim return. -->
		<PostboxTodayReaderOverlay
			v-if="overlayMessage"
			class="pbx-reader-swap"
			:message="overlayMessage"
			:advance-ids="overlayAdvanceIds"
			@open="openMessageId = $event"
			@close="closeOverlay"
		/>
	</div>
</template>
