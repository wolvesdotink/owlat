<script setup lang="ts">
/**
 * The Postbox "Today" landing surface — the focused single-column view the
 * inbox opens on (mode 'today'; the three-pane UI stays available as
 * 'browse'). One task at a time, top to bottom:
 *
 *   - minimal header ("Inbox (n)" + a ghost Browse button with the B hint)
 *   - the Brief slot (empty placeholder region — the Daily Brief lands here)
 *   - "FOR YOU (n)": compact agent-task strips from the existing Reply Queue
 *     feed; clicking routes to the Reply Queue page
 *   - "TODAY": thread rows (received since local midnight + unread from
 *     yesterday), reusing PostboxThreadList so hover quick-actions, unread
 *     emphasis, j/k/Enter and single-key triage all carry over unchanged
 *   - a quiet roll-up line for auto-filed smart-inbox mail (newsletters /
 *     notifications / receipts never render as Today rows)
 *   - a centered "Show past mails (n)" affordance that expands older mail
 *     inline (same rows, same pagination).
 *
 * Opening a row renders the conversation in PostboxTodayReaderOverlay — a
 * centered pane over the list, so the column (scroll + selection) stays put
 * underneath; j/k inside the overlay swap the thread in place and Esc/scrim
 * return to the list. Presentation follows the shared brief: weight-based
 * emphasis, at most one accent per region, pbx-* motion tiers (opacity-only
 * under prefers-reduced-motion).
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { partitionTodayMessages, formatAutoFiledLine } from '~/utils/postboxTodayPartition';
import { replyQueueHeadline, type ReplyQueueItem } from '~/utils/postboxReplyQueue';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	/** Deep-link seed (/dashboard/postbox/inbox/<id> in Today mode): open this
	 * conversation in the overlay on mount. */
	initialMessageId?: string | null;
}>();

const emit = defineEmits<{
	/** Switch to the three-pane browse mode (header button / B / Cmd-B). */
	browse: [];
	/** Open the auto-filed mail: browse mode with the Categories view. */
	'view-auto-filed': [];
	/** The reader overlay closed (Esc / scrim / advance past the ends) — the
	 * host clears a deep-linked message route back to the plain inbox URL. */
	'reader-closed': [];
}>();

const mailboxIdRef = computed(() => props.mailboxId);
const folderRef = computed(() => 'inbox');

// Same inbox feed the browse list reads (the Convex client dedupes the
// subscription), so triaging here and there stays perfectly consistent.
const { messages, isLoading, hasMore, loadMore } = usePostboxThreads({
	mailboxId: computed<Id<'mailboxes'> | null>(() => props.mailboxId),
	folderRole: folderRef,
});

// Advisory smart-inbox categories live on the THREAD, not the message —
// reuse the same listThreads feed the Categories view reads and index it by
// thread id. Fail-open: an unclassified thread is never auto-filed.
const { data: threadData } = useConvexQuery(api.mail.mailbox.listThreads, () =>
	props.mailboxId ? { mailboxId: props.mailboxId, folderRole: 'inbox' } : 'skip'
);
const categoryByThread = computed(() => {
	const map = new Map<string, string>();
	for (const thread of threadData.value?.threads ?? []) {
		if (thread.category?.label) map.set(thread._id, thread.category.label);
	}
	return map;
});

// Re-partition as time passes so the local-midnight boundary rolls over
// without a reload (a minute of drift is invisible; the rows are live).
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

const partition = computed(() =>
	partitionTodayMessages(messages.value, {
		now: now.value,
		categoryOf: (m) => (m.threadId ? categoryByThread.value.get(m.threadId) : undefined),
	})
);
const todayRows = computed(() => partition.value.today);
const olderRows = computed(() => partition.value.older);
const autoFiledLine = computed(() => formatAutoFiledLine(partition.value.autoFiledCounts));

// "For you" — the existing Reply Queue feed (usePostboxReplyQueue already
// ranks by priority). The strips stay compact: the queue PAGE remains the
// doing-surface, so every strip routes there.
const FOR_YOU_CAP = 5;
const { items: forYouItems, count: forYouCount } = usePostboxReplyQueue(mailboxIdRef);
const forYouVisible = computed(() => forYouItems.value.slice(0, FOR_YOU_CAP));

// Deep link target for the desktop titlebar unread pill
// (/dashboard/postbox/inbox#postbox-for-you). The section renders only once the
// reply-queue feed resolves, so scroll to it when it actually mounts — a watch
// on the count + hash rather than a fire-and-forget scroll at navigation time,
// which would no-op on a cold load where the section is not in the DOM yet.
const route = useRoute();
const forYouSection = ref<HTMLElement | null>(null);
watch(
	[forYouCount, () => route.hash],
	([count]) => {
		if (!import.meta.client || route.hash !== '#postbox-for-you' || count <= 0) return;
		void nextTick(() => {
			const el = forYouSection.value;
			if (!el) return;
			const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			el.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
		});
	},
	{ immediate: true }
);

/** One muted line of context under the ask: who it is + what they wrote. */
function forYouDetail(item: ReplyQueueItem): string {
	const who = item.fromName?.trim() || item.fromAddress;
	const snippet = item.snippet?.trim();
	return snippet ? `${who} — ${snippet}` : who;
}

/** The strip's action says what happens (no jargon). */
function forYouAction(item: ReplyQueueItem): string {
	if (item.kind === 'followup') return 'Open';
	if (item.draftSlot || item.clarification?.draft) return 'Review & send';
	return 'Answer';
}

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

// The visible row order the overlay's j/k and the reader's triage
// auto-advance walk: today's rows, then the expanded past rows.
const overlayAdvanceIds = computed(() => [
	...todayRows.value.map((m) => m._id),
	...(showPast.value ? olderRows.value.map((m) => m._id) : []),
]);

// The reader needs the full row; deep-linked messages outside the loaded feed
// (an old conversation reached via bookmark/notification) are fetched by id —
// same fallback the three-pane layout uses.
const openListMessage = computed(() =>
	openMessageId.value ? messages.value.find((m) => m._id === openMessageId.value) : undefined
);
const { data: fetchedOpenMessage } = useConvexQuery(api.mail.mailbox.getMessage, () =>
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
</script>

<template>
	<div class="flex-1 overflow-y-auto bg-bg-base">
		<div class="max-w-xl mx-auto px-4 py-8 flex flex-col gap-8">
			<!-- Minimal header: the count + the one way out to the full UI. -->
			<header class="flex items-center justify-between">
				<h1 class="text-lg font-semibold text-text-primary">
					Inbox
					<span class="font-normal text-text-tertiary tabular-nums">({{ todayRows.length }})</span>
				</h1>
				<button
					type="button"
					class="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-sm text-text-secondary hover:text-text-primary hover:bg-bg-surface focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
					aria-keyshortcuts="b"
					title="Browse all folders (B)"
					@click="emit('browse')"
				>
					Browse
					<kbd
						class="text-[10px] text-text-tertiary border border-border-subtle rounded px-1"
						aria-hidden="true"
						>B</kbd
					>
				</button>
			</header>

			<!-- Brief slot: the Daily Brief greeting card (fail-soft — renders
			     nothing while there is no cached brief, so the list below stays
			     the focal point). Its counts deep-link to the sections below. -->
			<PostboxDailyBrief :mailbox-id="mailboxId" />

			<!-- FOR YOU: what the agent queued for the owner, why in one muted line. -->
			<section v-if="forYouCount > 0" id="postbox-for-you" ref="forYouSection" aria-label="For you">
				<h2
					class="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary tabular-nums"
				>
					For you ({{ forYouCount }})
				</h2>
				<ul
					class="mt-2 divide-y divide-border-subtle rounded-lg border border-border-subtle bg-bg-surface overflow-hidden"
				>
					<li v-for="item in forYouVisible" :key="item.messageId">
						<NuxtLink
							to="/dashboard/postbox/reply-queue"
							class="flex items-center gap-3 px-4 py-3 hover:bg-(--surface-1-hover) focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand/40 outline-none"
						>
							<Icon
								:name="item.kind === 'followup' ? 'lucide:clock' : 'lucide:reply'"
								class="w-4 h-4 text-brand flex-shrink-0"
							/>
							<span class="flex-1 min-w-0">
								<span class="block truncate text-sm font-semibold text-text-primary">
									{{ replyQueueHeadline(item) }}
								</span>
								<span class="block truncate text-xs text-text-tertiary mt-0.5">
									{{ forYouDetail(item) }}
								</span>
							</span>
							<span class="flex-shrink-0 text-sm font-medium text-brand" aria-hidden="true">
								{{ forYouAction(item) }}
							</span>
						</NuxtLink>
					</li>
				</ul>
				<div v-if="forYouCount > FOR_YOU_CAP" class="mt-1.5 text-right">
					<NuxtLink to="/dashboard/postbox/reply-queue" class="text-xs text-brand hover:underline">
						View all {{ forYouCount }}
					</NuxtLink>
				</div>
			</section>

			<!-- TODAY: the day's mail, same rows/shortcuts as the browse list. -->
			<section id="postbox-today" aria-label="Today">
				<h2 class="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">Today</h2>
				<div
					v-if="todayRows.length > 0"
					class="mt-2 rounded-lg border border-border-subtle bg-bg-surface overflow-hidden"
				>
					<PostboxThreadList
						:mailbox-id="mailboxId"
						:messages="todayRows"
						:loading="false"
						folder-role="inbox"
						selectable
						:active-message-id="openMessageId"
						@select="openMessageId = $event"
					/>
				</div>
				<PostboxThreadListSkeleton v-else-if="isLoading" class="mt-2" />
				<!-- Inbox zero: one quiet line; the Brief + past mail stay put. -->
				<p v-else class="mt-3 text-sm text-text-tertiary">All clear — nothing new needs you.</p>
				<p v-if="autoFiledLine" class="mt-2 text-xs text-text-tertiary">
					{{ autoFiledLine }} ·
					<button
						type="button"
						class="text-brand hover:underline focus-visible:ring-1 focus-visible:ring-brand/40 rounded outline-none"
						@click="emit('view-auto-filed')"
					>
						view
					</button>
				</p>
			</section>

			<!-- Older mail: collapsed by default, expands inline with the same rows. -->
			<Transition name="pbx-fade" mode="out-in">
				<div v-if="hasOlder && !showPast" class="text-center">
					<button
						type="button"
						class="px-3 py-2 rounded text-sm text-text-secondary hover:text-text-primary hover:bg-bg-surface focus-visible:ring-1 focus-visible:ring-brand/40 outline-none tabular-nums"
						@click="showPast = true"
					>
						Show past mails ({{ olderCountLabel }})
					</button>
				</div>
				<section v-else-if="showPast" aria-label="Past mails">
					<h2 class="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
						Past
					</h2>
					<div class="mt-2 rounded-lg border border-border-subtle bg-bg-surface overflow-hidden">
						<PostboxThreadList
							:mailbox-id="mailboxId"
							:messages="olderRows"
							:loading="isLoading"
							folder-role="inbox"
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
		     Enters with the shared fade+rise; the list underneath keeps its
		     scroll and selection for Esc/scrim return. -->
		<Transition name="pbx-reader">
			<PostboxTodayReaderOverlay
				v-if="overlayMessage"
				:message="overlayMessage"
				:advance-ids="overlayAdvanceIds"
				@open="openMessageId = $event"
				@close="closeOverlay"
			/>
		</Transition>
	</div>
</template>
