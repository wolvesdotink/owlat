<script setup lang="ts">
import { computed } from 'vue';
import type { EditorBlock, EmailTheme, DividerBlockContent } from '../../../types';
import { blockBoxStyle } from '../../../utils/blocks';

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
}>();

const content = computed(() => props.block.content as DividerBlockContent);

const wrapperStyles = computed(() => ({
	...blockBoxStyle(props.block),
}));

const lineStyles = computed(() => ({
	width: `${content.value.width ?? 100}%`,
	margin: '0 auto',
	borderTop: `${content.value.thickness ?? 1}px ${content.value.style || 'solid'} ${content.value.color || '#282D3A'}`,
}));
</script>

<template>
	<div :style="wrapperStyles">
		<div :style="lineStyles" />
	</div>
</template>
