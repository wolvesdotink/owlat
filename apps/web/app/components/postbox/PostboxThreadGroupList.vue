<script setup lang="ts">
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
</script>

<template>
	<!-- Skeleton only on FIRST load (no rows yet) so live refreshes don't flash. -->
	<PostboxThreadListSkeleton v-if="loading && threads.length === 0" />
	<!-- The conversation view only serves the inbox, so empty means inbox zero. -->
	<PostboxEmptyState
		v-else-if="threads.length === 0"
		icon="lucide:check-circle-2"
		:title="t('components.postbox.postboxThreadGroupList.allClear')"
	/>
	<ul
		v-else
		tabindex="0"
		role="listbox"
		:aria-label="t('components.postbox.postboxThreadGroupList.listLabel')"
		:aria-activedescendant="activeId"
		class="divide-y divide-border-subtle outline-none focus-visible:ring-1 focus-visible:ring-brand/40 focus-visible:ring-inset"
		@keydown="onKeydown"
	>
		<li
			v-for="(thread, i) in threads"
			:key="thread._id"
			style="content-visibility: auto; contain-intrinsic-size: auto var(--pbx-row-intrinsic, 76px)"
		>
			<NuxtLink
				:id="`postbox-thread-${thread._id}`"
				role="option"
				:aria-selected="focusedIndex === i"
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
				:class="{ 'bg-bg-elevated': activeMessageId && activeMessageId === thread.latestMessageId }"
			>
				<div class="flex items-baseline justify-between gap-3">
					<span
						class="truncate text-sm"
						:class="thread.unreadCount > 0 ? 'font-semibold text-text-primary' : 'text-text-secondary'"
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
						:class="thread.unreadCount > 0 ? 'font-medium text-text-primary' : 'text-text-secondary'"
					>
						{{ thread.latestSubject || t('components.postbox.postboxThreadGroupList.noSubject') }}
					</p>
					<span
						v-if="thread.unreadCount > 0"
						class="text-xs bg-brand text-text-inverse rounded-full px-1.5 min-w-[1.25rem] text-center"
					>{{ thread.unreadCount }}</span>
				</div>
				<p class="pbx-row-snippet text-xs text-text-tertiary truncate mt-0.5">{{ thread.latestSnippet }}</p>
			</NuxtLink>
		</li>
	</ul>
	<div v-if="!loading && hasMore" class="p-3 text-center">
		<button type="button" class="text-sm text-brand hover:underline" @click="emit('load-more')">
			{{ t('components.postbox.postboxThreadGroupList.loadMore') }}
		</button>
	</div>
</template>
