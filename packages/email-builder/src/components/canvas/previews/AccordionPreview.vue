<script setup lang="ts">
import { computed } from 'vue';
import type { EditorBlock, EmailTheme, AccordionBlockContent } from '../../../types';
import { ChevronDown } from '@lucide/vue';

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
}>();

const content = computed(() => props.block.content as AccordionBlockContent);

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
</script>

<template>
	<div :style="wrapperStyles">
		<div class="flex flex-col" :style="{ borderRadius: content.borderRadius ? `${content.borderRadius}px` : undefined, overflow: content.borderRadius ? 'hidden' : undefined }">
			<div
				v-for="(section, idx) in content.sections"
				:key="section.id"
				class="border"
				:style="{
					borderColor: content.sectionBorderColor || '#e0e0e0',
					borderTopWidth: idx === 0 ? '1px' : '0',
				}"
			>
				<div
					class="flex items-center justify-between py-3 px-4 cursor-default"
					:style="{
						backgroundColor: content.headerBackgroundColor || '#f5f5f5',
						color: content.headerTextColor || '#333333',
						fontSize: `${content.headerFontSize || 16}px`,
						fontFamily: theme.fontFamily || 'Arial, sans-serif',
						fontWeight: '600',
					}"
				>
					<span>{{ section.title || 'Untitled Section' }}</span>
					<ChevronDown :size="16" :style="{ color: content.iconColor || '#666666' }" />
				</div>
				<div
					v-if="idx === (content.initialExpanded ?? 0)"
					class="py-3 px-4 text-sm"
					:style="{
						backgroundColor: content.contentBackgroundColor || '#ffffff',
						color: theme.bodyTextColor || '#333333',
					}"
				>
					<span v-if="section.items.length === 0" class="text-text-tertiary">Content goes here...</span>
				</div>
			</div>
		</div>
	</div>
</template>
