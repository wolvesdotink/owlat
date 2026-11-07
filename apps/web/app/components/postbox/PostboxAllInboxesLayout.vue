<script setup lang="ts">
/**
 * All inboxes and the unified folders as a mailbox view: one system folder
 * (`role`) of every mailbox the viewer reads (their own, and the team inboxes
 * they are a member of) in one list, with the same list, reader pane, keyboard
 * triage, quick actions, selection and bulk bar as a single folder. Each row
 * wears its inbox chip, and the reader acts in the open message's own mailbox,
 * so a reply goes out from the address that received it. All Drafts lists the
 * drafts of those mailboxes, as one mailbox's Drafts does.
 *
 * The rows come from one merged, paginated query; the server routes and gates
 * every action by the mailbox each message belongs to. What names one
 * mailbox's folders or labels (the bulk Move and overflow, the whole-folder
 * select-all, "Empty now", the list renderers other than the flat one, Today)
 * stays in the single-mailbox view the rail links to. "Mark all as read" walks
 * each listed mailbox's folder through its own access check.
 */
import type { Id } from '@owlat/api/dataModel';
import {
	allInboxesQuerySuffix,
	unifiedFolderHref,
	unifiedFolderSegment,
	type UnifiedFolderRole,
} from '~/utils/postboxAllInboxes';
import { POSTBOX_LIST_QUERY } from '~/composables/postbox/usePostboxPlacementFilter';
import { providePostboxRowInbox } from '~/composables/postbox/usePostboxRowInbox';
import { usePostboxAllInboxesFeed } from '~/composables/postbox/usePostboxAllInboxesFeed';
import { usePostboxMarkReadCommands } from '~/composables/postbox/usePostboxCommandSurface';
import { MAIL_CATEGORY_META, type MailCategory } from '~/utils/mailCategory';
import PostboxAllInboxesRail from './PostboxAllInboxesRail.vue';
import PostboxAllInboxesNarrow from './PostboxAllInboxesNarrow.vue';
import { CloseIcon } from '@coolicons/vue';

const props = defineProps<{
	role: UnifiedFolderRole;
	activeMessageId?: string | null;
}>();

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const role = computed(() => props.role);
const segment = computed(() => unifiedFolderSegment(props.role));
const title = computed(() => t(`components.postbox.allInboxes.roles.${props.role}`));

const { inboxes, byId } = useInboxes();
providePostboxRowInbox(byId);

// `?in=` narrows to one mailbox; an id the viewer no longer reads shows them all.
const only = computed(() => {
	const raw = route.query['in'];
	return typeof raw === 'string' && byId.value.has(raw as Id<'mailboxes'>)
		? (raw as Id<'mailboxes'>)
		: null;
});
// `?category=`: Today's "Filed away" links land on one smart-inbox category.
// Categories sort the Inbox only.
const category = computed(() => {
	const raw = route.query['category'];
	return props.role === 'inbox' && typeof raw === 'string' && raw !== '' ? raw : null;
});

const feed = usePostboxAllInboxesFeed({
	role,
	only,
	provider: computed(() => {
		const raw = route.query['provider'];
		return typeof raw === 'string' && raw !== '' ? raw : null;
	}),
});
const { providers, provider } = feed;
/** The mailboxes the narrow keeps, whose drafts All Drafts lists. */
const draftMailboxIds = feed.mailboxIds;

// "Mark all as read" over what the list shows: the role's folder of every
// mailbox the narrow keeps, and only the category when one is picked. Drafts
// have no read state.
const markRead = computed(() => {
	if (props.role === 'drafts') return null;
	const folderIds = feed.sources.value.map((source) => source.folderId);
	if (folderIds.length === 0) return null;
	// A `?category=` no category answers to lists nothing, so there is nothing to mark.
	if (category.value !== null && !Object.hasOwn(MAIL_CATEGORY_META, category.value)) return null;
	return {
		target: {
			kind: 'folders' as const,
			folderIds,
			category: category.value as MailCategory | null,
		},
		// Only the Inbox's unread count is known up front.
		enabled: props.role !== 'inbox' || category.value !== null || feed.inboxUnread.value > 0,
	};
});
usePostboxMarkReadCommands('all-inboxes', ref(null), () =>
	markRead.value?.enabled
		? [
				{
					key: 'all-inboxes',
					label: t('components.postbox.postboxFolderActions.markAllRead'),
					target: markRead.value.target,
				},
			]
		: []
);

const listQuery = computed(() =>
	allInboxesQuerySuffix({ in: only.value, provider: provider.value, category: category.value })
);
// Every route the list and the reader build keeps the filters.
provide(POSTBOX_LIST_QUERY, listQuery);

const { density, setDensity, readingPane, setReadingPane, listWidth, listHeight, setListSize } =
	usePostboxSettings();
const { unreadStyle, setUnreadStyle } = usePostboxUnreadStyle();
const zen = usePostboxZen(readingPane);
const activeMessageId = computed(() => props.activeMessageId);
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
	readingPane: zen.readingPane,
	listWidth,
	listHeight,
	setListSize,
	activeMessageId,
});
const listPaneRef = ref<HTMLElement | null>(null);

const { messages, isLoading, isLoadingMore, hasMore, canLoadMore, loadMore } = feed;
// The folder and its narrow: what the triage chips and the selection belong
// to. The header, the list and the bulk bar bind the same selection by it, and
// changing it leaves the previous selection behind.
const listScope = computed(() => `${segment.value}:${only.value ?? provider.value ?? 'all'}`);
const categoryRows = computed(() =>
	category.value ? messages.value.filter((m) => m.category === category.value) : messages.value
);
const {
	active: triageFilter,
	setFilter: setTriageFilter,
	counts: triageCounts,
	countsArePartial: triageCountsArePartial,
	filtered: filteredMessages,
} = usePostboxTriageFilters({
	scope: listScope,
	rows: categoryRows,
	hasMore,
});
const listMessages = computed(() =>
	triageFilter.value === 'all' ? categoryRows.value : filteredMessages.value
);
const listMessageIds = computed(() => listMessages.value.map((m) => m._id));
const filterHidesRows = computed(
	() => (triageFilter.value !== 'all' || category.value !== null) && messages.value.length > 0
);

function setNarrow(filter: { in: string | null; provider: string | null }) {
	void router.replace(unifiedFolderHref(props.role, { ...filter, category: category.value }));
}
function clearCategory() {
	if (!category.value) return;
	const query = { ...route.query };
	delete query['category'];
	void router.replace({ query });
}
function clearFilters() {
	setTriageFilter('all');
	clearCategory();
}

const chunkWarmup = usePostboxChunkWarmup();
watch(isLoading, (loading) => !loading && chunkWarmup.warm(), { immediate: true });

// Below lg the rail is a drawer; any navigation dismisses it.
const railOpen = ref(false);
watch(
	() => route.fullPath,
	() => {
		railOpen.value = false;
	},
	{ flush: 'post' }
);

/** Drill-in back: replace, so the system Back does not reopen the reader. */
function backToList() {
	void navigateTo(`/dashboard/postbox/${segment.value}${listQuery.value}`, { replace: true });
}

const activeRead = usePostboxActiveMessageRead({
	activeMessageId: () => props.activeMessageId,
	listRows: () => messages.value,
});

// Auto-advance and Zen previous/next follow the list's visual row order.
const threadListRef = ref<{ visibleIds: string[] } | null>(null);
const advanceIds = computed(
	() => threadListRef.value?.visibleIds ?? messages.value.map((m) => m._id)
);
</script>

<template>
	<div
		class="flex w-full min-w-0"
		:data-density="density"
		:data-unread-style="unreadStyle"
		:data-reading-pane="zen.readingPane.value"
		:style="paneStyle"
	>
		<PostboxFolderDrawer v-model:open="railOpen" :zen="zen.isZen.value">
			<PostboxAllInboxesRail
				:role="role"
				:inboxes="inboxes"
				:only="only"
				:provider="provider"
				:category="category"
			/>
		</PostboxFolderDrawer>

		<div class="flex w-full min-w-0" :class="{ 'mx-auto max-w-4xl': zen.isZen.value }">
			<div class="pbx-pane-split flex flex-1 min-w-0 min-h-0">
				<section
					ref="listPaneRef"
					class="pbx-pane-list w-full border-border-subtle flex-col bg-bg-surface min-w-0 min-h-0"
					:class="[listPaneVisibility, listPaneBorder]"
				>
					<PostboxListHeader
						:folder-name="title"
						:folder-role="segment"
						:active-message-id="activeMessageId"
						:density="density"
						:unread-style="unreadStyle"
						:reading-pane="readingPane"
						:selection-scope="role === 'drafts' ? undefined : listScope"
						:page-ids="listMessageIds"
						:mark-read="markRead"
						@open-rail="railOpen = true"
						@select-density="(mode) => void setDensity(mode)"
						@select-unread-style="(style) => void setUnreadStyle(style)"
						@select-reading-pane="(pane) => void setReadingPane(pane)"
					/>
					<div
						v-if="category || inboxes.length > 1"
						class="flex flex-wrap items-center gap-2 px-4 pt-3"
						:class="{ 'pb-3 border-b border-border-subtle': role === 'drafts' }"
					>
						<PostboxAllInboxesNarrow
							:inboxes="inboxes"
							:providers="providers"
							:only="only"
							:provider="provider"
							@narrow="setNarrow"
						/>
						<button
							v-if="category"
							type="button"
							class="inline-flex items-center gap-1 rounded-full bg-bg-elevated px-2.5 py-1 text-xs font-medium text-text-primary shadow-(--shadow-1)"
							:aria-label="t('components.postbox.allInboxes.clearCategory')"
							data-testid="all-inboxes-category"
							@click="clearCategory"
						>
							{{ t(`components.postbox.allInboxes.category.${category}`) }}
							<CloseIcon class="size-3" />
						</button>
					</div>
					<div v-if="role === 'drafts'" class="flex-1 overflow-auto">
						<PostboxDraftList :mailbox-ids="draftMailboxIds" />
					</div>
					<template v-else>
						<PostboxTriageFilterChips
							class="border-b border-border-subtle pb-3"
							:filter="triageFilter"
							:counts="triageCounts"
							:counts-are-partial="triageCountsArePartial"
							@select-filter="setTriageFilter"
						/>
						<PostboxQuickActionsBar
							:selection-scope="listScope"
							:folder-role="role"
							:page-ids="listMessageIds"
						/>
						<div class="flex-1 overflow-auto">
							<AppErrorBoundary surface="list">
								<!-- A failed read is not an empty inbox. -->
								<UiQueryBoundary
									v-if="feed.error.value && listMessages.length === 0"
									:error="feed.error.value"
									@retry="feed.refetch"
								/>
								<PostboxThreadList
									v-else
									ref="threadListRef"
									:selection-scope="listScope"
									:messages="listMessages"
									:loading="isLoading"
									:folder-role="role"
									:folder-id="segment"
									:active-message-id="activeMessageId"
									:has-more="canLoadMore"
									:loading-more="isLoadingMore"
									:filter-active="filterHidesRows"
									@load-more="loadMore"
									@clear-filter="clearFilters"
								/>
							</AppErrorBoundary>
						</div>
					</template>
				</section>

				<PostboxPaneResizer
					v-if="geometry.axis"
					:axis="geometry.axis"
					:model-value="listSize"
					:pane-el="listPaneRef"
					@update:model-value="previewListSize"
					@commit="commitListSize"
				/>

				<PostboxReaderPane
					class="pbx-pane-reader @container flex-1 min-w-0 min-h-0 overflow-auto bg-bg-base"
					:class="readerPaneVisibility"
					:active-message-id="activeMessageId"
					:message="activeRead.message.value"
					:advance-ids="advanceIds"
					:step-ids="advanceIds"
					:folder-path="segment"
					:folder-name="title"
					:zen="zen.isZen.value"
					:error="activeRead.error.value"
					:not-found="activeRead.notFound.value"
					@retry="activeRead.refetch"
					@back="backToList"
				/>
			</div>
		</div>

		<PostboxShortcutHelp />
	</div>
</template>
