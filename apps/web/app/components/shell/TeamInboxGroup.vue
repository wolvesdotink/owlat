<script setup lang="ts">
import { api } from '@owlat/api';
import {
	CONVERSATION_STATUS_PRIORITY,
	mostUrgentConversationStatus,
	teamThreadStatus,
	type ConversationStatus,
} from '~/utils/conversationStatus';
import type { SidebarThreadSort } from '~/composables/useShellSidebarPrefs';

/**
 * The team inbox (the agent's shared inbound) as one more group in the
 * sidebar, ordered by what needs attention: drafts waiting for approval first.
 * Owners and admins only, like the team inbox itself.
 */
const props = defineProps<{ limit: number; sort: SidebarThreadSort; collapsed: boolean }>();
const emit = defineEmits<{ toggle: [] }>();
const { t } = useI18n();
const route = useRoute();

const { data } = useConvexQuery(api.inbox.queries.listThreads, () => ({
	filter: 'open' as const,
	sort: 'needs-attention' as const,
	limit: props.collapsed ? 1 : Math.max(props.limit, 1),
}));
const { data: stats } = useConvexQuery(api.inbox.queries.getInboundStats, () => ({}));

const rows = computed(() => {
	const threads = (data.value?.threads ?? []).map((thread) => ({
		id: thread._id as string,
		title: thread.subject,
		lastMessageAt: thread.lastMessageAt,
		unread: thread.unread,
		status: teamThreadStatus(thread),
	}));
	if (props.sort === 'recent') threads.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
	else {
		const rank = (s: ConversationStatus | null) =>
			s === null ? CONVERSATION_STATUS_PRIORITY.length : CONVERSATION_STATUS_PRIORITY.indexOf(s);
		threads.sort((a, b) => rank(a.status) - rank(b.status));
	}
	return threads.slice(0, props.limit);
});

/** The agent working right now outranks nothing, but it is worth a dot. */
const groupStatus = computed(() =>
	mostUrgentConversationStatus([
		(stats.value?.draftReady ?? 0) > 0 ? 'draft_ready' : null,
		(stats.value?.processing ?? 0) > 0 ? 'working' : null,
		...rows.value.map((r) => r.status),
	])
);
const activeThreadId = computed(
	() => /^\/dashboard\/inbox\/([^/?#]+)/.exec(route.path)?.[1] ?? null
);
</script>

<template>
	<div class="mt-0.5">
		<div class="group/team flex items-center gap-1 rounded-md pr-1 hover:bg-(--surface-2-hover)">
			<button
				type="button"
				class="flex size-6 shrink-0 items-center justify-center rounded text-text-tertiary hover:text-text-primary"
				:aria-expanded="!collapsed"
				:aria-label="
					collapsed
						? t('components.shell.inboxGroup.expand', { name: t('components.shell.teamInbox') })
						: t('components.shell.inboxGroup.collapse', { name: t('components.shell.teamInbox') })
				"
				@click="emit('toggle')"
			>
				<Icon
					name="lucide:chevron-down"
					class="size-3 transition-transform duration-(--motion-fast)"
					:class="collapsed ? '-rotate-90' : ''"
				/>
			</button>
			<NuxtLink to="/dashboard/inbox" class="flex min-w-0 flex-1 items-center gap-2 py-1">
				<span class="inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary">
					<Icon name="lucide:bot" class="size-3.5 text-text-tertiary" />
					{{ t('components.shell.teamInbox') }}
				</span>
				<ShellStatusPill v-if="groupStatus" :status="groupStatus" dot-only />
				<span
					v-if="(stats?.openThreads ?? 0) > 0"
					class="ml-auto text-2xs tabular-nums text-text-tertiary"
					>{{ stats?.openThreads }}</span
				>
			</NuxtLink>
		</div>
		<div v-if="!collapsed" class="mt-px space-y-px">
			<ShellThreadRow
				v-for="row in rows"
				:key="row.id"
				:to="`/dashboard/inbox/${row.id}`"
				:jump-key="`team:${row.id}`"
				:title="row.title || t('components.shell.noSubject')"
				:meta="formatCompactRelativeTime(row.lastMessageAt)"
				:status="row.status"
				:is-unread="row.unread"
				:is-active="activeThreadId === row.id"
				indented
			/>
			<NuxtLink
				v-if="(stats?.openThreads ?? 0) > rows.length && limit > 0"
				to="/dashboard/inbox"
				class="flex items-center gap-2 rounded-md py-1 pl-7 pr-2 text-2xs text-text-tertiary hover:bg-(--surface-2-hover) hover:text-text-primary"
			>
				{{ t('components.shell.inboxGroup.showMore') }}
			</NuxtLink>
		</div>
	</div>
</template>
