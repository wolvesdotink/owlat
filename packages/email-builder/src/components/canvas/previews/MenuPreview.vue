<script setup lang="ts">
import { computed } from 'vue';
import type { EditorBlock, EmailTheme, MenuBlockContent } from '../../../types';

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
}>();

const content = computed(() => props.block.content as MenuBlockContent);

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
