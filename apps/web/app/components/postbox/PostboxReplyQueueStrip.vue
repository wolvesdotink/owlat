<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

// Reply Queue inbox "waiting on your reply" strip. Inbox-only, non-empty queue
// only, and dismissible for the session (in-memory state, resets on reload).
// (The folder rail's own badge subscribes separately/deduped.) Extracted from
// PostboxLayout.vue to keep the layout under the file-size cap.
const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	folderRole: string;
}>();

const { count } = usePostboxReplyQueue(computed(() => props.mailboxId));
const dismissed = useState('postbox:reply-queue-strip-dismissed', () => false);
const visible = computed(() => props.folderRole === 'inbox' && count.value > 0 && !dismissed.value);
</script>

<template>
	<div
		v-if="visible"
		class="flex items-center gap-2 px-4 py-2 border-b border-border-subtle bg-brand/5 text-sm"
	>
		<Icon name="lucide:reply" class="w-4 h-4 text-brand flex-shrink-0" />
		<span class="flex-1 truncate text-text-secondary">
			{{ count }} {{ count === 1 ? 'email is' : 'emails are' }} waiting on your reply
		</span>
		<NuxtLink to="/dashboard/postbox/reply-queue" class="text-brand hover:underline flex-shrink-0">
			Open queue
		</NuxtLink>
		<!-- 44px square: a dismiss control that small is otherwise a coin toss on a
		     phone. Negative margins keep the strip the height the text gives it. -->
		<button
			type="button"
			class="-my-2 -mr-2 w-11 h-11 flex items-center justify-center flex-shrink-0 rounded text-text-tertiary hover:text-text-primary"
			title="Dismiss for this session"
			aria-label="Dismiss reply queue reminder"
			@click="dismissed = true"
		>
			<Icon name="lucide:x" class="w-3.5 h-3.5" />
		</button>
	</div>
</template>
