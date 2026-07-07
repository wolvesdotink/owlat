<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { PostboxViewMode } from '~/utils/postboxViewMode';
import {
	POSTBOX_VIEW_MODE_OPTIONS,
	postboxListRenderer,
	resolvePostboxViewMode,
} from '~/utils/postboxViewMode';
import type { PostboxInboxMode } from '~/utils/postboxInboxMode';
import { isEditableTarget } from '~/utils/postboxShortcuts';

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

// Offline read cache: serve the last-cached inbox rows instantly on a cold
// start (with an "updating…" shimmer) and hand back to live rows the moment
// they arrive. `displayMessages` is what the flat list renders; live always
// wins. Non-inbox folders are a transparent pass-through.
const {
	rows: displayMessages,
	showingCached,
	isOffline,
} = usePostboxOfflineThreads({
	mailboxId: computed(() => String(props.mailboxId)),
	folderRole: folderRef,
	liveRows: messages,
	isLoading,
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
const pendingViewMode = ref<PostboxViewMode | null>(null);
const viewMode = computed<PostboxViewMode>(() => pendingViewMode.value ?? savedViewMode.value);
watch(savedViewMode, (saved) => {
	if (pendingViewMode.value === saved) pendingViewMode.value = null;
});
function selectViewMode(value: string) {
	const mode = resolvePostboxViewMode(value);
	if (mode === viewMode.value) return;
	pendingViewMode.value = mode;
	// The list already switched optimistically; useBackendOperation surfaces a
	// toast if the save fails, and the override snaps back to the saved mode.
	void setViewMode(mode).then((saved) => {
		if (!saved && pendingViewMode.value === mode) pendingViewMode.value = null;
	});
}
const activeListRenderer = computed(() => postboxListRenderer(viewMode.value, folderRef.value));

// Inbox landing mode — 'today' (the focused single-column PostboxTodayView;
// the default) vs 'browse' (the three panes below). Inbox-only: every other
// folder keeps the three-pane UI regardless of mode. A deep-linked message
// (/inbox/<id>) stays in Today mode too — the Today view opens it in its
// centered reader overlay over the list; in browse mode the same route is
// the unchanged three-pane reader. Same optimistic-override pattern as the
// view mode above; the server remembers the last-used mode.
const pendingInboxMode = ref<PostboxInboxMode | null>(null);
const inboxMode = computed<PostboxInboxMode>(() => pendingInboxMode.value ?? savedInboxMode.value);
watch(savedInboxMode, (saved) => {
	if (pendingInboxMode.value === saved) pendingInboxMode.value = null;
});
function switchInboxMode(mode: PostboxInboxMode) {
	if (mode === inboxMode.value) return;
	pendingInboxMode.value = mode;
	void setInboxMode(mode).then((saved) => {
		if (!saved && pendingInboxMode.value === mode) pendingInboxMode.value = null;
	});
}
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
// TRANSIENT override (pendingViewMode) — it must not silently overwrite the
// user's saved list preference.
function viewAutoFiled() {
	pendingViewMode.value = 'categories';
	switchInboxMode('browse');
}

// Focus the rail's search box after a mode flip mounts it (the `/` shortcut
// from Today mode; the rail consumes + clears the flag on mount).
const searchAutofocus = useState('postbox:search-autofocus', () => false);

// Mode shortcuts (window-level, like the triage-undo chord above): B (and
// Cmd/Ctrl-B) toggles Today ↔ Browse from the inbox list; Esc returns from
// Browse to Today; `/` from Today jumps to Browse with the search focused
// (search never renders inside the Today column). All inert in text inputs,
// while a message is open, and while any dialog is up.
function onModeKeydown(event: KeyboardEvent) {
	if (folderRef.value !== 'inbox' || props.folderId || props.activeMessageId) return;
	if (isEditableTarget(event.target)) return;
	if (event.defaultPrevented) return;
	if (document.querySelector('[role="dialog"]')) return;
	if (event.key.toLowerCase() === 'b' && !event.altKey && !event.shiftKey) {
		event.preventDefault();
		switchInboxMode(inboxMode.value === 'today' ? 'browse' : 'today');
		return;
	}
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	if (event.key === 'Escape' && inboxMode.value === 'browse') {
		switchInboxMode('today');
		return;
	}
	if (event.key === '/' && todayActive.value) {
		event.preventDefault();
		searchAutofocus.value = true;
		switchInboxMode('browse');
	}
}
onMounted(() => window.addEventListener('keydown', onModeKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onModeKeydown));

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
		     folder CRUD, labels, Reply Queue/Snoozed/Contacts, Cmd+Shift+D). -->
				<PostboxFolderRail
					:mailbox-id="mailboxId"
					:folder-role="folderRole"
					:folder-id="folderId"
				/>

				<!-- Pane 2: thread/message list -->
				<section class="w-96 border-r border-border-subtle flex flex-col bg-bg-surface">
					<!-- Quiet offline banner: cached list + already-read bodies stay
			     readable; server-backed actions degrade with clear affordances. -->
					<div
						v-if="isOffline"
						class="flex items-center gap-2 px-4 py-2 bg-warning-subtle text-warning text-xs border-b border-border-subtle"
						role="status"
					>
						<Icon name="lucide:cloud-off" class="w-3.5 h-3.5 flex-shrink-0" />
						<span class="truncate"
							>Offline — showing recent mail from this device. Actions are paused.</span
						>
					</div>
					<header class="border-b border-border-subtle px-4 py-3 flex items-center justify-between">
						<h2 class="text-sm font-semibold capitalize text-text-primary flex items-center gap-2">
							{{ currentFolderName }}
							<!-- Cold start from the device cache: a quiet "updating…" hint
					     while the live query catches up. Live rows replace in place. -->
							<!-- Suppressed while offline: the live query never settles, so a
					     permanent "updating…" would read as stuck — the offline banner
					     already communicates the state. -->
							<span
								v-if="showingCached && !isOffline"
								class="animate-pulse text-[11px] font-normal text-text-tertiary lowercase"
								>updating…</span
							>
						</h2>
						<div v-if="folderRole === 'inbox'" class="flex items-center gap-2">
							<!-- Back to the focused Today landing view (Esc / B do the same). -->
							<button
								v-if="!activeMessageId && !folderId"
								type="button"
								class="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-base focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
								aria-keyshortcuts="Escape b"
								title="Back to Today (Esc)"
								@click="switchInboxMode('today')"
							>
								Today
								<kbd
									class="text-[10px] text-text-tertiary border border-border-subtle rounded px-1"
									aria-hidden="true"
									>esc</kbd
								>
							</button>
							<!-- Labeled view-mode control — exactly one mode active; persisted
					     per user. Inbox-only: other folders stay flat. -->
							<UiSegmentedControl
								size="sm"
								aria-label="Inbox view"
								:options="POSTBOX_VIEW_MODE_OPTIONS"
								:model-value="viewMode"
								@update:model-value="selectViewMode"
							/>
						</div>
					</header>
					<template v-if="folderRole === 'drafts'">
						<div class="flex-1 overflow-auto">
							<PostboxDraftList :mailbox-id="mailboxId" />
						</div>
					</template>
					<template v-else>
						<!-- Compact "waiting on your reply" strip — inbox only, non-empty
				     queue only, dismissible for the session. -->
						<div
							v-if="showReplyQueueStrip"
							class="flex items-center gap-2 px-4 py-2 border-b border-border-subtle bg-brand/5 text-sm"
						>
							<Icon name="lucide:reply" class="w-4 h-4 text-brand flex-shrink-0" />
							<span class="flex-1 truncate text-text-secondary">
								{{ replyQueueCount }} {{ replyQueueCount === 1 ? 'email is' : 'emails are' }}
								waiting on your reply
							</span>
							<NuxtLink
								to="/dashboard/postbox/reply-queue"
								class="text-brand hover:underline flex-shrink-0"
							>
								Open queue
							</NuxtLink>
							<button
								type="button"
								class="p-0.5 rounded text-text-tertiary hover:text-text-primary flex-shrink-0"
								title="Dismiss for this session"
								aria-label="Dismiss reply queue reminder"
								@click="replyQueueStripDismissed = true"
							>
								<Icon name="lucide:x" class="w-3.5 h-3.5" />
							</button>
						</div>
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
										:messages="displayMessages"
										:loading="isLoading && !showingCached"
										:folder-role="folderRole"
										:active-message-id="activeMessageId"
										:has-more="hasMore"
										@load-more="loadMore"
									/>
								</div>
							</Transition>
						</div>
					</template>
				</section>

				<!-- Pane 3: reader -->
				<section class="flex-1 overflow-auto bg-bg-base">
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

		<PostboxShortcutHelp />
	</div>
</template>
