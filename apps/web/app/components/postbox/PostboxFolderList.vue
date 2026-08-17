<script setup lang="ts">
type PostboxFolderRow = {
	_id: string;
	name: string;
	role?: string | null;
	unseenCount: number;
	totalCount: number;
};

defineProps<{
	folders: PostboxFolderRow[];
	unreadCounts: Record<string, number>;
	activeFolder: string;
	// Icon-strip mode: glyph + unread badge + tooltip only, no label text. The
	// rows stay NuxtLinks so keyboard nav (Tab/Enter) works in both states.
	collapsed?: boolean;
}>();

const { t } = useI18n();

const ICON_BY_ROLE: Record<string, string> = {
	inbox: 'lucide:inbox',
	sent: 'lucide:send',
	drafts: 'lucide:file-edit',
	trash: 'lucide:trash',
	spam: 'lucide:shield-alert',
	archive: 'lucide:archive',
};

// System folders arrive with a role, not a translated name; a custom/unknown
// role keeps rendering the server-provided value verbatim.
const ROLE_LABEL_KEYS: Record<string, string> = {
	inbox: 'components.postbox.postboxFolderList.roles.inbox',
	sent: 'components.postbox.postboxFolderList.roles.sent',
	drafts: 'components.postbox.postboxFolderList.roles.drafts',
	trash: 'components.postbox.postboxFolderList.roles.trash',
	spam: 'components.postbox.postboxFolderList.roles.spam',
	archive: 'components.postbox.postboxFolderList.roles.archive',
};

function folderLabel(folder: PostboxFolderRow): string {
	const key = folder.role ? ROLE_LABEL_KEYS[folder.role] : undefined;
	return key ? t(key) : (folder.role ?? folder.name);
}

function folderAriaLabel(folder: PostboxFolderRow): string {
	const name = folderLabel(folder);
	return folder.unseenCount > 0
		? t('components.postbox.postboxFolderList.unreadAriaLabel', {
				name,
				count: folder.unseenCount,
			})
		: name;
}
</script>

<template>
	<nav class="flex flex-col gap-0.5" :class="{ 'items-center': collapsed }">
		<NuxtLink
			v-for="folder in folders"
			:key="folder._id"
			:to="`/dashboard/postbox/${folder.role}`"
			class="rounded text-sm hover:bg-bg-surface"
			:class="[
				collapsed
					? 'relative flex items-center justify-center w-9 h-9'
					: 'flex items-center gap-2 px-2.5 py-1.5',
				{ 'bg-bg-surface text-brand': activeFolder === folder.role },
			]"
			:title="collapsed ? folderLabel(folder) : undefined"
			:aria-label="collapsed ? folderAriaLabel(folder) : undefined"
		>
			<Icon :name="ICON_BY_ROLE[folder.role ?? ''] ?? 'lucide:folder'" class="w-4 h-4" />
			<template v-if="!collapsed">
				<span class="flex-1 capitalize">{{ folderLabel(folder) }}</span>
				<span
					v-if="folder.unseenCount > 0"
					class="text-xs font-medium text-text-secondary"
				>{{ folder.unseenCount }}</span>
			</template>
			<!-- Collapsed: unread count as a corner badge so the number stays
			     visible without the label. -->
			<span
				v-else-if="folder.unseenCount > 0"
				class="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-brand text-text-inverse text-[10px] leading-4 font-medium text-center"
			>{{ folder.unseenCount > 99 ? '99+' : folder.unseenCount }}</span>
		</NuxtLink>
	</nav>
</template>
