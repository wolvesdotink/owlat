<script setup lang="ts">
import { useComposerDrafts } from '~/composables/useComposerDrafts';
/**
 * Chat in the Conversations sidebar: the channels and direct messages with
 * something new, most recent first, under a header that opens all of chat. A mention
 * reads as "Mentioned you" — the chat version of "Needs you".
 */
const props = defineProps<{ collapsed: boolean }>();
const emit = defineEmits<{ toggle: [] }>();
const { t } = useI18n();
const route = useRoute();
const CHAT_HREF = '/dashboard/chat';

const { channels, dms } = useChatRooms();
const drafts = useComposerDrafts();

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
		<ShellGroupHeader
			class="mt-3"
			:name="t('components.shell.chat.title')"
			:to="CHAT_HREF"
			:collapsed="props.collapsed"
			name-class="text-2xs font-medium uppercase tracking-wider text-text-tertiary"
			@toggle="emit('toggle')"
		>
			<span
				v-if="unreadTotal > 0"
				class="ml-auto normal-case tracking-normal tabular-nums"
				:aria-label="t('components.shell.inboxGroup.unread', { count: unreadTotal })"
				>{{ unreadTotal > 99 ? '99+' : unreadTotal }}</span
			>
		</ShellGroupHeader>
		<div v-if="!props.collapsed" class="mt-px space-y-px">
			<ShellThreadRow
				v-for="row in rows"
				:key="row.id"
				:to="`${CHAT_HREF}/${row.id}`"
				:jump-key="`chat:${row.id}`"
				:title="row.title"
				:meta="formatCompactRelativeTime(row.lastMessageAt)"
				:status="row.unread.hasMention ? 'mentioned' : null"
				:is-unread="row.unread.unreadCount > 0"
				:is-active="activeRoomId === row.id"
				:has-draft="drafts.has('chat', row.id)"
			/>
			<p v-if="rows.length === 0" class="px-3 py-1 text-2xs text-text-tertiary">
				{{ t('components.shell.chat.empty') }}
			</p>
		</div>
	</div>
</template>
