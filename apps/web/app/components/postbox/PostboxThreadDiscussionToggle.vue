<script setup lang="ts">
/**
 * "Discuss" — the reader toolbar button that shows or hides the thread's Team
 * discussion (PostboxThreadDiscussion), with the discussion's message count as
 * a badge. Hidden entirely when the `chat` feature is off or the backend
 * reports no access.
 */
const props = defineProps<{ threadId: string }>();

const { t } = useI18n();
const { isAvailable, isOpen, toggle } = usePostboxThreadDiscussionPanel();
const { discussion, count } = usePostboxThreadDiscussionData(() => props.threadId);
</script>

<template>
	<button
		v-if="isAvailable && discussion"
		type="button"
		class="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm text-text-secondary hover:bg-bg-surface hover:text-text-primary focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
		:class="{ 'bg-bg-surface text-text-primary': isOpen }"
		:aria-pressed="isOpen"
		:title="
			isOpen
				? t('components.postbox.threadDiscussion.toggleHide')
				: t('components.postbox.threadDiscussion.toggleShow')
		"
		data-testid="thread-discussion-toggle"
		@click="toggle"
	>
		<Icon name="lucide:messages-square" class="w-4 h-4" aria-hidden="true" />
		<span>{{ t('components.postbox.threadDiscussion.toggle') }}</span>
		<span
			v-if="count > 0"
			class="rounded-full bg-bg-surface px-1.5 text-2xs text-text-tertiary"
			:aria-label="t('components.postbox.threadDiscussion.count', { count })"
		>
			{{ count }}
		</span>
	</button>
</template>
