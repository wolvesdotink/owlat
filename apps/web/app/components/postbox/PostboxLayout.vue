<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	folderRole: string;
	folderId?: Id<'mailFolders'>;
	activeMessageId?: string | null;
}>();

const { t } = useI18n();

const mailboxIdRef = computed(() => props.mailboxId);
const folderRef = computed(() => props.folderRole);
const folderIdRef = computed(() => props.folderId);
// Custom folders drive the list-header name; the rest of the folder rail is
// self-contained in PostboxFolderRail.
const { customFolders } = usePostboxFolders(mailboxIdRef);

// Register Postbox as the app command palette's "current surface" while mounted
// (reader actions + the folders/searches the sidebar doesn't list). Extracted to
// a composable to keep this layout under the file-size cap.
usePostboxCommandSurface(mailboxIdRef);

// List/reader density → applied as a single data-density attribute on the
// Postbox root; all compact styling lives in CSS keyed off it (postbox-density.css).
// viewMode → which of the three inbox list renderers is active (Flat /
// Conversations / Categories), persisted per user on the server.
const {
	density,
	viewMode: savedViewMode,
	setViewMode,
	inboxMode: savedInboxMode,
	setInboxMode,
	sortOrder: savedSortOrder,
	setSortOrder,
} = usePostboxSettings();

// Newest / oldest arrival order for the list, persisted per user. The flip
// applies optimistically and the feed re-subscribes on the new order (its
// resetKey carries the direction, so no cursor outlives the flip).
const { sortOrder, toggleSortOrder } = usePostboxSortToggle({ savedSortOrder, setSortOrder });

const { messages, isLoading, isLoadingMore, isRefetching, hasMore, canLoadMore, loadMore } =
	usePostboxThreads({
		mailboxId: mailboxIdRef,
		folderRole: folderRef,
		folderId: folderIdRef,
		sortOrder,
	});

// The virtual Snoozed folder is take()-bounded server-side: more matches can
// exist with no cursor to reach them. Say so plainly instead of offering a
// Load more that cannot advance — the same posture the label view takes.
const listCapped = computed(() => hasMore.value && !canLoadMore.value);

// Triage filter chips (All / Unread / Starred / Attachments) — client-side
// over the fetched window, persisted per mailbox+folder. Flat list only; the
// grouped renderers own their sections. Wired to `displayMessages` below so
// the chips filter what's actually shown (cache or live).
const triageScope = computed(
	() => `${String(props.mailboxId)}:${props.folderId ?? props.folderRole}`
);

// Offline read cache: serve the last-cached inbox rows instantly on a cold
// start (with an "updating…" shimmer) and hand back to live rows the moment
// they arrive. `displayMessages` is what the flat list renders; live always
// wins. Non-inbox folders are a transparent pass-through.
const {
	rows: displayMessages,
	showingCached,
	isOffline,
	cachedAt,
} = usePostboxOfflineThreads({
	mailboxId: computed(() => String(props.mailboxId)),
	folderRole: folderRef,
	liveRows: messages,
	isLoading,
	isRefetching,
});

const {
	active: triageFilter,
	setFilter: setTriageFilter,
	counts: triageCounts,
	countsArePartial: triageCountsArePartial,
	filtered: filteredDisplayMessages,
} = usePostboxTriageFilters({ scope: triageScope, rows: displayMessages, hasMore });

// What the flat list renders: filter-of-what's-shown.
const listMessages = computed(() =>
	triageFilter.value === 'all' ? displayMessages.value : filteredDisplayMessages.value
);
// A chip is "active" when it hides rows that exist — drives the caught-up
// empty state ("Show all") instead of the folder's usual empty copy.
const filterHidesRows = computed(
	() => triageFilter.value !== 'all' && displayMessages.value.length > 0
);

// Offline outbox (D8): mounting here registers the drain-on-reconnect watcher
// for the active mailbox; the counts drive the offline banner ("n queued")
// and the post-drain "couldn't send" banner with its retry affordance.
const {
	queuedCount: queuedSendCount,
	failedCount: failedSendCount,
	drain: retryQueuedSends,
} = usePostboxOfflineOutbox(computed(() => String(props.mailboxId)));

// Once the inbox list has settled (first paint done), idle-prefetch the
// composer + reader chunks so pressing `c` or Enter never waits on a chunk
// download. Idempotent + fail-soft; the Designer-mode EmailBuilder stays lazy.
const chunkWarmup = usePostboxChunkWarmup();
watch(
	isLoading,
	(loading) => {
		if (!loading) chunkWarmup.warm();
	},
	{ immediate: true }
);

// Cmd/Ctrl+Z re-triages the last archive/trash/move/spam action while the
// undo toast is visible (inert in inputs/contenteditable — see composable).
const triageUndo = usePostboxTriageUndo();
onMounted(() => window.addEventListener('keydown', triageUndo.onWindowKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', triageUndo.onWindowKeydown));

// Folder name shown in the list header (custom folders carry no role). A system
// folder arrives as its role, which has a translated name; a custom/unknown role
// keeps rendering the server-provided value verbatim.
const NAMED_FOLDER_ROLES = ['inbox', 'sent', 'drafts', 'trash', 'spam', 'archive', 'snoozed'];
const currentFolderName = computed(() => {
	if (props.folderId) {
		const custom = customFolders.value.find((f) => f._id === props.folderId)?.name;
		return custom ?? t('components.postbox.postboxLayout.folderFallback');
	}
	return NAMED_FOLDER_ROLES.includes(props.folderRole)
		? t(`components.postbox.postboxLayout.folderRoles.${props.folderRole}`)
		: props.folderRole;
});

// ── Below `lg` the three panes become a stacked drill-in (the shell's mobile
// pattern): the folder rail is an off-canvas drawer, and the list and reader
// swap based on whether a message is open. Purely class-driven so there is no
// breakpoint state to keep in sync — `railOpen` is the drawer's own state.
const railOpen = ref(false);
// Any navigation (folder link, message row) dismisses the drawer.
watch(
	[folderRef, folderIdRef, () => props.activeMessageId],
	() => {
		railOpen.value = false;
	},
	{ flush: 'post' }
);

// The two inbox mode switches — list renderer (Flat / Conversations /
// Categories) and landing surface (Today / Browse) — with their optimistic
// overrides and their window-level shortcuts (B, Esc, `/`). Extracted to a
// composable to keep this layout under the file-size cap.
const {
	viewMode,
	viewModeOptions,
	selectViewMode,
	activeListRenderer,
	switchInboxMode,
	todayActive,
	viewAutoFiled,
} = usePostboxInboxModes({
	folderRole: folderRef,
	folderId: folderIdRef,
	activeMessageId: computed(() => props.activeMessageId),
	railOpen,
	savedViewMode,
	setViewMode,
	savedInboxMode,
	setInboxMode,
});

// The Today overlay closed while the route still points at a deep-linked
// message — settle the URL back on the plain inbox (replace: the overlay was
// never its own history entry when opened from the list).
function onTodayReaderClosed() {
	if (props.activeMessageId) void navigateTo('/dashboard/postbox/inbox', { replace: true });
}

/**
 * Drill-in "back": from the reader to the folder's list route. Replace, don't
 * push — opening the message pushed the entry this button dismisses, so a push
 * here would leave the system Back gesture reopening the reader the user just
 * closed, and grow the history stack by two entries per open/close cycle.
 */
function backToList() {
	void navigateTo(`/dashboard/postbox/${String(props.folderId ?? props.folderRole)}`, {
		replace: true,
	});
}

/** Compose FAB (stack mode) — the touch entry point while the rail, and its
 * Compose button with it, live in the drawer. Same entry point as the rail's
 * button: the composer stack. */
const composerStack = usePostboxComposerStack();

const threadGroupsEnabled = computed(() => activeListRenderer.value === 'conversations');
const {
	threads: threadGroups,
	isLoading: threadGroupsLoading,
	hasMore: threadGroupsHasMore,
	loadMore: loadMoreThreadGroups,
} = usePostboxThreadGroups({
	mailboxId: mailboxIdRef,
	folderRole: folderRef,
	enabled: threadGroupsEnabled,
});

// Smart-inbox split view — groups the inbox into People / Newsletters /
// Notifications / Receipts sections.
const categoryGroupsEnabled = computed(() => activeListRenderer.value === 'categories');
const {
	sections: categorySections,
	isLoading: categoryLoading,
	hasMore: categoryHasMore,
	loadMore: loadMoreCategories,
	collapsed: categoryCollapsed,
	toggle: toggleCategory,
	recategorize,
} = usePostboxThreadCategories({
	mailboxId: mailboxIdRef,
	folderRole: folderRef,
	enabled: categoryGroupsEnabled,
});

const listActive = computed(() => messages.value.find((m) => m._id === props.activeMessageId));
// Deep-link fallback: when the active message isn't in the loaded page (an old
// message reached via bookmark / notification / search), fetch it by id so the
// reader renders instead of showing an empty "Select a message".
const { data: fetchedActive } = useConvexQuery(api.mail.mailbox.messages.getMessage, () =>
	props.activeMessageId && !listActive.value
		? { messageId: props.activeMessageId as Id<'mailMessages'> }
		: 'skip'
);
const activeMessage = computed(() => listActive.value ?? fetchedActive.value ?? undefined);

// Auto-advance context for the reader: the flat list's visual row order
// (optimistic-hide filtered, via the template ref below). In the
// thread-grouped view the flat order doesn't match what's on screen, so an
// empty list makes every triage fall back to back-to-list there.
const threadListRef = ref<{ visibleIds: string[] } | null>(null);
const advanceIds = computed(() =>
	threadGroupsEnabled.value || categoryGroupsEnabled.value
		? []
		: // The raw-messages fallback only applies while the list component is
			// unmounted (e.g. the search overlay covers it); it skips the
			// optimistic-hide filter, but any hidden row is mid-mutation and about
			// to leave `messages` anyway, so the order is at worst one row stale.
			(threadListRef.value?.visibleIds ?? messages.value.map((m) => m._id))
);
</script>

<template>
	<div class="flex w-full" :data-density="density">
		<!-- Landing mode: the focused Today column replaces the three panes on
		     the inbox route until the user opens a message or switches to
		     Browse (header button / B / Esc back). pbx-fade is opacity-only and
		     inert under prefers-reduced-motion. -->
		<Transition name="pbx-fade" mode="out-in">
			<PostboxTodayView
				v-if="todayActive"
				:mailbox-id="mailboxId"
				:initial-message-id="activeMessageId"
				@browse="switchInboxMode('browse')"
				@view-auto-filed="viewAutoFiled"
				@reader-closed="onTodayReaderClosed"
			/>
			<div v-else class="flex w-full min-w-0">
				<!-- Pane 1: folder rail — collapsible icon strip; self-contained (search,
		     folder CRUD, labels, Reply Queue/Snoozed/Contacts, Cmd+Shift+D).
		     Below lg the drawer wrapper takes it off-canvas so the list gets the
		     full width. -->
				<PostboxFolderDrawer
					v-model:open="railOpen"
					:mailbox-id="mailboxId"
					:folder-role="folderRole"
					:folder-id="folderId"
				/>

				<!-- Pane 2: thread/message list — the whole width below lg, and hidden
			     entirely once a message is open (the reader takes over). -->
				<section
					class="w-full lg:w-96 lg:flex-shrink-0 border-r border-border-subtle flex-col bg-bg-surface"
					:class="activeMessageId ? 'hidden lg:flex' : 'flex'"
				>
					<PostboxOfflineBanners
						:is-offline="isOffline"
						:queued-count="queuedSendCount"
						:failed-count="failedSendCount"
						:cached-at="cachedAt"
						@retry="() => void retryQueuedSends()"
					/>
					<PostboxListHeader
						:folder-name="currentFolderName"
						:folder-role="folderRole"
						:folder-id="folderId"
						:active-message-id="activeMessageId"
						:showing-cached="showingCached"
						:is-offline="isOffline"
						:view-mode="viewMode"
						:view-mode-options="viewModeOptions"
						:sort-order="sortOrder"
						@open-rail="railOpen = true"
						@switch-today="switchInboxMode('today')"
						@select-view-mode="selectViewMode"
						@toggle-sort="toggleSortOrder"
					/>
					<template v-if="folderRole === 'drafts'">
						<div class="flex-1 overflow-auto">
							<PostboxDraftList :mailbox-id="mailboxId" />
						</div>
					</template>
					<template v-else>
						<!-- Triage filter chips — flat list only; the grouped renderers own
					     their sections. One tap from "everything" to "what needs me". -->
						<PostboxTriageFilterChips
							v-if="!threadGroupsEnabled && !categoryGroupsEnabled"
							class="border-b border-border-subtle pb-3"
							:filter="triageFilter"
							:counts="triageCounts"
							:counts-are-partial="triageCountsArePartial"
							@select-filter="setTriageFilter"
						/>
						<!-- Compact "waiting on your reply" strip — inbox only, non-empty
				     queue only, dismissible for the session. -->
						<PostboxReplyQueueStrip :mailbox-id="mailboxId" :folder-role="folderRole" />
						<PostboxQuickActionsBar
							v-if="!threadGroupsEnabled && !categoryGroupsEnabled"
							:mailbox-id="mailboxId"
							:folder-role="folderRole"
						/>
						<div class="flex-1 overflow-auto">
							<!-- Keyed on folder + renderer so both folder changes and view-mode
					     switches cross-fade (pbx-fade is opacity-only and inert under
					     prefers-reduced-motion). -->
							<Transition name="pbx-fade" mode="out-in">
								<div
									:key="`${String(folderId ?? folderRole ?? 'all')}:${activeListRenderer}`"
									class="h-full"
								>
									<PostboxThreadCategoryList
										v-if="categoryGroupsEnabled"
										:sections="categorySections"
										:collapsed="categoryCollapsed"
										:loading="categoryLoading"
										:folder-role="folderRole"
										:active-message-id="activeMessageId"
										:has-more="categoryHasMore"
										@load-more="loadMoreCategories"
										@toggle="toggleCategory"
										@recategorize="recategorize"
									/>
									<PostboxThreadGroupList
										v-else-if="threadGroupsEnabled"
										:threads="threadGroups"
										:loading="threadGroupsLoading"
										:folder-role="folderRole"
										:active-message-id="activeMessageId"
										:has-more="threadGroupsHasMore"
										@load-more="loadMoreThreadGroups"
									/>
									<PostboxThreadList
										v-else
										ref="threadListRef"
										:mailbox-id="mailboxId"
										:messages="listMessages"
										:loading="isLoading && !showingCached"
										:folder-role="folderRole"
										:active-message-id="activeMessageId"
										:has-more="canLoadMore"
										:loading-more="isLoadingMore"
										:capped="listCapped"
										:filter-active="filterHidesRows"
										@load-more="loadMore"
										@clear-filter="setTriageFilter('all')"
									/>
								</div>
							</Transition>
						</div>
					</template>
				</section>

				<!-- Pane 3: reader — below lg it replaces the list rather than sitting
			     beside it, so the empty "Select a message" pane never shows there. -->
				<section
					class="flex-1 min-w-0 overflow-auto bg-bg-base"
					:class="activeMessageId ? 'block' : 'hidden lg:block'"
				>
					<!-- Drill-in back navigation (mobile only; on lg the list is still
				     on screen beside the reader). py-3 puts the full-width bar past
				     the 44px touch target — it is the only way out of the reader. -->
					<button
						v-if="activeMessageId"
						type="button"
						class="lg:hidden sticky top-0 z-10 w-full flex items-center gap-1.5 border-b border-border-subtle bg-bg-base px-3 py-3 text-sm text-text-secondary hover:text-text-primary focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
						@click="backToList"
					>
						<Icon name="lucide:arrow-left" class="w-4 h-4" />
						<span class="capitalize truncate">{{ currentFolderName }}</span>
					</button>

					<Transition name="pbx-reader" mode="out-in">
						<PostboxThreadReader
							v-if="activeMessage"
							:key="activeMessageId ?? undefined"
							:message="activeMessage"
							:advance-ids="advanceIds"
							:folder-role="folderId ? String(folderId) : folderRole"
						/>
						<div v-else class="h-full flex items-center justify-center">
							<div class="text-center">
								<Icon name="lucide:mail-open" class="w-12 h-12 mx-auto text-text-tertiary" />
								<p class="mt-4 text-text-secondary">
									{{ t('components.postbox.postboxLayout.selectMessage') }}
								</p>
							</div>
						</div>
					</Transition>
				</section>
			</div>
		</Transition>

		<!-- Compose FAB (below lg): the touch entry point for writing while the
		     rail, and its Compose button with it, live in the drawer. Hidden while
		     a message is open — the reader carries its own reply affordances. -->
		<button
			v-if="!activeMessageId"
			type="button"
			class="lg:hidden fixed bottom-5 right-5 z-30 w-13 h-13 rounded-full bg-brand text-text-inverse shadow-lg flex items-center justify-center hover:bg-brand-hover transition-colors duration-(--motion-fast) focus-visible:ring-2 focus-visible:ring-brand/50 outline-none"
			:aria-label="t('components.postbox.postboxComposeButton.compose')"
			@click="composerStack.open({ mailboxId })"
		>
			<Icon name="lucide:pen-line" class="w-5 h-5" />
		</button>

		<PostboxShortcutHelp />
	</div>
</template>
