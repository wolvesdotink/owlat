<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, onUnmounted, watch } from 'vue';
import type { Component } from 'vue';
import type { BlockType } from '../../types';
import BlockPickerPopover from './BlockPickerPopover.vue';
import {
	Type,
	Image as ImageIcon,
	MousePointerClick,
	Minus,
	Columns,
	Share2,
	Square,
	MoreHorizontal,
} from '@lucide/vue';

const props = defineProps<{
	canvasElement: HTMLElement | null;
	visible?: boolean;
	/** Restrict the insertable palette to this allowlist (EmailBuilderConfig.blockTypes). Undefined = all. */
	blockTypes?: BlockType[];
}>();

const emit = defineEmits<{
	(e: 'add-block', type: BlockType): void;
}>();

const sidebarRef = ref<HTMLElement | null>(null);
const moreButtonRef = shallowRef<HTMLElement | null>(null);
const showPicker = ref(false);
const posTop = ref(0);
const posLeft = ref(0);
const isVisible = ref(false);

const allQuickBlocks: { type: BlockType; icon: Component; label: string }[] = [
	{ type: 'text', icon: Type, label: 'Text' },
	{ type: 'image', icon: ImageIcon, label: 'Image' },
	{ type: 'button', icon: MousePointerClick, label: 'Button' },
	{ type: 'divider', icon: Minus, label: 'Divider' },
	{ type: 'columns', icon: Columns, label: 'Columns' },
	{ type: 'social', icon: Share2, label: 'Social' },
	{ type: 'container', icon: Square, label: 'Container' },
];

// Honour the host config allowlist; undefined/empty means "all".
const quickBlocks = computed(() => {
	const allowed = props.blockTypes;
	if (!allowed || allowed.length === 0) return allQuickBlocks;
	const allowSet = new Set(allowed);
	return allQuickBlocks.filter((b) => allowSet.has(b.type));
});

function updatePosition() {
	if (!props.canvasElement) {
		isVisible.value = false;
		return;
	}

	const rect = props.canvasElement.getBoundingClientRect();
	const sidebarWidth = 40;
	const gap = 12;
	const newLeft = rect.left - sidebarWidth - gap;

	// Hide when viewport too narrow
	if (newLeft < 16) {
		isVisible.value = false;
		return;
	}

	isVisible.value = true;
	posLeft.value = newLeft;

	// Align to top of canvas, sticky (stays at canvas top even when scrolled)
	const topOffset = 16;
	posTop.value = Math.max(rect.top + topOffset, topOffset);
}

let resizeObserver: ResizeObserver | null = null;

function setupObservers() {
	if (!props.canvasElement) return;

	updatePosition();

	resizeObserver = new ResizeObserver(updatePosition);
	resizeObserver.observe(props.canvasElement);

	// Listen for scroll on the canvas background parent
	const scrollParent = props.canvasElement.closest('.document-canvas__bg');
	if (scrollParent) {
		scrollParent.addEventListener('scroll', updatePosition, { passive: true });
	}
	window.addEventListener('resize', updatePosition, { passive: true });
}

function cleanupObservers() {
	resizeObserver?.disconnect();
	resizeObserver = null;

	const scrollParent = props.canvasElement?.closest('.document-canvas__bg');
	if (scrollParent) {
		scrollParent.removeEventListener('scroll', updatePosition);
	}
	window.removeEventListener('resize', updatePosition);
}

watch(() => props.canvasElement, (newEl, oldEl) => {
	if (oldEl) cleanupObservers();
	if (newEl) setupObservers();
}, { immediate: false });

onMounted(() => {
	if (props.canvasElement) setupObservers();
});

onUnmounted(() => {
	cleanupObservers();
});

function handlePickerSelect(type: BlockType) {
	emit('add-block', type);
	showPicker.value = false;
}
</script>

<template>
	<Teleport to="body">
		<div
			v-show="isVisible && visible !== false"
			ref="sidebarRef"
			class="light fixed z-[999] flex flex-col items-center gap-0.5 p-1 bg-bg-elevated rounded-xl border border-border-subtle shadow-[0_2px_8px_rgba(0,0,0,0.08)] animate-eb-fade-in"
			:style="{ top: `${posTop}px`, left: `${posLeft}px`, width: '40px' }"
		>
			<button
				v-for="block in quickBlocks"
				:key="block.type"
				class="flex items-center justify-center w-[32px] h-[32px] rounded-lg border-none bg-transparent text-text-secondary cursor-pointer transition-all duration-(--motion-moderate) hover:bg-bg-surface-hover hover:text-text-primary active:scale-[0.92]"
				:title="block.label"
				type="button"
				@click="emit('add-block', block.type)"
			>
				<component :is="block.icon" :size="16" />
			</button>

			<div class="w-6 h-px bg-border-subtle my-0.5" />

			<button
				ref="moreButtonRef"
				class="flex items-center justify-center w-[32px] h-[32px] rounded-lg border border-dashed border-border-default bg-transparent text-text-tertiary cursor-pointer transition-all duration-(--motion-moderate) hover:bg-bg-surface-hover hover:text-text-secondary hover:border-border-strong active:scale-[0.92]"
				title="More blocks..."
				type="button"
				@click="showPicker = !showPicker"
			>
				<MoreHorizontal :size="16" />
			</button>
		</div>

		<BlockPickerPopover
			v-if="showPicker && moreButtonRef"
			:anchor-element="moreButtonRef"
			:block-types="blockTypes"
			@select="handlePickerSelect"
			@close="showPicker = false"
		/>
	</Teleport>
</template>
