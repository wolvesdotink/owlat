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

function threadTo(t: { latestMessageId?: string }) {
	return t.latestMessageId ? `/dashboard/postbox/${props.folderRole}/${t.latestMessageId}` : '';
}

const threadsRef = computed(() => props.threads);
const { focusedIndex, activeId, onKeydown } = usePostboxListKeyboard({
	items: threadsRef,
	resetKey: computed(() => props.folderRole),
	rowDomId: (t) => `postbox-thread-${t._id}`,
	onActivate: (t) => {
		const to = threadTo(t);
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
		title="All clear"
	/>
	<ul
		v-else
		tabindex="0"
		role="listbox"
		aria-label="Conversations"
		:aria-activedescendant="activeId"
		class="divide-y divide-border-subtle outline-none focus-visible:ring-1 focus-visible:ring-brand/40 focus-visible:ring-inset"
		@keydown="onKeydown"
	>
		<li
			v-for="(t, i) in threads"
			:key="t._id"
			style="content-visibility: auto; contain-intrinsic-size: auto 76px"
		>
			<NuxtLink
				:id="`postbox-thread-${t._id}`"
				role="option"
				:aria-selected="focusedIndex === i"
				:aria-label="t.unreadCount > 0 ? `${t.latestSubject || 'No subject'}, ${t.unreadCount} unread` : undefined"
				:to="threadTo(t)"
				class="block px-4 py-3 hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated': activeMessageId && activeMessageId === t.latestMessageId }"
			>
				<div class="flex items-baseline justify-between gap-3">
					<span
						class="truncate text-sm"
						:class="t.unreadCount > 0 ? 'font-semibold text-text-primary' : 'text-text-secondary'"
					>
						{{ t.latestFromAddress }}
						<span v-if="t.messageCount > 1" class="text-text-tertiary font-normal"
							>({{ t.messageCount }})</span
						>
					</span>
					<span class="text-xs text-text-tertiary flex-shrink-0">
						{{ formatThreadTimestamp(t.lastMessageAt) }}
					</span>
				</div>
				<div class="flex items-center gap-1.5 mt-0.5">
					<Icon v-if="t.hasFlagged" name="lucide:star" class="w-3.5 h-3.5 text-warning" />
					<Icon
						v-if="t.hasAttachments"
						name="lucide:paperclip"
						class="w-3.5 h-3.5 text-text-tertiary"
					/>
					<p
						class="truncate text-sm flex-1"
						:class="t.unreadCount > 0 ? 'font-medium text-text-primary' : 'text-text-secondary'"
					>
						{{ t.latestSubject || '(no subject)' }}
					</p>
					<span
						v-if="t.unreadCount > 0"
						class="text-xs bg-brand text-white rounded-full px-1.5 min-w-[1.25rem] text-center"
					>{{ t.unreadCount }}</span>
				</div>
				<p class="text-xs text-text-tertiary truncate mt-0.5">{{ t.latestSnippet }}</p>
			</NuxtLink>
		</li>
	</ul>
	<div v-if="!loading && hasMore" class="p-3 text-center">
		<button type="button" class="text-sm text-brand hover:underline" @click="emit('load-more')">
			Load more
		</button>
	</div>
</template>
