<script setup lang="ts">
import { computed } from 'vue';
import type { EditorBlock, EmailTheme, MenuBlockContent } from '../../../types';
import { blockBoxStyle } from '../../../utils/blocks';

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
}>();

const content = computed(() => props.block.content as MenuBlockContent);

const wrapperStyles = computed(() => ({
	textAlign: content.value.align || ('center' as const),
	...blockBoxStyle(props.block),
}));

const itemSpacing = computed(() => content.value.itemSpacing ?? 16);

const linkStyles = computed(() => ({
	fontSize: `${content.value.fontSize || 14}px`,
	color: content.value.textColor || '#333333',
	textDecoration: 'none',
	fontFamily: content.value.fontFamily || props.theme.fontFamily || 'Arial, sans-serif',
	fontWeight: content.value.fontWeight ? String(content.value.fontWeight) : undefined,
	textTransform: (content.value.textTransform && content.value.textTransform !== 'none')
		? content.value.textTransform
		: undefined,
}));

const separatorColor = computed(() => content.value.separatorColor || '#999999');
const separator = computed(() => content.value.separator ?? '');
</script>

<template>
	<div :style="wrapperStyles">
		<template v-for="(item, idx) in content.items" :key="idx">
			<span :style="linkStyles" class="cursor-default">{{ item.label }}</span>
			<span
				v-if="idx < content.items.length - 1 && separator"
				:style="{
					color: separatorColor,
					paddingLeft: `${itemSpacing / 2}px`,
					paddingRight: `${itemSpacing / 2}px`,
				}"
			>{{ separator }}</span>
			<span
				v-else-if="idx < content.items.length - 1 && !separator"
				:style="{ display: 'inline-block', width: `${itemSpacing}px` }"
			/>
		</template>
	</div>
</template>
