<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue';
import type { SlashCommand } from '../../types';

const props = defineProps<{
	commands: SlashCommand[];
	selectedIndex: number;
	position: { top: number; left: number };
}>();

const emit = defineEmits<{
	(e: 'select', command: SlashCommand): void;
}>();

const listEl = ref<HTMLElement | null>(null);

// Category display order
const categoryOrder = ['text', 'media', 'layout', 'components', 'saved'] as const;
const categoryLabels: Record<string, string> = {
	text: 'Text',
	media: 'Media',
	layout: 'Layout',
	components: 'Components',
	saved: 'Saved',
};

// Group commands by category
const groupedCommands = computed(() => {
	const groups: { category: string; label: string; commands: { command: SlashCommand; globalIndex: number }[] }[] = [];
	let globalIndex = 0;

	for (const cat of categoryOrder) {
		const cmds = props.commands.filter((c) => c.category === cat);
		if (cmds.length > 0) {
			groups.push({
				category: cat,
				label: categoryLabels[cat] || cat,
				commands: cmds.map((cmd) => ({ command: cmd, globalIndex: globalIndex++ })),
			});
		}
	}

	// Catch any commands in uncategorized categories
	const seen = new Set(categoryOrder as readonly string[]);
	const remaining = props.commands.filter((c) => !seen.has(c.category));
	if (remaining.length > 0) {
		groups.push({
			category: 'other',
			label: 'Other',
			commands: remaining.map((cmd) => ({ command: cmd, globalIndex: globalIndex++ })),
		});
	}

	return groups;
});

// Auto-scroll selected item into view
watch(() => props.selectedIndex, () => {
	nextTick(() => {
		if (!listEl.value) return;
		const el = listEl.value.querySelector(`[data-index="${props.selectedIndex}"]`) as HTMLElement | null;
		el?.scrollIntoView({ block: 'nearest' });
	});
});
</script>

<template>
	<div
		role="listbox"
		aria-label="Block types"
		class="absolute z-[100] w-60 max-h-[280px] overflow-y-auto bg-bg-elevated border border-border-subtle rounded-lg shadow-[0_4px_16px_rgba(0,0,0,0.25)] p-1"
		:style="{
			top: `${position.top}px`,
			left: `${position.left}px`,
		}"
	>
		<div v-if="commands.length === 0" class="p-3 text-[13px] text-text-tertiary text-center">
			No matching blocks
		</div>
		<div v-else ref="listEl" class="flex flex-col">
			<template v-for="group in groupedCommands" :key="group.category">
				<div class="text-[10px] font-semibold uppercase tracking-[0.04em] text-text-tertiary py-1.5 px-2 mt-0.5 first:mt-0">{{ group.label }}</div>
				<button
					v-for="{ command, globalIndex } in group.commands"
					:key="command.id"
					role="option"
					:aria-selected="globalIndex === selectedIndex"
					:data-index="globalIndex"
					class="flex items-center gap-2 py-1.5 px-2 border-none rounded-md bg-transparent cursor-pointer w-full text-left transition-[background-color,box-shadow] duration-(--motion-fast) hover:bg-bg-surface-hover"
					:class="globalIndex === selectedIndex && '!bg-[rgba(196,120,90,0.12)] shadow-[inset_0_0_0_1px_rgba(196,120,90,0.2)]'"
					@mousedown.prevent="emit('select', command)"
				>
					<component
						:is="command.icon"
						v-if="command.icon"
						class="shrink-0 w-4 h-4 transition-colors duration-(--motion-fast)"
						:class="globalIndex === selectedIndex ? 'text-[rgb(196,120,90)]' : 'text-text-secondary'"
						:size="16"
					/>
					<div v-else class="shrink-0 w-4 h-4 rounded-[3px]" :class="globalIndex === selectedIndex ? 'bg-[rgba(196,120,90,0.2)]' : 'bg-bg-surface'" />
					<div class="flex flex-col gap-px min-w-0">
						<span class="text-[13px] font-medium text-text-primary whitespace-nowrap overflow-hidden text-ellipsis">{{ command.name }}</span>
						<span class="text-[11px] text-text-tertiary whitespace-nowrap overflow-hidden text-ellipsis">{{ command.description }}</span>
					</div>
				</button>
			</template>
		</div>
	</div>
</template>

