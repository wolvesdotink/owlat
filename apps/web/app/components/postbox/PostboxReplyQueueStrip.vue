<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { usePostboxReplyQueueBanner } from '~/composables/postbox/usePostboxBanners';

// Reply Queue inbox "waiting on your reply" strip. Inbox-only, non-empty queue
// only, and dismissible for the session (in-memory state, resets on reload).
// (The folder rail's own badge subscribes separately/deduped, which is why this
// is the strip that yields first in the list pane's one banner slot — its count
// never leaves the screen.) Extracted from PostboxLayout.vue to keep the layout
// under the file-size cap; the visibility predicate is shared with the slot.
const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	folderRole: string;
}>();

const { t } = useI18n();

const { count, dismissed, visible } = usePostboxReplyQueueBanner(
	computed(() => props.mailboxId),
	computed(() => props.folderRole)
);
</script>

<template>
	<div
		v-if="visible"
		class="flex items-center gap-2 px-4 py-2 border-b border-border-subtle bg-brand/5 text-sm"
	>
		<Icon name="lucide:reply" class="w-4 h-4 text-brand flex-shrink-0" />
		<span class="flex-1 truncate text-text-secondary">
			{{ t('components.postbox.postboxReplyQueueStrip.waiting', { count }, count) }}
		</span>
		<NuxtLink to="/dashboard/postbox/reply-queue" class="text-brand hover:underline flex-shrink-0">
			{{ t('components.postbox.postboxReplyQueueStrip.openQueue') }}
		</NuxtLink>
		<!-- 44px square: a dismiss control that small is otherwise a coin toss on a
		     phone. Negative margins keep the strip the height the text gives it. -->
		<button
			type="button"
			class="-my-2 -mr-2 w-11 h-11 flex items-center justify-center flex-shrink-0 rounded text-text-tertiary hover:text-text-primary"
			:title="t('components.postbox.postboxReplyQueueStrip.dismissTitle')"
			:aria-label="t('components.postbox.postboxReplyQueueStrip.dismissLabel')"
			@click="dismissed = true"
		>
			<Icon name="lucide:x" class="w-3.5 h-3.5" />
		</button>
	</div>
</template>
