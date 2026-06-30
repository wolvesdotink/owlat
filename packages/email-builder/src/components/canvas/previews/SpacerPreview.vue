<script setup lang="ts">
import { computed } from 'vue';
import type { EditorBlock, EmailTheme, SpacerBlockContent } from '../../../types';

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
}>();

const content = computed(() => props.block.content as SpacerBlockContent);

const height = computed(() => content.value.height ?? 20);
</script>

<template>
	<div
		class="relative flex items-center justify-center"
		:style="{
			height: `${height}px`,
			marginTop: `${content.marginTop ?? 0}px`,
			marginRight: `${content.marginRight ?? 0}px`,
			marginBottom: `${content.marginBottom ?? 0}px`,
			marginLeft: `${content.marginLeft ?? 0}px`,
		}"
	>
		<div class="absolute inset-0 border border-dashed border-border-subtle rounded" />
		<span class="text-[10px] font-semibold text-text-tertiary bg-bg-elevated/80 px-1.5 py-0.5 rounded z-[1]">{{ height }}px</span>
	</div>
</template>
