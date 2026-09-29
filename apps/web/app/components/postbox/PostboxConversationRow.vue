<script setup lang="ts">
/**
 * One conversation (thread summary) row: latest sender with the message
 * count, timestamp, star and attachment marks, subject with the unread pill,
 * and the snippet. It is the listbox option itself, so it carries the row's
 * id, selection and its unread-aware accessible name.
 *
 * Shared by the conversation view (PostboxThreadGroupList) and the categories
 * view (PostboxThreadCategoryList). The accessible name matters: the unread
 * pill is only a number on screen, so without the label a screen reader hears
 * the subject and no unread count.
 */
export type PostboxConversationThread = {
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
}>();

const { t } = useI18n();

const rowLabel = computed(() =>
	props.thread.unreadCount > 0
		? t('components.postbox.postboxConversationRow.rowLabel', {
				subject:
					props.thread.latestSubject ||
					t('components.postbox.postboxConversationRow.noSubjectLabel'),
				count: props.thread.unreadCount,
			})
		: undefined
);
</script>

<template>
	<NuxtLink
		:id="domId"
		role="option"
		:aria-selected="selected"
		:aria-label="rowLabel"
		:to="to"
		class="pbx-row-link block px-4 py-3 hover:bg-bg-elevated"
		:class="{ 'bg-bg-elevated': active }"
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
				{{ thread.latestSubject || t('components.postbox.postboxConversationRow.noSubject') }}
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
</template>
