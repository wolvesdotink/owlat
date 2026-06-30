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
	<nav class="flex flex-col gap-0.5">
		<NuxtLink
			v-for="folder in folders"
			:key="folder._id"
			:to="`/dashboard/postbox/${folder.role}`"
			class="flex items-center gap-2 px-2.5 py-1.5 rounded text-sm hover:bg-bg-surface"
			:class="{ 'bg-bg-surface text-brand': activeFolder === folder.role }"
		>
			<Icon :name="ICON_BY_ROLE[folder.role ?? ''] ?? 'lucide:folder'" class="w-4 h-4" />
			<span class="flex-1 capitalize">{{ folder.role ?? folder.name }}</span>
			<span
				v-if="folder.unseenCount > 0"
				class="text-xs font-medium text-text-secondary"
			>{{ folder.unseenCount }}</span>
		</NuxtLink>
	</nav>
</template>
