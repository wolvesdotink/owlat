<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import type { Component } from 'vue';
import type { BlockType } from '../../types';
import { getAllBlocks } from '../../registry';

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
				label: block.label,
				icon: block.slashCommand!.icon,
			});
		}
	}
	return [
		{ label: 'Text', items: groups['text'] },
		{ label: 'Media', items: groups['media'] },
		{ label: 'Components', items: groups['components'] },
		{ label: 'Layout', items: groups['layout'] },
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

function handleKeydown(event: KeyboardEvent) {
	if (event.key === 'Escape') {
		emit('close');
	}
}

onMounted(() => {
	positionPopover();
	setTimeout(() => {
		document.addEventListener('mousedown', handleClickOutside);
	}, 0);
	document.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
	document.removeEventListener('mousedown', handleClickOutside);
	document.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
	<Teleport to="body">
		<div
			ref="popoverRef"
			role="menu"
			aria-label="Insert block"
			class="light fixed z-[9999] w-[280px] max-h-[380px] overflow-y-auto bg-bg-elevated rounded-xl border border-border-subtle shadow-[0_4px_8px_rgba(0,0,0,0.08),0_16px_32px_rgba(0,0,0,0.12)] animate-eb-popover-enter"
			:style="{ top: `${top}px`, left: `${left}px` }"
		>
			<div class="p-2">
				<div v-for="category in categories" :key="category.label" class="mb-1 last:mb-0">
					<div class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider px-2 py-1.5">
						{{ category.label }}
					</div>
					<div class="grid grid-cols-3 gap-0.5">
						<button
							v-for="block in category.items"
							:key="block.type"
							role="menuitem"
							:aria-label="block.label"
							class="flex flex-col items-center gap-1 py-2 px-1 rounded-lg border-none bg-transparent cursor-pointer transition-colors duration-100 text-text-secondary hover:bg-bg-surface-hover hover:text-text-primary"
							type="button"
							@click="emit('select', block.type); emit('close')"
						>
							<component :is="block.icon" :size="18" />
							<span class="text-[11px] font-medium leading-tight">{{ block.label }}</span>
						</button>
					</div>
				</div>
			</div>
		</div>
	</Teleport>
</template>
