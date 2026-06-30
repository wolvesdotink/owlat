<script setup lang="ts">
import { computed } from 'vue';
import type { EditorBlock, EmailTheme, DividerBlockContent } from '../../../types';

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
}>();

const content = computed(() => props.block.content as DividerBlockContent);

const wrapperStyles = computed(() => ({
	paddingTop: `${content.value.paddingTop ?? 16}px`,
	paddingRight: `${content.value.paddingRight ?? 24}px`,
	paddingBottom: `${content.value.paddingBottom ?? 16}px`,
	paddingLeft: `${content.value.paddingLeft ?? 24}px`,
	marginTop: `${content.value.marginTop ?? 0}px`,
	marginRight: `${content.value.marginRight ?? 0}px`,
	marginBottom: `${content.value.marginBottom ?? 0}px`,
	marginLeft: `${content.value.marginLeft ?? 0}px`,
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
