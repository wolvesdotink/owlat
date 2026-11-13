<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import type { Component } from 'vue';
import type { BlockType } from '../../types';
import { getAllBlocks } from '../../registry';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

const { t, label } = useBuilderI18n();

const props = defineProps<{
	anchorElement: HTMLElement;
	/** Restrict the insertable palette to this allowlist (EmailBuilderConfig.blockTypes). Undefined = all. */
	blockTypes?: BlockType[];
}>();

const emit = defineEmits<{
	(e: 'select', type: BlockType): void;
	(e: 'close'): void;
}>();

const popoverRef = ref<HTMLElement | null>(null);
const top = ref(0);
const left = ref(0);

// Group blocks by category
const categories = computed(() => {
	const blocks = getAllBlocks(props.blockTypes).filter((b) => b.slashCommand !== null);
	const groups: Record<string, { type: BlockType; label: string; icon: Component }[]> = {
		text: [],
		media: [],
		components: [],
		layout: [],
	};
	for (const block of blocks) {
		const cat = block.slashCommand!.category;
		if (groups[cat]) {
			groups[cat].push({
				type: block.type,
				label: label(block.label),
				icon: block.slashCommand!.icon,
			});
		}
	}
	return [
		{ label: t('builder.canvas.categories.text'), items: groups['text'] },
		{ label: t('builder.canvas.categories.media'), items: groups['media'] },
		{ label: t('builder.canvas.categories.components'), items: groups['components'] },
		{ label: t('builder.canvas.categories.layout'), items: groups['layout'] },
	].filter((g) => g.items && g.items.length > 0);
});

function positionPopover() {
	const rect = props.anchorElement.getBoundingClientRect();
	const popoverHeight = 380;
	const popoverWidth = 280;

	// Prefer below the anchor
	let y = rect.bottom + 8;
	if (y + popoverHeight > window.innerHeight) {
		y = rect.top - popoverHeight - 8;
	}
	// Center horizontally on anchor
	let x = rect.left + rect.width / 2 - popoverWidth / 2;
	x = Math.max(8, Math.min(x, window.innerWidth - popoverWidth - 8));

	top.value = y;
	left.value = x;
}

function handleClickOutside(event: MouseEvent) {
	if (popoverRef.value && !popoverRef.value.contains(event.target as Node)) {
		emit('close');
	}
}

function menuItems(): HTMLButtonElement[] {
	return Array.from(popoverRef.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
}

// The opener gets focus back when the menu closes without a pick, so a
// keyboard user is not dropped onto <body>.
function closeToAnchor() {
	emit('close');
	props.anchorElement.focus({ preventScroll: true });
}

function handleKeydown(event: KeyboardEvent) {
	if (event.key === 'Escape') {
		// This menu owns Escape while open: editor shortcuts behind it must not
		// also run (deselecting the block, leaving focus mode).
		event.preventDefault();
		event.stopPropagation();
		closeToAnchor();
	}
}

// Arrow keys move through the three-column grid; Home and End jump to the ends.
function handleMenuKeydown(event: KeyboardEvent) {
	const items = menuItems();
	const current = items.indexOf(document.activeElement as HTMLButtonElement);
	if (current === -1) return;
	const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3 };
	let next: number | null = null;
	if (event.key in step) next = Math.max(0, Math.min(items.length - 1, current + step[event.key]!));
	else if (event.key === 'Home') next = 0;
	else if (event.key === 'End') next = items.length - 1;
	else if (event.key === 'Tab') {
		emit('close');
		return;
	}
	if (next === null) return;
	event.preventDefault();
	items[next]?.focus();
}

onMounted(() => {
	positionPopover();
	nextTick(() => menuItems()[0]?.focus({ preventScroll: true }));
	setTimeout(() => {
		document.addEventListener('mousedown', handleClickOutside);
	}, 0);
	document.addEventListener('keydown', handleKeydown, true);
});

onUnmounted(() => {
	document.removeEventListener('mousedown', handleClickOutside);
	document.removeEventListener('keydown', handleKeydown, true);
});
</script>

<template>
	<Teleport to="body">
		<div
			ref="popoverRef"
			role="menu"
			:aria-label="t('builder.canvas.insertBlock')"
			class="light fixed z-(--z-menu) w-[280px] max-h-[380px] overflow-y-auto bg-bg-elevated rounded-xl border border-border-subtle shadow-[0_4px_8px_rgba(0,0,0,0.08),0_16px_32px_rgba(0,0,0,0.12)] animate-eb-popover-enter"
			:style="{ top: `${top}px`, left: `${left}px` }"
			@keydown="handleMenuKeydown"
		>
			<div class="p-2">
				<div v-for="category in categories" :key="category.label" class="mb-1 last:mb-0">
					<div class="text-2xs font-semibold text-text-secondary uppercase tracking-wider px-2 py-1.5">
						{{ category.label }}
					</div>
					<div class="grid grid-cols-3 gap-0.5">
						<button
							v-for="block in category.items"
							:key="block.type"
							role="menuitem"
							tabindex="-1"
							:aria-label="block.label"
							class="flex flex-col items-center gap-1 py-2 px-1 rounded-lg border-none bg-transparent cursor-pointer transition-colors duration-(--motion-fast) text-text-secondary hover:bg-bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:bg-bg-surface-hover focus-visible:text-text-primary focus-visible:shadow-[inset_0_0_0_1px_var(--color-brand)]"
							type="button"
							@click="emit('select', block.type); emit('close')"
						>
							<component :is="block.icon" :size="18" aria-hidden="true" />
							<span class="text-2xs font-medium leading-tight">{{ block.label }}</span>
						</button>
					</div>
				</div>
			</div>
		</div>
	</Teleport>
</template>
