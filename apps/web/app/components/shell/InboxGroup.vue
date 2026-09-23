<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { InboxIdentity } from '~/utils/inboxIdentity';
import { CONVERSATION_STATUS_PRIORITY, type ConversationStatus } from '~/utils/conversationStatus';
import type { SidebarThreadSort } from '~/composables/useShellSidebarPrefs';

/**
 * One inbox in the Conversations sidebar: a header (chip, most urgent status,
 * "+" to write from this inbox) and its latest conversations, each with one
 * status. "Show more" carries the most urgent status that did not fit, so
 * nothing urgent hides behind the fold. Collapsing keeps the header's dot.
 */
const props = defineProps<{
	inbox: InboxIdentity<Id<'mailboxes'>>;
	limit: number;
	sort: SidebarThreadSort;
	collapsed: boolean;
}>();
const emit = defineEmits<{ toggle: [] }>();

const { t } = useI18n();
const route = useRoute();

const { data } = useConvexQuery(api.today.mailbox.sidebarThreads, () => ({
	mailboxId: props.inbox.mailboxId,
	limit: props.collapsed ? 0 : props.limit,
}));

const rows = computed(() => {
	const threads = [...(data.value?.threads ?? [])];
	if (props.sort === 'priority') {
		const rank = (s: ConversationStatus | null) =>
			s === null ? CONVERSATION_STATUS_PRIORITY.length : CONVERSATION_STATUS_PRIORITY.indexOf(s);
		threads.sort((a, b) => rank(a.status) - rank(b.status) || b.lastMessageAt - a.lastMessageAt);
	}
	return threads;
});

const inboxHref = computed(() => `/dashboard/postbox/inbox?mailbox=${props.inbox.mailboxId}`);
const composeHref = computed(() => `/compose?mailbox=${props.inbox.mailboxId}`);

const activeMessageId = computed(() => {
	const match = /^\/dashboard\/postbox\/[^/]+\/([^/?#]+)/.exec(route.path);
	return match?.[1] ?? null;
});

const moreCount = computed(() =>
	Math.max(0, props.inbox.unread - rows.value.filter((r) => r.isUnread).length)
);
</script>

<template>
	<div class="mt-0.5">
		<div class="group/inbox flex items-center gap-1 rounded-md pr-1 hover:bg-(--surface-2-hover)">
			<button
				type="button"
				class="flex size-6 shrink-0 items-center justify-center rounded text-text-tertiary hover:text-text-primary"
				:aria-expanded="!collapsed"
				:aria-label="
					collapsed
						? t('components.shell.inboxGroup.expand', { name: inbox.name })
						: t('components.shell.inboxGroup.collapse', { name: inbox.name })
				"
				@click="emit('toggle')"
			>
				<Icon
					name="lucide:chevron-down"
					class="size-3 transition-transform duration-(--motion-fast)"
					:class="collapsed ? '-rotate-90' : ''"
				/>
			</button>
			<NuxtLink
				:to="inboxHref"
				class="flex min-w-0 flex-1 items-center gap-2 py-1"
				:title="inbox.address"
			>
				<InboxChip :name="inbox.name" :slot="inbox.slot" variant="plain" size="md" />
				<ShellStatusPill v-if="data?.groupStatus" :status="data.groupStatus" dot-only />
				<span
					v-if="inbox.unread > 0"
					class="ml-auto text-2xs tabular-nums text-text-tertiary"
					:aria-label="t('components.shell.inboxGroup.unread', { count: inbox.unread })"
					>{{ inbox.unread > 99 ? '99+' : inbox.unread }}</span
				>
			</NuxtLink>
			<NuxtLink
				:to="composeHref"
				class="flex size-6 shrink-0 items-center justify-center rounded text-text-tertiary opacity-0 transition-opacity hover:text-text-primary focus-visible:opacity-100 group-hover/inbox:opacity-100 max-lg:opacity-100"
				:aria-label="t('components.shell.inboxGroup.compose', { name: inbox.name })"
				:title="t('components.shell.inboxGroup.compose', { name: inbox.name })"
			>
				<Icon name="lucide:plus" class="size-3.5" />
			</NuxtLink>
		</div>

		<div v-if="!collapsed" class="mt-px space-y-px">
			<ShellThreadRow
				v-for="row in rows"
				:key="row.threadId"
				:to="
					row.latestMessageId
						? `/dashboard/postbox/inbox/${row.latestMessageId}?mailbox=${inbox.mailboxId}`
						: inboxHref
				"
				:jump-key="`mail:${row.threadId}`"
				:title="row.subject || t('components.shell.noSubject')"
				:meta="formatCompactRelativeTime(row.lastMessageAt)"
				:status="row.status"
				:is-unread="row.isUnread"
				:is-active="row.latestMessageId !== null && activeMessageId === row.latestMessageId"
				indented
			/>
			<NuxtLink
				v-if="limit > 0 && (moreCount > 0 || data?.hiddenStatus)"
				:to="inboxHref"
				class="flex items-center gap-2 rounded-md py-1 pl-7 pr-2 text-2xs text-text-tertiary hover:bg-(--surface-2-hover) hover:text-text-primary"
			>
				<span>{{
					moreCount > 0
						? t('components.shell.inboxGroup.moreUnread', { count: moreCount }, moreCount)
						: t('components.shell.inboxGroup.showMore')
				}}</span>
				<ShellStatusPill v-if="data?.hiddenStatus" :status="data.hiddenStatus" />
			</NuxtLink>
		</div>
	</div>
</template>
