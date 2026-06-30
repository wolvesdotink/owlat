<script setup lang="ts">
import { computed } from 'vue';
import type { EditorBlock, EmailTheme, ListBlockContent } from '../../../types';

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
}>();

const content = computed(() => props.block.content as ListBlockContent);

const textColor = computed(() => content.value.textColor || '#333333');
const bulletColor = computed(() => content.value.bulletColor || textColor.value);
const fontSize = computed(() => content.value.fontSize || 16);
const bulletSize = computed(() => content.value.bulletSize ?? fontSize.value);

const wrapperStyles = computed(() => ({
	paddingTop: `${content.value.paddingTop ?? 16}px`,
	paddingRight: `${content.value.paddingRight ?? 24}px`,
	paddingBottom: `${content.value.paddingBottom ?? 16}px`,
	paddingLeft: `${content.value.paddingLeft ?? 24}px`,
	marginTop: `${content.value.marginTop ?? 0}px`,
	marginRight: `${content.value.marginRight ?? 0}px`,
	marginBottom: `${content.value.marginBottom ?? 0}px`,
	marginLeft: `${content.value.marginLeft ?? 0}px`,
	fontFamily: props.theme.fontFamily || 'Arial, sans-serif',
}));

const listType = computed(() => content.value.listType || 'bullet');

function getBulletChar(index: number): string {
	switch (listType.value) {
		case 'numbered':
			return `${index + 1}.`;
		case 'check':
			return '\u2713';
		case 'icon':
			return '\u2022';
		default:
			return '\u2022';
	}
}
</script>

<template>
	<div :style="wrapperStyles">
		<div
			v-for="(item, idx) in content.items"
			:key="idx"
			class="flex"
			:style="{ paddingBottom: `${content.itemSpacing ?? 6}px` }"
		>
			<!-- Bullet/number cell -->
			<div
				v-if="listType !== 'icon' || !content.iconUrl"
				class="shrink-0 text-center"
				:style="{
					width: '24px',
					color: bulletColor,
					fontSize: `${bulletSize}px`,
					lineHeight: `${fontSize * 1.5}px`,
					verticalAlign: 'top',
				}"
			>{{ getBulletChar(idx) }}</div>
			<!-- Icon cell -->
			<div
				v-else
				class="shrink-0 flex items-start justify-center"
				:style="{ width: '24px', paddingTop: '2px' }"
			>
				<img
					:src="content.iconUrl"
					:style="{ width: `${bulletSize}px`, height: `${bulletSize}px` }"
					alt=""
				/>
			</div>
			<!-- Text cell -->
			<div
				:style="{
					color: textColor,
					fontSize: `${fontSize}px`,
					lineHeight: `${fontSize * 1.5}px`,
				}"
			>{{ item }}</div>
		</div>
	</div>
</template>
