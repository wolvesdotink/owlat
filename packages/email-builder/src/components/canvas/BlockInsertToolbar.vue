<script setup lang="ts">
import UiTooltip from '@owlat/ui/components/ui/Tooltip.vue';
import { ref } from 'vue';
import type { Component } from 'vue';
import type { BlockType } from '../../types';
import {
	Type,
	Image as ImageIcon,
	MousePointerClick,
	Minus,
	Columns,
	Share2,
	Square,
	Plus,
} from '@lucide/vue';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

const { t, label } = useBuilderI18n();

const emit = defineEmits<{
	(e: 'add-block', type: BlockType): void;
}>();

const showMore = ref(false);

const quickBlocks: { type: BlockType; icon: Component; label: string }[] = [
	{ type: 'text', icon: Type, label: 'Text' },
	{ type: 'image', icon: ImageIcon, label: 'Image' },
	{ type: 'button', icon: MousePointerClick, label: 'Button' },
	{ type: 'divider', icon: Minus, label: 'Divider' },
	{ type: 'columns', icon: Columns, label: 'Columns' },
	{ type: 'social', icon: Share2, label: 'Social' },
	{ type: 'container', icon: Square, label: 'Container' },
];

function handleAdd(type: BlockType) {
	emit('add-block', type);
	showMore.value = false;
}
</script>

<template>
	<div
		role="toolbar"
		:aria-label="t('builder.canvas.quickInsert')"
		class="flex items-center justify-center gap-1 py-2 mb-2"
	>
		<UiTooltip v-for="block in quickBlocks" :key="block.type" :text="label(block.label)">
			<button
				class="flex items-center justify-center w-8 h-8 rounded-lg border border-transparent bg-transparent text-text-secondary cursor-pointer transition-colors duration-(--motion-moderate) hover:bg-bg-surface-hover hover:text-text-primary hover:border-border-subtle"
				:aria-label="label(block.label)"
				type="button"
				@click="handleAdd(block.type)"
			>
				<component :is="block.icon" :size="16" />
			</button>
		</UiTooltip>
		<UiTooltip :text="t('builder.canvas.moreBlocksTitle')">
			<button
				class="flex items-center justify-center w-8 h-8 rounded-lg border border-dashed border-border-default bg-transparent text-text-tertiary cursor-pointer transition-colors duration-(--motion-moderate) hover:bg-bg-surface-hover hover:text-text-secondary hover:border-border-strong"
				:aria-label="t('builder.canvas.moreBlocksTitle')"
				:aria-expanded="showMore"
				type="button"
				@click="showMore = !showMore"
			>
				<Plus :size="16" />
			</button>
		</UiTooltip>
	</div>
</template>
