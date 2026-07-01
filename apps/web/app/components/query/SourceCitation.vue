<script setup lang="ts">
import { entryTypeIcon } from '~/utils/knowledgeEntryTypes';

const props = defineProps<{
	kind: 'knowledge' | 'file';
	title: string;
	/** Present for knowledge sources — drives the entry-type icon. */
	entryType?: string;
	/** Present for file sources — shown in the hover tooltip. */
	filename?: string;
}>();

const icon = computed(() =>
	props.kind === 'file' ? 'lucide:file-text' : entryTypeIcon(props.entryType ?? ''),
);

const tooltip = computed(() =>
	props.kind === 'file'
		? `file: ${props.filename ?? props.title}`
		: `${props.entryType ?? 'knowledge'}: ${props.title}`,
);
</script>

<template>
	<button
		class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-bg-surface border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-surface-hover transition-colors"
		:title="tooltip"
	>
		<Icon :name="icon" class="w-3 h-3 text-text-tertiary" />
		<span class="truncate max-w-[200px]">{{ title }}</span>
	</button>
</template>
