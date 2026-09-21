<script setup lang="ts">
/**
 * Conversation view — one row per thread. Shares the flat list's windowed
 * rendering and near-bottom auto-load: a busy inbox groups into thousands of
 * conversations, and this renderer used to mount every one of them and offer
 * only a manual "Load more".
 */
import { POSTBOX_ROW_HEIGHT } from '~/utils/postboxDensity';
import { usePostboxVirtualList } from '~/composables/postbox/usePostboxVirtualList';
import { usePostboxListAutoLoad } from '~/composables/postbox/usePostboxListAutoLoad';

const props = defineProps<{
	threads: Array<{
		_id: string;
		latestMessageId?: string;
		latestFromAddress: string;
		latestSubject: string;
		latestSnippet: string;
		lastMessageAt: number;
		messageCount: number;
		unreadCount: number;
		hasFlagged: boolean;
		hasAttachments: boolean;
	}>;
	loading: boolean;
	folderRole: string;
	activeMessageId?: string | null;
	hasMore?: boolean;
}>();

const emit = defineEmits<{ (e: 'load-more'): void }>();

const { t } = useI18n();

function threadTo(thread: { latestMessageId?: string }) {
	return thread.latestMessageId
		? `/dashboard/postbox/${props.folderRole}/${thread.latestMessageId}`
		: '';
}

const threadsRef = computed(() => props.threads);
const { focusedIndex, activeId, onKeydown } = usePostboxListKeyboard({
	items: threadsRef,
	resetKey: computed(() => props.folderRole),
	rowDomId: (thread) => `postbox-thread-${thread._id}`,
	onActivate: (thread) => {
		const to = threadTo(thread);
		if (to) void navigateTo(to);
	},
});

// --- Windowed rendering + infinite scroll -------------------------------------
// Same contract as the flat list: only large lists pay the windowing cost, row
// height is the known per-density constant, and the focused row is dragged back
// into the window so j/k never loses the ring on an unmounted row.
const VIRTUAL_THRESHOLD = 100;
const scrollEl = ref<HTMLElement | null>(null);
const { density } = usePostboxSettings();
const rowHeight = computed(() => POSTBOX_ROW_HEIGHT[density.value]);
const itemCount = computed(() => props.threads.length);
const virtualize = computed(() => itemCount.value > VIRTUAL_THRESHOLD);

const { range, syncScroll, scrollToIndex } = usePostboxVirtualList({
	scrollEl,
	itemCount,
	rowHeight,
	enabled: virtualize,
});

const windowStart = computed(() => (virtualize.value ? range.value.startIndex : 0));
const windowedThreads = computed(() =>
	virtualize.value
		? props.threads.slice(range.value.startIndex, range.value.endIndex)
		: props.threads
);

watch(focusedIndex, (idx) => {
	if (idx < 0 || !virtualize.value) return;
	scrollToIndex(idx);
});

// Grow the page before the seam shows, coalesced to one derivation per frame.
const { handleScroll } = usePostboxListAutoLoad({
	scrollEl,
	itemCount,
	hasMore: computed(() => props.hasMore === true),
	blocked: computed(() => props.loading),
	onScroll: () => syncScroll(),
	loadMore: () => emit('load-more'),
});
</script>

<template>
	<!-- Scroll container owns the list's position: the render window, the
	     near-bottom auto-load and the focus-follow all key off it. -->
	<div ref="scrollEl" class="h-full overflow-auto" @scroll="handleScroll()">
		<!-- Skeleton only on FIRST load (no rows yet) so live refreshes don't flash. -->
		<PostboxThreadListSkeleton v-if="loading && threads.length === 0" />
		<!-- The conversation view only serves the inbox, so empty means inbox zero. -->
		<PostboxEmptyState
			v-else-if="threads.length === 0"
			icon="lucide:check-circle-2"
			:title="t('components.postbox.postboxThreadGroupList.allClear')"
		/>
		<!-- role=listbox owns the full scroll height (so the scrollbar reflects every
	     thread while only a window is mounted); the inner container is
	     translate-positioned to the window's offset. -->
		<ul
			v-else
			tabindex="0"
			role="listbox"
			:aria-label="t('components.postbox.postboxThreadGroupList.listLabel')"
			:aria-activedescendant="activeId"
			class="outline-none focus-visible:ring-1 focus-visible:ring-brand/40 focus-visible:ring-inset"
			:class="{ relative: virtualize }"
			:style="virtualize ? { height: `${range.totalHeight}px` } : undefined"
			@keydown="onKeydown"
		>
			<div
				class="divide-y divide-border-subtle"
				:class="{ 'absolute inset-x-0 top-0': virtualize }"
				:style="virtualize ? { transform: `translateY(${range.offsetY}px)` } : undefined"
			>
				<!-- `pbx-virtual-row` pins the box to exactly the row height the
				     window math assumes (border-box, so the divide-y hairline is
				     absorbed rather than added). Without it a natural-height row —
				     compact density lands near, not on, 52px — drifts a little per
				     row against translateY, and by a few hundred rows the painted
				     content no longer matches the ul's fixed totalHeight. -->
				<li
					v-for="(thread, localI) in windowedThreads"
					:key="thread._id"
					:class="{ 'pbx-virtual-row': virtualize }"
					style="
						content-visibility: auto;
						contain-intrinsic-size: auto var(--pbx-row-intrinsic, 76px);
					"
				>
					<NuxtLink
						:id="`postbox-thread-${thread._id}`"
						role="option"
						:aria-selected="focusedIndex === windowStart + localI"
						:aria-label="
							thread.unreadCount > 0
								? t('components.postbox.postboxThreadGroupList.rowLabel', {
										subject:
											thread.latestSubject ||
											t('components.postbox.postboxThreadGroupList.noSubjectLabel'),
										count: thread.unreadCount,
									})
								: undefined
						"
						:to="threadTo(thread)"
						class="pbx-row-link block px-4 py-3 hover:bg-bg-elevated"
						:class="{
							'bg-bg-elevated': activeMessageId && activeMessageId === thread.latestMessageId,
						}"
					>
						<div class="flex items-baseline justify-between gap-3">
							<span
								class="truncate text-sm"
								:class="
									thread.unreadCount > 0 ? 'font-semibold text-text-primary' : 'text-text-secondary'
								"
							>
								{{ thread.latestFromAddress }}
								<span v-if="thread.messageCount > 1" class="text-text-tertiary font-normal"
									>({{ thread.messageCount }})</span
								>
							</span>
							<span class="text-xs text-text-tertiary flex-shrink-0">
								{{ formatThreadTimestamp(thread.lastMessageAt) }}
							</span>
						</div>
						<div class="flex items-center gap-1.5 mt-0.5">
							<Icon v-if="thread.hasFlagged" name="lucide:star" class="w-3.5 h-3.5 text-warning" />
							<Icon
								v-if="thread.hasAttachments"
								name="lucide:paperclip"
								class="w-3.5 h-3.5 text-text-tertiary"
							/>
							<p
								class="truncate text-sm flex-1"
								:class="
									thread.unreadCount > 0 ? 'font-medium text-text-primary' : 'text-text-secondary'
								"
							>
								{{
									thread.latestSubject || t('components.postbox.postboxThreadGroupList.noSubject')
								}}
							</p>
							<span
								v-if="thread.unreadCount > 0"
								class="text-xs bg-brand text-text-inverse rounded-full px-1.5 min-w-[1.25rem] text-center"
								>{{ thread.unreadCount }}</span
							>
						</div>
						<p class="pbx-row-snippet text-xs text-text-tertiary truncate mt-0.5">
							{{ thread.latestSnippet }}
						</p>
					</NuxtLink>
				</li>
			</div>
		</ul>
		<!-- Fallback trigger: the scroll auto-grows the page, but the button stays
	     so a user can still advance if the auto-load stalls. -->
		<div v-if="!loading && hasMore" class="p-3 text-center">
			<button type="button" class="text-sm text-brand hover:underline" @click="emit('load-more')">
				{{ t('components.postbox.postboxThreadGroupList.loadMore') }}
			</button>
		</div>
	</div>
</template>
