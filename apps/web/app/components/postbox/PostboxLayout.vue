<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { PostboxViewMode } from '~/utils/postboxViewMode';
import {
	postboxListRenderer,
	resolvePostboxViewMode,
} from '~/utils/postboxViewMode';
import type { PostboxInboxMode } from '~/utils/postboxInboxMode';
import type { PostboxTriageFilter } from '~/composables/postbox/usePostboxTriageFilters';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	folderRole: string;
	folderId?: Id<'mailFolders'>;
	activeMessageId?: string | null;
}>();

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
} = usePostboxSettings();

const { messages, isLoading, hasMore, loadMore } = usePostboxThreads({
	mailboxId: mailboxIdRef,
	folderRole: folderRef,
	folderId: folderIdRef,
});

// Shell geometry: the desktop three-pane side by side, or a single-column
// stack below lg (rail → drawer, reader → full-screen overlay). Geometry
// only — keyboard model and triage behavior are identical in both.
const { isStack } = usePostboxPaneMode();
const drawerOpen = ref(false);
// Close the drawer whenever the route's folder changes (a drawer navigation
// pick lands as a route change) or when leaving stack mode entirely.
watch([folderRef, folderIdRef, isStack], () => {
	drawerOpen.value = false;
});

/** Stack-mode reader back button: return to the list's folder route. */
function closeStackReader() {
	const target = props.folderId
		? `/dashboard/postbox/${props.folderId}`
		: `/dashboard/postbox/${props.folderRole || 'inbox'}`;
	void navigateTo(target);
}

/** Stack-mode compose FAB — same entry point as the rail's Compose button. */
const composerStack = usePostboxComposerStack();
function openStackCompose() {
	composerStack.open({ mailboxId: props.mailboxId });
}

// Triage filter chips (All / Unread / Starred / Attachments) — client-side
// over the fetched window, persisted per mailbox+folder. Flat list only; the
// grouped renderers own their sections. Wired to `displayMessages` below so
// the chips filter what's actually shown (cache or live).
const triageScope = computed(
	() => `${String(props.mailboxId)}:${props.folderId ?? props.folderRole}`
);

// Offline read cache: serve the last-cached inbox/snoozed rows instantly on a
// cold start (with an "updating…" shimmer) and hand back to live rows the moment
// they arrive. `displayMessages` is what the flat list filters; live always
// wins. Other folders are a transparent pass-through.
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
});

const {
	active: triageFilter,
	setFilter: setTriageFilter,
	counts: triageCounts,
	filtered: filteredDisplayMessages,
} = usePostboxTriageFilters({ scope: triageScope, rows: displayMessages });

// What the flat list renders: filter-of-what's-shown.
const listMessages = computed(() =>
	triageFilter.value === 'all' ? displayMessages.value : filteredDisplayMessages.value
);
// A chip is "active" when it hides rows that exist — drives the caught-up
// empty state ("Show all") instead of the folder's usual empty copy.
const filterHidesRows = computed(
	() => triageFilter.value !== 'all' && displayMessages.value.length > 0
);

/** Dated offline banner text: how stale the cached rows are. */
const cachedAtLabel = computed(() => {
	if (!cachedAt.value) return undefined;
	return new Date(cachedAt.value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
});

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

// Folder name shown in the list header (custom folders carry no role).
const currentFolderName = computed(() =>
	props.folderId
		? (customFolders.value.find((f) => f._id === props.folderId)?.name ?? 'Folder')
		: props.folderRole
);

// Inbox view mode — exactly one of Flat / Conversations / Categories is
// active. The saved (server-persisted) value drives the list; a pending
// optimistic override reflects a tap immediately while the mutation lands,
// then hands back to the server value. Grouped renderers are inbox-only; the
// flat list with its hover/keyboard triage serves all other folders.
const { value: viewMode, set: applyViewMode, preview: previewViewMode } = usePostboxOptimisticSetting<PostboxViewMode>({
	saved: savedViewMode as Ref<PostboxViewMode>,
	apply: setViewMode,
});
function selectViewMode(value: string) {
	applyViewMode(resolvePostboxViewMode(value));
}
const activeListRenderer = computed(() => postboxListRenderer(viewMode.value, folderRef.value));

// Inbox landing mode — 'today' (the focused single-column PostboxTodayView;
// the default) vs 'browse' (the three panes below). Inbox-only: every other
// folder keeps the three-pane UI regardless of mode. A deep-linked message
// (/inbox/<id>) stays in Today mode too — the Today view opens it in its
// centered reader overlay over the list; in browse mode the same route is
// the unchanged three-pane reader. Same optimistic-override pattern as the
// view mode above; the server remembers the last-used mode.
const { value: inboxMode, set: switchInboxMode } = usePostboxOptimisticSetting<PostboxInboxMode>({
	saved: savedInboxMode as Ref<PostboxInboxMode>,
	apply: setInboxMode,
});
const todayActive = computed(
	() => folderRef.value === 'inbox' && !props.folderId && inboxMode.value === 'today'
);

// The Today overlay closed while the route still points at a deep-linked
// message — settle the URL back on the plain inbox (replace: the overlay was
// never its own history entry when opened from the list).
function onTodayReaderClosed() {
	if (props.activeMessageId) void navigateTo('/dashboard/postbox/inbox', { replace: true });
}

// The Today roll-up line's "view" opens the auto-filed mail where it lives:
// browse mode with the Categories renderer. The Categories choice is a
// TRANSIENT override (preview) — it must not silently overwrite the user's
// saved list preference.
function viewAutoFiled() {
	previewViewMode('categories');
	switchInboxMode('browse');
}

// Mode shortcuts (window-level, like the triage-undo chord above): B toggles
// Today ↔ Browse, Esc returns to Today, Esc closes the stack-mode drawer, and
// `/` from Today jumps to Browse with the search focused. See the composable.
usePostboxModeShortcuts({
	folderRole: folderRef,
	isCustomFolder: computed(() => !!props.folderId),
	activeMessageId: computed(() => props.activeMessageId ?? null),
	drawerOpen,
	currentMode: inboxMode as Ref<PostboxInboxMode>,
	todayActive,
	switchMode: switchInboxMode,
});

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
const { data: fetchedActive } = useConvexQuery(api.mail.mailbox.getMessage, () =>
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

// Reply Queue inbox "waiting on your reply" strip. The strip is dismissible for
// the session (in-memory state, resets on reload) and only renders while the
// queue is non-empty. (The rail's own badge subscribes separately/deduped.)
const { count: replyQueueCount } = usePostboxReplyQueue(mailboxIdRef);
const replyQueueStripDismissed = useState('postbox:reply-queue-strip-dismissed', () => false);
const showReplyQueueStrip = computed(
	() => folderRef.value === 'inbox' && replyQueueCount.value > 0 && !replyQueueStripDismissed.value
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
			     Desktop (lg+) only: below lg the rail becomes the slide-over drawer
			     at the bottom of this template. -->
			<PostboxFolderRail
				v-if="!isStack"
				:mailbox-id="mailboxId"
				:folder-role="folderRole"
				:folder-id="folderId"
			/>

			<!-- Pane 2: thread/message list — fixed sidebar width on desktop,
			     full-width single column in stack mode. -->
			<section
				class="border-r border-border-subtle flex flex-col bg-bg-surface min-w-0 flex-1"
				:class="{ 'lg:w-96 lg:flex-none': !isStack }"
			>
				<!-- Quiet offline banner: cached list + already-read bodies stay
				     readable; server-backed actions degrade with clear affordances.
				     Dated ("cached at 14:32") so stale rows are never mistaken for
				     fresh ones. -->
				<div
					v-if="isOffline"
					class="flex items-center gap-2 px-4 py-2 bg-warning-subtle text-warning text-xs border-b border-border-subtle"
					role="status"
				>
					<Icon name="lucide:cloud-off" class="w-3.5 h-3.5 flex-shrink-0" />
					<span class="truncate">
						Offline — showing mail cached from this device{{
							cachedAtLabel ? ` at ${cachedAtLabel}` : ''
						}}. Actions are paused.
					</span>
				</div>
				<PostboxListHeader
					:folder-name="currentFolderName"
					:showing-cached="showingCached"
					:is-offline="isOffline"
					:show-inbox-controls="folderRole === 'inbox'"
					:show-today-button="folderRole === 'inbox' && !activeMessageId && !folderId"
					:show-triage-filters="
						folderRole !== 'drafts' && !threadGroupsEnabled && !categoryGroupsEnabled
					"
					:view-mode="viewMode"
					:filter="triageFilter"
					:counts="triageCounts"
					@open-drawer="drawerOpen = true"
					@switch-today="switchInboxMode('today')"
					@select-view-mode="selectViewMode($event)"
					@select-filter="setTriageFilter($event)"
				/>
				<template v-if="folderRole === 'drafts'">
					<div class="flex-1 overflow-auto">
						<PostboxDraftList :mailbox-id="mailboxId" />
					</div>
				</template>
				<template v-else>
					<!-- Compact "waiting on your reply" strip — inbox only, non-empty
					     queue only, dismissible for the session. -->
					<PostboxReplyQueueStrip
						v-if="showReplyQueueStrip"
						:count="replyQueueCount"
						@dismiss="replyQueueStripDismissed = true"
					/>
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
									:has-more="hasMore"
									:filter-active="filterHidesRows"
									@load-more="loadMore"
									@clear-filter="setTriageFilter('all')"
								/>
							</div>
						</Transition>
					</div>
				</template>
			</section>

			<!-- Pane 3: reader — a docked third pane on desktop. In stack mode
			     the pane is replaced by the full-screen overlay below, so the
			     list keeps the whole width. -->
			<section v-if="!isStack" class="flex-1 overflow-auto bg-bg-base">
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
							<p class="mt-4 text-text-secondary">Select a message</p>
						</div>
					</div>
				</Transition>
			</section>
		</div>
	</Transition>

		<!-- Stack mode (below lg): opened message as a full-screen reader overlay.
		     Same component as the docked pane — only the staging changes. The
		     sticky back bar stays reachable at any scroll depth without
		     overlapping the reader's own header. -->
		<div
			v-if="isStack && activeMessage"
			class="fixed inset-0 z-40 bg-bg-base overflow-y-auto overscroll-contain"
			role="region"
			aria-label="Message reader"
		>
			<div
				class="sticky top-0 z-10 flex items-center bg-bg-base/95 backdrop-blur border-b border-border-subtle px-3 py-2"
			>
				<button
					type="button"
					class="flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-bg-elevated border border-border-subtle text-xs text-text-secondary hover:text-text-primary focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
					aria-label="Back to list"
					@click="closeStackReader"
				>
					<Icon name="lucide:chevron-left" class="w-4 h-4" />
					Back
				</button>
			</div>
			<PostboxThreadReader
				:key="activeMessageId ?? undefined"
				:message="activeMessage"
				:advance-ids="advanceIds"
				:folder-role="folderId ? String(folderId) : folderRole"
			/>
		</div>

		<!-- Stack mode compose FAB — the touch entry point for writing while the
		     rail (and its Compose button) lives in the drawer. Hidden while the
		     reader overlay is up; the reader carries its own reply affordances. -->
		<button
			v-if="isStack && !activeMessage"
			type="button"
			class="lg:hidden fixed bottom-5 right-5 z-30 w-13 h-13 rounded-full bg-brand text-white shadow-lg flex items-center justify-center hover:bg-brand-hover transition-colors duration-(--motion-fast) focus-visible:ring-2 focus-visible:ring-brand/50 outline-none"
			aria-label="Compose message"
			@click="openStackCompose"
		>
			<Icon name="lucide:pen-line" class="w-5 h-5" />
		</button>

		<!-- Stack mode folder drawer: the same PostboxFolderRail, staged as a
		     slide-over with a scrim. forceExpanded overrides the desktop icon-strip
		     collapse so the drawer always opens readable. pbx-fade is opacity-only
		     and inert under prefers-reduced-motion. -->
		<Transition name="pbx-fade">
			<div
				v-if="isStack && drawerOpen"
				class="fixed inset-0 z-40 lg:hidden"
				role="dialog"
				aria-modal="true"
				aria-label="Folders"
			>
				<div class="absolute inset-0 bg-black/30" @click="drawerOpen = false" />
				<div class="absolute inset-y-0 left-0 w-72 max-w-[85%] bg-bg-elevated shadow-lg overflow-y-auto">
					<PostboxFolderRail
						force-expanded
						:mailbox-id="mailboxId"
						:folder-role="folderRole"
						:folder-id="folderId"
					/>
				</div>
			</div>
		</Transition>

		<PostboxShortcutHelp />
	</div>
</template>
