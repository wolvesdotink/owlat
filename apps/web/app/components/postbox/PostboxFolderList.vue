<script setup lang="ts">
defineProps<{
	folders: Array<{
		_id: string;
		name: string;
		role?: string | null;
		unseenCount: number;
		totalCount: number;
	}>;
	unreadCounts: Record<string, number>;
	activeFolder: string;
	// Icon-strip mode: glyph + unread badge + tooltip only, no label text. The
	// rows stay NuxtLinks so keyboard nav (Tab/Enter) works in both states.
	collapsed?: boolean;
}>();

const ICON_BY_ROLE: Record<string, string> = {
	inbox: 'lucide:inbox',
	sent: 'lucide:send',
	drafts: 'lucide:file-edit',
	trash: 'lucide:trash',
	spam: 'lucide:shield-alert',
	archive: 'lucide:archive',
};
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
			:title="collapsed ? (folder.role ?? folder.name) : undefined"
			:aria-label="collapsed ? `${folder.role ?? folder.name}${folder.unseenCount > 0 ? `, ${folder.unseenCount} unread` : ''}` : undefined"
		>
			<Icon :name="ICON_BY_ROLE[folder.role ?? ''] ?? 'lucide:folder'" class="w-4 h-4" />
			<template v-if="!collapsed">
				<span class="flex-1 capitalize">{{ folder.role ?? folder.name }}</span>
				<span
					v-if="folder.unseenCount > 0"
					class="text-xs font-medium text-text-secondary"
				>{{ folder.unseenCount }}</span>
			</template>
			<!-- Collapsed: unread count as a corner badge so the number stays
			     visible without the label. -->
			<span
				v-else-if="folder.unseenCount > 0"
				class="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-brand text-white text-[10px] leading-4 font-medium text-center"
			>{{ folder.unseenCount > 99 ? '99+' : folder.unseenCount }}</span>
		</NuxtLink>
	</nav>
</template>
