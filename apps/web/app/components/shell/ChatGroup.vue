<script setup lang="ts">
/**
 * Chat in the Conversations sidebar: the channels and direct messages with
 * something new, most recent first, plus a link to all of chat. A mention
 * reads as "Mentioned you" — the chat version of "Needs you".
 */
const props = defineProps<{ collapsed: boolean }>();
const emit = defineEmits<{ toggle: [] }>();
const { t } = useI18n();
const route = useRoute();

const { channels, dms } = useChatRooms();

const MAX_ROWS = 4;
const rows = computed(() => {
	const all = [
		...channels.value.map((c) => ({
			id: c._id as string,
			title: `# ${c.displayName}`,
			lastMessageAt: c.lastMessageAt,
			unread: c.unread,
		})),
		...dms.value.map((d) => ({
			id: d._id as string,
			title: d.displayName,
			lastMessageAt: d.lastMessageAt,
			unread: d.unread,
		})),
	];
	const withNews = all.filter((r) => r.unread.unreadCount > 0 || r.unread.hasMention);
	const pick = (withNews.length > 0 ? withNews : all).sort(
		(a, b) => b.lastMessageAt - a.lastMessageAt
	);
	return pick.slice(0, MAX_ROWS);
});
const unreadTotal = computed(() =>
	[...channels.value, ...dms.value].reduce((sum, r) => sum + r.unread.unreadCount, 0)
);
const activeRoomId = computed(() => /^\/dashboard\/chat\/([^/?#]+)/.exec(route.path)?.[1] ?? null);
</script>

<template>
	<div>
		<div class="group/chat mt-3 flex items-center gap-1 pr-1">
			<button
				type="button"
				class="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-2xs font-medium uppercase tracking-wider text-text-tertiary hover:text-text-primary"
				:aria-expanded="!props.collapsed"
				@click="emit('toggle')"
			>
				<Icon
					name="lucide:chevron-down"
					class="size-3 transition-transform duration-(--motion-fast)"
					:class="props.collapsed ? '-rotate-90' : ''"
				/>
				{{ t('components.shell.chat.title') }}
			</button>
			<NuxtLink
				to="/dashboard/chat"
				class="rounded px-1.5 text-2xs text-text-tertiary hover:text-text-primary"
				>{{
					unreadTotal > 0
						? t('components.shell.chat.allWithUnread', { count: unreadTotal })
						: t('components.shell.chat.all')
				}}</NuxtLink
			>
		</div>
		<div v-if="!props.collapsed" class="mt-px space-y-px">
			<ShellThreadRow
				v-for="row in rows"
				:key="row.id"
				:to="`/dashboard/chat/${row.id}`"
				:jump-key="`chat:${row.id}`"
				:title="row.title"
				:meta="formatCompactRelativeTime(row.lastMessageAt)"
				:status="row.unread.hasMention ? 'mentioned' : null"
				:is-unread="row.unread.unreadCount > 0"
				:is-active="activeRoomId === row.id"
			/>
			<p v-if="rows.length === 0" class="px-3 py-1 text-2xs text-text-tertiary">
				{{ t('components.shell.chat.empty') }}
			</p>
		</div>
	</div>
</template>
