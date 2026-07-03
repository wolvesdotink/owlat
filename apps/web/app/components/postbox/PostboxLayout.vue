<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

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

// List/reader density → applied as a single data-density attribute on the
// Postbox root; all compact styling lives in CSS keyed off it (postbox-density.css).
const { density } = usePostboxSettings();

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
		? customFolders.value.find((f) => f._id === props.folderId)?.name ?? 'Folder'
		: props.folderRole
);

// Conversation (thread-grouped) view — opt-in for the inbox; the flat list with
// its hover/keyboard triage stays the default and serves all other folders.
const conversationView = useState('postbox:conversation-view', () => false);
const threadGroupsEnabled = computed(() => folderRef.value === 'inbox' && conversationView.value);
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

// Smart-inbox split view — opt-in for the inbox, off by default. Groups the
// inbox into People / Newsletters / Notifications / Receipts sections. Takes
// precedence over the conversation toggle when both are on.
const categoryView = useState('postbox:category-view', () => false);
const categoryGroupsEnabled = computed(
	() => folderRef.value === 'inbox' && categoryView.value
);
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

const listActive = computed(() =>
	messages.value.find((m) => m._id === props.activeMessageId)
);
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
			threadListRef.value?.visibleIds ?? messages.value.map((m) => m._id)
);

// Reply Queue inbox "waiting on your reply" strip. The strip is dismissible for
// the session (in-memory state, resets on reload) and only renders while the
// queue is non-empty. (The rail's own badge subscribes separately/deduped.)
const { count: replyQueueCount } = usePostboxReplyQueue(mailboxIdRef);
const replyQueueStripDismissed = useState('postbox:reply-queue-strip-dismissed', () => false);
const showReplyQueueStrip = computed(
	() =>
		folderRef.value === 'inbox' &&
		replyQueueCount.value > 0 &&
		!replyQueueStripDismissed.value
);
</script>

<template>
	<div class="flex w-full" :data-density="density">
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
				<span class="truncate">Offline — showing recent mail from this device. Actions are paused.</span>
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
					>updating…</span>
				</h2>
				<div v-if="folderRole === 'inbox'" class="flex items-center gap-1">
					<button
						type="button"
						class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-text-primary"
						:class="{ 'text-brand': categoryView }"
						:title="categoryView ? 'Show a single list' : 'Group by category'"
						:aria-label="categoryView ? 'Show a single list' : 'Group by category'"
						:aria-pressed="categoryView"
						@click="categoryView = !categoryView"
					>
						<Icon name="lucide:layout-list" class="w-4 h-4" />
					</button>
					<button
						type="button"
						class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-text-primary"
						:title="conversationView ? 'Show individual messages' : 'Group by conversation'"
						:aria-label="conversationView ? 'Show individual messages' : 'Group by conversation'"
						:aria-pressed="conversationView"
						@click="conversationView = !conversationView"
					>
						<Icon
							:name="conversationView ? 'lucide:list' : 'lucide:messages-square'"
							class="w-4 h-4"
						/>
					</button>
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
					<Transition name="pbx-fade" mode="out-in">
					<div :key="String(folderId ?? folderRole ?? 'all')" class="h-full">
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

		<PostboxCommandPalette :mailbox-id="mailboxId" />
		<PostboxShortcutHelp />
	</div>
</template>
