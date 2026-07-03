<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

// Collapsible agent processing trace (security scan -> classify -> retrieve ->
// draft -> route) for one inbound message. Lazy: the query runs only when
// expanded, so a long thread doesn't fan out a query per message.
// Auto-imports as <InboxAgentActionTimeline> (path-prefixed).
const props = defineProps<{ inboundMessageId: Id<'inboundMessages'> }>();

const open = ref(false);
const { data: actions } = useConvexQuery(
	api.inbox.queries.getMessageActions,
	() => (open.value ? { inboundMessageId: props.inboundMessageId } : 'skip'),
);

function statusIcon(status: string): string {
	switch (status) {
		case 'completed':
			return 'lucide:check-circle-2';
		case 'failed':
		case 'abandoned':
			return 'lucide:x-circle';
		case 'running':
			return 'lucide:loader-2';
		case 'skipped':
			return 'lucide:minus-circle';
		default:
			return 'lucide:circle';
	}
}

function statusColor(status: string): string {
	switch (status) {
		case 'completed':
			return 'text-success';
		case 'failed':
		case 'abandoned':
			return 'text-error';
		case 'skipped':
			return 'text-text-tertiary';
		default:
			return 'text-text-secondary';
	}
}

const ACTION_LABELS: Record<string, string> = {
	security_scan: 'Security scan',
	context_retrieval: 'Context retrieval',
	classify: 'Classify',
	draft: 'Draft reply',
	route: 'Route',
};
</script>

<template>
	<div class="mt-2">
		<button
			type="button"
			class="text-xs text-text-tertiary hover:text-text-secondary flex items-center gap-1"
			@click="open = !open"
		>
			<Icon :name="open ? 'lucide:chevron-down' : 'lucide:chevron-right'" class="w-3 h-3" />
			Agent processing trace
		</button>
		<div v-if="open" class="mt-2 pl-3 border-l border-border-subtle space-y-1.5">
			<div v-if="!actions || actions.length === 0" class="text-xs text-text-tertiary">
				No agent actions recorded.
			</div>
			<div v-for="a in actions" :key="a._id" class="flex items-center gap-2 text-xs">
				<Icon
					:name="statusIcon(a.status)"
					:class="['w-3.5 h-3.5 shrink-0', statusColor(a.status), a.status === 'running' ? 'animate-spin' : '']"
				/>
				<span class="text-text-primary">{{ ACTION_LABELS[a.actionType] ?? a.actionType }}</span>
				<span class="text-text-tertiary">· {{ a.status }}</span>
			</div>
		</div>
	</div>
</template>
