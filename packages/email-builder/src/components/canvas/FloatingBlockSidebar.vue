<script setup lang="ts">
import UiTooltip from '@owlat/ui/components/ui/Tooltip.vue';
import { ref, shallowRef, computed, onMounted, onUnmounted, watch } from 'vue';
import type { Component } from 'vue';
import type { BlockType, BrandBlockKind } from '../../types';
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
	Stamp,
	PanelBottom,
} from '@lucide/vue';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

const { t, label } = useBuilderI18n();

const props = defineProps<{
	canvasElement: HTMLElement | null;
	visible?: boolean;
	/** Restrict the insertable palette to this allowlist (EmailBuilderConfig.blockTypes). Undefined = all. */
	blockTypes?: BlockType[];
	/** The brand kit Blocks there is something to insert for. */
	brandBlocks?: BrandBlockKind[];
}>();

const emit = defineEmits<{
	(e: 'add-block', type: BlockType): void;
	(e: 'add-brand-block', kind: BrandBlockKind): void;
}>();

const BRAND_BUTTONS: Record<BrandBlockKind, { icon: Component; label: string }> = {
	logo: { icon: Stamp, label: 'Brand logo' },
	footer: { icon: PanelBottom, label: 'Brand footer' },
};

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

	// Align to top of canvas, sticky once the canvas scrolls past the top of its
	// scroll root. The sidebar is teleported to <body>, so the root's clipping
	// does not apply: clamp to the root's top edge, not the viewport's, or it
	// slides over whatever sits above the canvas (app header, editor toolbar).
	const topOffset = 16;
	const floor = Math.max(scrollRoot?.getBoundingClientRect().top ?? 0, 0);
	posTop.value = Math.max(rect.top, floor) + topOffset;
}

// Scroll/resize bursts fire many events per frame; read geometry once per frame.
let frameId: number | null = null;
function scheduleUpdate() {
	if (frameId !== null) return;
	frameId = requestAnimationFrame(() => {
		frameId = null;
		updatePosition();
	});
}

// Everything installed for one canvas element, torn down against the exact
// targets it was installed on (the canvas prop has already moved on by then).
let teardown: (() => void) | null = null;
// The scroll root of the current canvas; its top edge is the sidebar's ceiling.
let scrollRoot: Element | null = null;

function setupObservers(canvas: HTMLElement) {
	// The canvas background parent scrolls; listen there and clamp to its top.
	const scrollParent = canvas.closest('.document-canvas__bg');
	scrollRoot = scrollParent;
	updatePosition();

	const resizeObserver = new ResizeObserver(scheduleUpdate);
	resizeObserver.observe(canvas);

	scrollParent?.addEventListener('scroll', scheduleUpdate, { passive: true });
	window.addEventListener('resize', scheduleUpdate, { passive: true });

	teardown = () => {
		resizeObserver.disconnect();
		scrollParent?.removeEventListener('scroll', scheduleUpdate);
		window.removeEventListener('resize', scheduleUpdate);
	};
}

function cleanupObservers() {
	teardown?.();
	teardown = null;
	scrollRoot = null;
	if (frameId !== null) {
		cancelAnimationFrame(frameId);
		frameId = null;
	}
}

watch(
	() => props.canvasElement,
	(newEl) => {
		cleanupObservers();
		if (newEl) setupObservers(newEl);
	}
);

onMounted(() => {
	if (props.canvasElement) setupObservers(props.canvasElement);
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
			class="light fixed z-(--z-float) flex flex-col items-center gap-0.5 p-1 bg-bg-elevated rounded-xl border border-border-subtle shadow-[0_2px_8px_rgba(0,0,0,0.08)] animate-eb-fade-in"
			:style="{ top: `${posTop}px`, left: `${posLeft}px`, width: '40px' }"
			role="toolbar"
			aria-orientation="vertical"
			:aria-label="t('builder.canvas.insertBlock')"
		>
			<UiTooltip v-for="block in quickBlocks" :key="block.type" :text="label(block.label)">
				<button
					class="flex items-center justify-center w-[32px] h-[32px] rounded-lg border-none bg-transparent text-text-secondary cursor-pointer transition-all duration-(--motion-moderate) hover:bg-bg-surface-hover hover:text-text-primary active:scale-[0.92]"
					:aria-label="t('builder.canvas.addBlock', { block: label(block.label) })"
					type="button"
					@click="emit('add-block', block.type)"
				>
					<component :is="block.icon" :size="16" />
				</button>
			</UiTooltip>

			<template v-if="brandBlocks && brandBlocks.length > 0">
				<div class="w-6 h-px bg-border-subtle my-0.5" />
				<UiTooltip v-for="kind in brandBlocks" :key="kind" :text="label(BRAND_BUTTONS[kind].label)">
					<button
						class="flex items-center justify-center w-[32px] h-[32px] rounded-lg border-none bg-transparent text-brand cursor-pointer transition-all duration-(--motion-moderate) hover:bg-bg-surface-hover active:scale-[0.92]"
						:aria-label="
							t('builder.canvas.addBrandBlock', { block: label(BRAND_BUTTONS[kind].label) })
						"
						:data-testid="`add-brand-${kind}`"
						type="button"
						@click="emit('add-brand-block', kind)"
					>
						<component :is="BRAND_BUTTONS[kind].icon" :size="16" />
					</button>
				</UiTooltip>
			</template>

			<div class="w-6 h-px bg-border-subtle my-0.5" />

			<UiTooltip :text="t('builder.canvas.moreBlocksTitle')">
				<button
					ref="moreButtonRef"
					class="flex items-center justify-center w-[32px] h-[32px] rounded-lg border border-dashed border-border-default bg-transparent text-text-tertiary cursor-pointer transition-all duration-(--motion-moderate) hover:bg-bg-surface-hover hover:text-text-secondary hover:border-border-strong active:scale-[0.92]"
					:aria-label="t('builder.canvas.moreBlocks')"
					aria-haspopup="menu"
					:aria-expanded="showPicker"
					type="button"
					@click="showPicker = !showPicker"
				>
					<MoreHorizontal :size="16" />
				</button>
			</UiTooltip>
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
