<script setup lang="ts">
import type { NavigationItem } from '~/lib/dashboardNavigationCore';

/**
 * The Conversations workspace's sidebar (idea borrowed from T3 Code: the
 * sidebar lists the work, not pages). Three pinned destinations — Today, the
 * Answer queue, All inboxes — then every inbox the viewer reads with its
 * latest conversations and one status each, the team inbox for owners/admins,
 * and chat. Collapsed (the icon rail) it keeps the pinned icons and one swatch
 * per inbox.
 */
const props = defineProps<{
	collapsed: boolean;
	/** Plugin-contributed destinations for this workspace. */
	extraItems: readonly NavigationItem[];
}>();

const { t } = useI18n();
const route = useRoute();
const { isEnabled } = useFeatureFlag();
const { isAdmin } = usePermissions();
const { inboxes, hasPersonalMail } = useInboxes();
const { count: answerCount } = useAnswerQueue();
const { perInbox, sort, isCollapsed, toggleGroup } = useShellSidebarPrefs();

const showTeamInbox = computed(() => isAdmin.value && isEnabled('inbox'));
const showChat = computed(() => isAdmin.value && isEnabled('chat'));

const pinned = computed(() => [
	{
		to: '/dashboard',
		icon: 'lucide:sun',
		label: t('components.shell.nav.today'),
		exact: true,
		count: 0,
	},
	{
		to: '/dashboard/answer',
		icon: 'lucide:reply-all',
		label: t('components.shell.nav.answer'),
		exact: false,
		count: answerCount.value,
	},
	...(hasPersonalMail.value || showTeamInbox.value
		? [
				{
					to: '/dashboard/inboxes',
					icon: 'lucide:inbox',
					label: t('components.shell.nav.allInboxes'),
					exact: false,
					count: 0,
				},
			]
		: []),
]);

function isActive(to: string, exact: boolean): boolean {
	return exact ? route.path === to : route.path === to || route.path.startsWith(`${to}/`);
}
</script>

<template>
	<div class="flex flex-col gap-px">
		<NuxtLink
			v-for="item in pinned"
			:key="item.to"
			:to="item.to"
			:aria-current="isActive(item.to, item.exact) ? 'page' : undefined"
			:title="props.collapsed ? item.label : undefined"
			class="relative flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
			:class="[
				isActive(item.to, item.exact)
					? 'bg-(--surface-2-selected) text-text-primary'
					: 'text-text-secondary hover:bg-(--surface-2-hover) hover:text-text-primary',
				props.collapsed ? 'justify-center' : '',
			]"
		>
			<Icon
				:name="item.icon"
				class="size-4.5 shrink-0"
				:class="isActive(item.to, item.exact) ? 'text-brand' : 'text-text-tertiary'"
			/>
			<span v-if="!props.collapsed" class="flex-1 truncate">{{ item.label }}</span>
			<span
				v-if="item.count > 0 && !props.collapsed"
				class="rounded-full bg-brand px-1.5 text-2xs font-semibold leading-4 text-text-inverse"
				>{{ item.count > 99 ? '99+' : item.count }}</span
			>
			<span
				v-else-if="item.count > 0"
				class="absolute right-1.5 top-1 size-2 rounded-full bg-brand ring-2 ring-bg-elevated"
				:aria-label="t('components.shell.nav.answerCount', { count: item.count }, item.count)"
			/>
		</NuxtLink>

		<template v-if="props.collapsed">
			<div class="my-2 border-t border-border-subtle" aria-hidden="true" />
			<NuxtLink
				v-for="inbox in inboxes"
				:key="inbox.mailboxId"
				:to="`/dashboard/postbox/inbox?mailbox=${inbox.mailboxId}`"
				:title="inbox.name"
				class="flex justify-center rounded-lg py-2 hover:bg-(--surface-2-hover)"
			>
				<InboxChip :name="inbox.name.charAt(0)" :slot="inbox.slot" variant="plain" size="md" />
			</NuxtLink>
			<NuxtLink
				v-if="showChat"
				to="/dashboard/chat"
				:title="t('components.shell.chat.title')"
				class="flex justify-center rounded-lg py-2 text-text-tertiary hover:bg-(--surface-2-hover) hover:text-text-primary"
			>
				<Icon name="lucide:message-circle" class="size-4.5" />
			</NuxtLink>
		</template>

		<template v-else>
			<div
				v-if="inboxes.length > 0 || showTeamInbox"
				class="mt-3 flex items-center justify-between pl-2 pr-1"
			>
				<span class="text-2xs font-medium uppercase tracking-wider text-text-tertiary">{{
					t('components.shell.nav.inboxes')
				}}</span>
				<ShellSidebarOptions />
			</div>
			<ShellInboxGroup
				v-for="inbox in inboxes"
				:key="inbox.mailboxId"
				:inbox="inbox"
				:limit="perInbox"
				:sort="sort"
				:collapsed="isCollapsed(`inbox:${inbox.mailboxId}`)"
				@toggle="toggleGroup(`inbox:${inbox.mailboxId}`)"
			/>
			<ShellTeamInboxGroup
				v-if="showTeamInbox"
				:limit="perInbox"
				:sort="sort"
				:collapsed="isCollapsed('team-inbox')"
				@toggle="toggleGroup('team-inbox')"
			/>
			<ShellChatGroup
				v-if="showChat"
				:collapsed="isCollapsed('chat')"
				@toggle="toggleGroup('chat')"
			/>
			<template v-if="extraItems.length > 0">
				<div class="mt-3 px-2 text-2xs font-medium uppercase tracking-wider text-text-tertiary">
					{{ t('components.shell.nav.more') }}
				</div>
				<NuxtLink
					v-for="item in extraItems"
					:key="item.href"
					:to="item.href"
					class="flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm text-text-secondary hover:bg-(--surface-2-hover) hover:text-text-primary"
				>
					<Icon :name="item.icon" class="size-4 text-text-tertiary" />
					<span class="truncate">{{ t(item.name) }}</span>
				</NuxtLink>
			</template>
		</template>
	</div>
</template>
