<script setup lang="ts">
/**
 * One conversation (thread summary) row: latest sender with the message
 * count, timestamp, star and attachment marks, subject with the unread pill,
 * and the snippet. It is the listbox option itself, so it carries the row's
 * id and selection, and its visible text is its accessible name.
 *
 * Shared by the conversation view (PostboxThreadGroupList) and the categories
 * view (PostboxThreadCategoryList). The unread pill is only a number on
 * screen, so it carries a screen-reader-only "N unread" beside it. An
 * `aria-label` would replace the whole row and drop the sender and snippet.
 */
import { usePostboxThreadTimestamp } from '~/composables/postbox/usePostboxListClock';
import { vReplyDrop } from '~/composables/useReplyFileDrop';
import { replyDropForMessage } from '~/utils/replyFileDrop';
import PostboxUnreadMark from './PostboxUnreadMark.vue';
import { PaperclipIcon, PinIcon, StarIcon } from '@coolicons/vue';

export type PostboxConversationThread = {
	_id: string;
	latestMessageId?: string;
	latestFromAddress: string;
	/** The newest sender's display name; absent when that message has none. */
	latestFromName?: string;
	latestSubject: string;
	latestSnippet: string;
	lastMessageAt: number;
	messageCount: number;
	unreadCount: number;
	hasFlagged: boolean;
	hasAttachments: boolean;
	/** In the Inbox's pinned band (mail/pins.ts). */
	pinnedAt?: number;
};

const props = defineProps<{
	thread: PostboxConversationThread;
	/** DOM id, the target of the listbox's aria-activedescendant. */
	domId: string;
	to: string;
	/** Keyboard focus (aria-selected). */
	selected: boolean;
	/** The conversation open in the reader. */
	active?: boolean;
	/** The folder the list shows; a draft's row takes no reply drop. */
	folderRole?: string;
}>();

const { t } = useI18n();
// Ticks with the list's shared minute clock (usePostboxListClock).
const formatTimestamp = usePostboxThreadTimestamp();

// Files dropped on the row reply to the conversation's latest message.
const replyDrop = computed(() => {
	const { latestMessageId, latestFromAddress } = props.thread;
	return latestMessageId
		? replyDropForMessage(
				{ _id: latestMessageId, fromAddress: latestFromAddress },
				props.folderRole
			)
		: null;
});

// Named like the flat list's rows: the display name, else the address.
const senderLabel = computed(
	() => props.thread.latestFromName?.trim() || props.thread.latestFromAddress
);
</script>

<template>
	<NuxtLink
		:id="domId"
		v-reply-drop="replyDrop"
		role="option"
		:aria-selected="selected"
		:to="to"
		class="pbx-row-link block px-4 py-3 hover:bg-(--surface-1-hover)"
		:class="{ 'bg-(--surface-1-selected)': active }"
	>
		<div class="flex items-baseline justify-between gap-3">
			<span
				data-testid="row-sender"
				:title="thread.latestFromAddress"
				class="truncate text-sm"
				:class="
					thread.unreadCount > 0
						? 'pbx-unread-weight font-semibold text-text-primary'
						: 'text-text-secondary'
				"
			>
				<PostboxUnreadMark v-if="thread.unreadCount > 0" />{{ senderLabel }}
				<span v-if="thread.messageCount > 1" class="text-text-tertiary font-normal"
					>({{ thread.messageCount }})</span
				>
			</span>
			<span class="text-xs text-text-tertiary flex-shrink-0">
				{{ formatTimestamp(thread.lastMessageAt) }}
			</span>
		</div>
		<div class="flex items-center gap-1.5 mt-0.5">
			<StarIcon v-if="thread.hasFlagged" class="w-3.5 h-3.5 text-warning" />
			<PinIcon
				v-if="thread.pinnedAt"
				class="w-3.5 h-3.5 text-brand"
				:title="t('components.postbox.postboxThreadRow.pinnedChip')"
				:aria-label="t('components.postbox.postboxThreadRow.pinnedChip')"
			/>
			<PaperclipIcon v-if="thread.hasAttachments" class="w-3.5 h-3.5 text-text-tertiary" />
			<p
				class="truncate text-sm flex-1"
				:class="
					thread.unreadCount > 0
						? 'pbx-unread-weight font-medium text-text-primary'
						: 'text-text-secondary'
				"
			>
				{{ thread.latestSubject || t('components.postbox.postboxConversationRow.noSubject') }}
			</p>
			<template v-if="thread.unreadCount > 0">
				<span
					aria-hidden="true"
					class="text-xs bg-brand text-text-inverse rounded-full px-1.5 min-w-[1.25rem] text-center"
					>{{ thread.unreadCount }}</span
				>
				<span class="sr-only" data-testid="row-unread-count">{{
					t('components.postbox.postboxConversationRow.unreadCount', {
						count: thread.unreadCount,
					})
				}}</span>
			</template>
		</div>
		<p class="pbx-row-snippet text-xs text-text-tertiary truncate mt-0.5">
			{{ thread.latestSnippet }}
		</p>
	</NuxtLink>
</template>
