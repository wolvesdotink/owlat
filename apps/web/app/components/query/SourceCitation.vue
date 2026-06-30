<script setup lang="ts">
import { entryTypeIcon } from '~/utils/knowledgeEntryTypes';

defineProps<{
	id: string;
	title: string;
	entryType: string;
}>();

const getIcon = (type: string) => entryTypeIcon(type);
</script>

<template>
	<button
		class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-bg-surface border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-surface-hover transition-colors"
		:title="`${entryType}: ${title}`"
	>
		<Icon :name="getIcon(entryType)" class="w-3 h-3 text-text-tertiary" />
		<span class="truncate max-w-[200px]">{{ title }}</span>
	</button>
</template>
