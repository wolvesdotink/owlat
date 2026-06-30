<script setup lang="ts">
import { computed } from 'vue';
import type { EditorBlock, EmailTheme, ImageBlockContent } from '../../../types';
import { ImageIcon } from '@lucide/vue';

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
}>();

const content = computed(() => props.block.content as ImageBlockContent);

const wrapperStyles = computed(() => ({
	textAlign: content.value.align || ('center' as const),
	paddingTop: `${content.value.paddingTop ?? 16}px`,
	paddingRight: `${content.value.paddingRight ?? 24}px`,
	paddingBottom: `${content.value.paddingBottom ?? 16}px`,
	paddingLeft: `${content.value.paddingLeft ?? 24}px`,
	marginTop: `${content.value.marginTop ?? 0}px`,
	marginRight: `${content.value.marginRight ?? 0}px`,
	marginBottom: `${content.value.marginBottom ?? 0}px`,
	marginLeft: `${content.value.marginLeft ?? 0}px`,
}));

const imgStyles = computed(() => ({
	width: content.value.width ? `${content.value.width}%` : '100%',
	maxWidth: '100%',
	height: content.value.height ? `${content.value.height}px` : 'auto',
	display: 'inline-block',
	borderRadius: content.value.borderRadius ? `${content.value.borderRadius}px` : undefined,
}));
</script>

<template>
	<div :style="wrapperStyles">
		<img
			v-if="content.src"
			:src="content.src"
			:alt="content.alt || ''"
			:style="imgStyles"
		/>
		<div
			v-else
			class="inline-flex flex-col items-center justify-center gap-2 bg-bg-surface border-2 border-dashed border-border-subtle rounded-lg text-text-tertiary"
			:style="{ width: content.width ? `${content.width}%` : '100%', height: '120px' }"
		>
			<ImageIcon :size="24" />
			<span class="text-xs">No image selected</span>
		</div>
	</div>
</template>
