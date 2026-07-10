<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

// Team-inbox collision safety (display half): in a shared inbox, show who
// replied last on this thread so a teammate can see at a glance that it's
// already handled. Returns null for a personal mailbox, so this renders nothing
// there — personal reader behaviour is unchanged.
const props = defineProps<{
	messageId: Id<'mailMessages'>;
}>();

const { data } = useConvexQuery(api.mail.mailbox.latestReplyState, () => ({
	messageId: props.messageId,
}));

const label = computed(() => {
	const reply = data.value;
	if (!reply) return null;
	const when = formatRelativeTime(reply.at);
	if (reply.byIsYou) return `You replied last · ${when}`;
	if (reply.byName) return `${reply.byName} replied last · ${when}`;
	return `A teammate replied last · ${when}`;
});
</script>

<template>
	<div
		v-if="label"
		class="inline-flex items-center gap-1.5 rounded-full bg-bg-surface border border-border-subtle px-2.5 py-1 text-xs text-text-secondary"
		role="note"
	>
		<Icon name="lucide:users" class="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
		<span class="truncate">{{ label }}</span>
	</div>
</template>
