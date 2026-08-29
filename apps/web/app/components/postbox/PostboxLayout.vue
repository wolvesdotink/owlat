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
// readingPane → where the reader sits (right / bottom / off) and how big the
// list pane is; one data-attribute plus two custom properties (postbox-panes.css).
const {
	density,
	viewMode: savedViewMode,
	setViewMode,
	readingPane,
	listWidth,
	listHeight,
	setListSize,
	inboxMode: savedInboxMode,
	setInboxMode,
	sortOrder: savedSortOrder,
	setSortOrder,
} = usePostboxSettings();

const {
	geometry,
	listPaneBorder,
	listPaneVisibility,
	readerPaneVisibility,
	listSize,
	previewListSize,
	commitListSize,
	paneStyle,
} = usePostboxReadingPane({
	readingPane,
	listWidth,
	listHeight,
	setListSize,
	activeMessageId: computed(() => props.activeMessageId),
});
// The divider measures the list pane it moves, so it needs the element itself.
const listPaneRef = ref<HTMLElement | null>(null);

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
// The ids the header's tri-state select-all covers: exactly the rows the flat
// list renders, so "select all" never quietly picks a row that is filtered out.
const listMessageIds = computed(() => listMessages.value.map((m) => m._id));
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

// Cmd/Ctrl+Z walks back the undo stack (newest first) while entries are
// pending. The listener is installed app-wide by usePostboxTriageUndo itself
// while the stack is non-empty, so binding it here too would undo two entries
// per keypress.

// Folder name shown in the list header (custom folders carry no role).
const currentFolderName = usePostboxFolderName({
	folderRole: folderRef,
	folderId: folderIdRef,
	customFolders,
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

// The layout's own two route moves (drill-in back, Today overlay close).
const { backToList, onTodayReaderClosed } = usePostboxLayoutNav({
	folderRole: folderRef,
	folderId: folderIdRef,
	activeMessageId: computed(() => props.activeMessageId),
});

/** Compose FAB (stack mode) — the touch entry point while the rail, and its
 * Compose button with it, live in the drawer. Same entry point as the rail's
 * button: the composer stack. */
const composerStack = usePostboxComposerStack();

// The feed behind whichever renderer is active (conversations / categories /
// bundles). Exactly one subscribes; the rest skip.
const {
	grouped,
	conversationsEnabled,
	categoriesEnabled,
	bundlesEnabled,
	sectionsEnabled,
	conversations,
	categories,
	bundles,
	sections,
} = usePostboxListSources({
	mailboxId: mailboxIdRef,
	folderRole: folderRef,
	renderer: activeListRenderer,
	listMessages,
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
// (optimistic-hide filtered, via the template ref below). In every grouped
// renderer the flat order doesn't match what's on screen, so an empty list
// makes every triage fall back to back-to-list there.
const threadListRef = ref<{ visibleIds: string[] } | null>(null);
const advanceIds = computed(() =>
	grouped.value
		? []
		: // The raw-messages fallback only applies while the list component is
			// unmounted (e.g. the search overlay covers it); it skips the
			// optimistic-hide filter, but any hidden row is mid-mutation and about
			// to leave `messages` anyway, so the order is at worst one row stale.
			(threadListRef.value?.visibleIds ?? messages.value.map((m) => m._id))
);
</script>

<template>
	<div
		class="flex w-full"
		:data-density="density"
		:data-reading-pane="readingPane"
		:style="paneStyle"
	>
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

				<!-- The list + reader split. Its own flex container so the reading
				     pane can flip it to a column ('bottom') without taking the folder
				     rail with it. -->
				<div class="pbx-pane-split flex flex-1 min-w-0 min-h-0">
					<!-- Pane 2: thread/message list — the whole width below lg, and hidden
			     entirely once a message is open (the reader takes over). Its lg
			     size comes from postbox-panes.css, driven by the persisted seam. -->
					<section
						ref="listPaneRef"
						class="pbx-pane-list w-full border-border-subtle flex-col bg-bg-surface min-w-0 min-h-0"
						:class="[listPaneVisibility, listPaneBorder]"
					>
						<!-- Idea 55: said once, when the instance turns sealing on, because
						     the only other clue is a lock glyph nobody explained. -->
						<PostboxSealedMailNudge />
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
							:mailbox-id="!grouped && folderRole !== 'drafts' ? mailboxId : undefined"
							:page-ids="listMessageIds"
							:select-all-scope-matches-list="triageFilter === 'all'"
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
								v-if="!grouped"
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
								v-if="!grouped"
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
											v-if="categoriesEnabled"
											:sections="categories.sections.value"
											:collapsed="categories.collapsed.value"
											:loading="categories.isLoading.value"
											:folder-role="folderRole"
											:active-message-id="activeMessageId"
											:has-more="categories.hasMore.value"
											@load-more="categories.loadMore"
											@toggle="categories.toggle"
											@recategorize="categories.recategorize"
										/>
										<PostboxThreadGroupList
											v-else-if="conversationsEnabled"
											:threads="conversations.threads.value"
											:loading="conversations.isLoading.value"
											:folder-role="folderRole"
											:active-message-id="activeMessageId"
											:has-more="conversations.hasMore.value"
											@load-more="conversations.loadMore"
										/>
										<PostboxThreadBundleList
											v-else-if="bundlesEnabled"
											:entries="bundles.entries.value"
											:expanded="bundles.expanded.value"
											:loading="isLoading && !showingCached"
											:folder-role="folderRole"
											:active-message-id="activeMessageId"
											:has-more="canLoadMore"
											:busy="bundles.isBusy.value"
											@load-more="loadMore"
											@toggle="bundles.toggle"
											@archive-bundle="(ids) => void bundles.archiveBundle(ids)"
											@unsubscribe-bundle="
												(senders, ids) => void bundles.unsubscribeBundle(senders, ids)
											"
										/>
										<PostboxThreadSectionList
											v-else-if="sectionsEnabled"
											:sections="sections.sections.value"
											:collapsed="sections.collapsed.value"
											:loading="sections.isLoading.value"
											:folder-role="folderRole"
											:active-message-id="activeMessageId"
											@load-more="sections.loadMore"
											@toggle="sections.toggle"
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

					<!-- The seam. Keyboard-operable (it is the only way to move a
					     geometry the user now owns) and hidden below lg, where the
					     panes are a stacked drill-in with no seam to move. -->
					<PostboxPaneResizer
						v-if="geometry.axis"
						:axis="geometry.axis"
						:model-value="listSize"
						:pane-el="listPaneRef"
						@update:model-value="previewListSize"
						@commit="commitListSize"
					/>

					<!-- Pane 3: reader — below lg it replaces the list rather than sitting
				     beside it, so the empty "Select a message" pane never shows there.
				     With the reading pane off it only exists once a message is open. -->
					<section
						class="pbx-pane-reader flex-1 min-w-0 min-h-0 overflow-auto bg-bg-base"
						:class="readerPaneVisibility"
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
