<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

// Collapsible agent processing trace (security scan -> classify -> retrieve ->
// draft -> route) for one inbound message. Lazy: the query runs only when
// expanded, so a long thread doesn't fan out a query per message.
// Auto-imports as <InboxAgentActionTimeline> (path-prefixed).
const props = defineProps<{ inboundMessageId: Id<'inboundMessages'> }>();

const { t } = useI18n();

const open = ref(false);
const { data: actions } = useConvexQuery(
	api.inbox.queries.getMessageActions,
	() => (open.value ? { inboundMessageId: props.inboundMessageId } : 'skip'),
);

interface AgentActionBadge {
	icon: string;
	color: string;
}

const STATUS_BADGES: Record<string, AgentActionBadge> = {
	completed: { icon: 'lucide:check-circle-2', color: 'text-success' },
	failed: { icon: 'lucide:x-circle', color: 'text-error' },
	abandoned: { icon: 'lucide:x-circle', color: 'text-error' },
	running: { icon: 'lucide:loader-2', color: 'text-text-secondary' },
	skipped: { icon: 'lucide:minus-circle', color: 'text-text-tertiary' },
};

const STATUS_BADGE_DEFAULT: AgentActionBadge = { icon: 'lucide:circle', color: 'text-text-secondary' };

function statusBadge(status: string): AgentActionBadge {
	return STATUS_BADGES[status] ?? STATUS_BADGE_DEFAULT;
}

// Message keys, not text: both records are built once at setup, and an unknown
// literal falls back to the raw value rather than a missing key path.
const ACTION_LABEL_KEYS: Record<string, string> = {
	security_scan: 'components.inbox.agentActionTimeline.actions.security_scan',
	context_retrieval: 'components.inbox.agentActionTimeline.actions.context_retrieval',
	classify: 'components.inbox.agentActionTimeline.actions.classify',
	draft: 'components.inbox.agentActionTimeline.actions.draft',
	route: 'components.inbox.agentActionTimeline.actions.route',
};

const STATUS_LABEL_KEYS: Record<string, string> = {
	pending: 'components.inbox.agentActionTimeline.statuses.pending',
	running: 'components.inbox.agentActionTimeline.statuses.running',
	completed: 'components.inbox.agentActionTimeline.statuses.completed',
	failed: 'components.inbox.agentActionTimeline.statuses.failed',
	abandoned: 'components.inbox.agentActionTimeline.statuses.abandoned',
	skipped: 'components.inbox.agentActionTimeline.statuses.skipped',
};

function actionLabel(actionType: string): string {
	const key = ACTION_LABEL_KEYS[actionType];
	return key ? t(key) : actionType;
}

function statusLabel(status: string): string {
	const key = STATUS_LABEL_KEYS[status];
	return key ? t(key) : status;
}
</script>

<template>
	<div class="mt-2">
		<button
			type="button"
			class="text-xs text-text-tertiary hover:text-text-secondary flex items-center gap-1"
			@click="open = !open"
		>
			<Icon :name="open ? 'lucide:chevron-down' : 'lucide:chevron-right'" class="w-3 h-3" />
			{{ t('components.inbox.agentActionTimeline.toggle') }}
		</button>
		<div v-if="open" class="mt-2 pl-3 border-l border-border-subtle space-y-1.5">
			<div v-if="!actions || actions.length === 0" class="text-xs text-text-tertiary">
				{{ t('components.inbox.agentActionTimeline.empty') }}
			</div>
			<div v-for="a in actions" :key="a._id" class="flex items-center gap-2 text-xs">
				<Icon
					:name="statusBadge(a.status).icon"
					:class="[
						'w-3.5 h-3.5 shrink-0',
						statusBadge(a.status).color,
						a.status === 'running' ? 'animate-spin motion-reduce:animate-none' : '',
					]"
				/>
				<span class="text-text-primary">{{ actionLabel(a.actionType) }}</span>
				<span class="text-text-tertiary">· {{ statusLabel(a.status) }}</span>
			</div>
		</div>
	</div>
</template>
