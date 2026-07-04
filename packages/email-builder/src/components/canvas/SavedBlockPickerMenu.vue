<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import type { SavedBlock } from '../../types';
import { Search, Package, Loader2 } from '@lucide/vue';

const props = defineProps<{
	blocks: SavedBlock[];
	isLoading: boolean;
	position: { top: number; left: number };
}>();

const emit = defineEmits<{
	(e: 'select', block: SavedBlock): void;
	(e: 'close'): void;
}>();

const searchQuery = ref('');
const selectedIndex = ref(0);
const menuEl = ref<HTMLElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);

const filteredBlocks = computed(() => {
	const q = searchQuery.value.toLowerCase();
	if (!q) return props.blocks;
	return props.blocks.filter(
		(b) =>
			b.name.toLowerCase().includes(q) ||
			b.description?.toLowerCase().includes(q),
	);
});

watch(searchQuery, () => {
	selectedIndex.value = 0;
});

function handleKeydown(event: KeyboardEvent) {
	if (event.key === 'ArrowDown') {
		event.preventDefault();
		selectedIndex.value = Math.min(selectedIndex.value + 1, filteredBlocks.value.length - 1);
	} else if (event.key === 'ArrowUp') {
		event.preventDefault();
		selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
	} else if (event.key === 'Enter') {
		event.preventDefault();
		const selected = filteredBlocks.value[selectedIndex.value];
		if (selected) emit('select', selected);
	} else if (event.key === 'Escape') {
		event.preventDefault();
		emit('close');
	}
}

function handleClickOutside(event: MouseEvent) {
	if (menuEl.value && !menuEl.value.contains(event.target as Node)) {
		emit('close');
	}
}

onMounted(() => {
	nextTick(() => searchEl.value?.focus());
	document.addEventListener('mousedown', handleClickOutside);
});

onUnmounted(() => {
	document.removeEventListener('mousedown', handleClickOutside);
});
</script>

<template>
	<Teleport to="body">
		<div
			ref="menuEl"
			class="light fixed z-[10000] w-80 max-h-[360px] flex flex-col bg-bg-elevated border border-border-subtle rounded-[10px] shadow-[0_4px_6px_-1px_rgba(0,0,0,0.15),0_10px_20px_-2px_rgba(0,0,0,0.2)] animate-eb-slide-up"
			:style="{ top: `${position.top}px`, left: `${position.left}px` }"
			@keydown="handleKeydown"
		>
			<div class="relative p-2 border-b border-border-subtle">
				<Search :size="14" class="absolute top-1/2 left-[18px] -translate-y-1/2 text-text-tertiary pointer-events-none" />
				<input
					ref="searchEl"
					v-model="searchQuery"
					class="w-full py-1.5 pr-2 pl-7 text-[13px] border border-transparent rounded-md bg-bg-surface outline-none text-text-primary focus:border-brand focus:shadow-[0_0_0_3px_rgba(196,120,90,0.08)] focus:bg-bg-surface-hover"
					type="text"
					placeholder="Search saved blocks..."
				/>
			</div>

			<div v-if="isLoading" class="flex items-center gap-2 p-4 text-[13px] text-text-tertiary">
				<Loader2 :size="16" class="animate-spin" />
				Loading saved blocks...
			</div>

			<div v-else-if="filteredBlocks.length === 0" class="p-4 text-center text-[13px] text-text-tertiary">
				{{ searchQuery ? `No blocks match "${searchQuery}"` : 'No saved blocks yet' }}
			</div>

			<div v-else class="overflow-y-auto p-1 max-h-[300px]">
				<button
					v-for="(block, i) in filteredBlocks"
					:key="block._id"
					class="flex items-center gap-2.5 w-full py-2 px-2.5 text-left border-none rounded-md bg-transparent cursor-pointer transition-[background-color] duration-(--motion-fast) hover:bg-bg-surface-hover"
					:class="{ 'bg-brand/[0.08]': i === selectedIndex }"
					@mousedown.prevent="emit('select', block)"
					@mouseenter="selectedIndex = i"
				>
					<Package :size="16" class="shrink-0 text-text-tertiary" />
					<div class="flex-1 min-w-0 flex flex-col gap-0.5">
						<span class="text-[13px] font-medium text-text-primary whitespace-nowrap overflow-hidden text-ellipsis">{{ block.name }}</span>
						<span v-if="block.description" class="text-[11px] text-text-tertiary whitespace-nowrap overflow-hidden text-ellipsis">{{ block.description }}</span>
					</div>
					<div class="shrink-0">
						<span v-if="block.blockCount" class="text-[10px] text-text-tertiary whitespace-nowrap">{{ block.blockCount }} blocks</span>
					</div>
				</button>
			</div>
		</div>
	</Teleport>
</template>

