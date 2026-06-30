<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import type { Variable } from '../../types';

const props = defineProps<{
	variables: Variable[];
	query: string;
	selectedIndex: number;
	position: { top: number; left: number };
}>();

const emit = defineEmits<{
	(e: 'select', variable: Variable): void;
}>();

const menuEl = ref<HTMLElement | null>(null);

const groupedVariables = computed(() => {
	const q = props.query.toLowerCase();
	const filtered = props.variables.filter((v) => {
		return v.key.toLowerCase().includes(q) || v.label.toLowerCase().includes(q);
	});

	const groups = new Map<string, Variable[]>();
	for (const v of filtered) {
		const group = v.group || 'Variables';
		if (!groups.has(group)) groups.set(group, []);
		groups.get(group)!.push(v);
	}

	return [...groups.entries()].map(([label, items]) => ({ label, items }));
});

const flatList = computed(() => groupedVariables.value.flatMap((g) => g.items));

// Scroll selected item into view
watch(
	() => props.selectedIndex,
	() => {
		nextTick(() => {
			const selected = menuEl.value?.querySelector('.variable-picker-menu__item--selected');
			selected?.scrollIntoView({ block: 'nearest' });
		});
	},
);
</script>

<template>
	<div
		ref="menuEl"
		class="absolute z-[100] min-w-[200px] max-w-[280px] max-h-60 overflow-y-auto bg-bg-elevated border border-border-subtle rounded-lg shadow-[0_4px_6px_-1px_rgba(0,0,0,0.15),0_2px_4px_-2px_rgba(0,0,0,0.15)] p-1 animate-eb-slide-up"
		:style="{ top: `${position.top}px`, left: `${position.left}px` }"
	>
		<div class="py-1.5 px-2 text-[10px] font-bold uppercase tracking-[0.05em] text-text-tertiary">Variables</div>
		<div v-if="flatList.length === 0" class="py-3 px-2 text-xs text-text-tertiary text-center">
			No variables match "{{ query }}"
		</div>
		<template v-for="group in groupedVariables" :key="group.label">
			<div v-if="groupedVariables.length > 1" class="py-1.5 px-2 text-[10px] font-semibold text-text-tertiary uppercase tracking-[0.04em]">
				{{ group.label }}
			</div>
			<button
				v-for="v in group.items"
				:key="v.key"
				class="flex items-center gap-2 w-full py-1.5 px-2 text-[13px] text-left border-none rounded bg-transparent cursor-pointer transition-[background-color] duration-100 hover:bg-bg-surface-hover"
				:class="{
					'bg-brand/[0.08]':
						flatList.indexOf(v) === selectedIndex,
				}"
				@mousedown.prevent="emit('select', v)"
			>
				<span class="font-medium text-brand font-mono text-xs">{{ v.key }}</span>
				<span v-if="v.label !== v.key" class="text-text-tertiary text-[11px] whitespace-nowrap overflow-hidden text-ellipsis">{{ v.label }}</span>
			</button>
		</template>
	</div>
</template>

