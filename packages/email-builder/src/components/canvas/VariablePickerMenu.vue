<script setup lang="ts">
import { computed, ref, watch, nextTick, useAttrs } from 'vue';
import type { Variable } from '../../types';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

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
		// Ungrouped variables sit under the localized default heading.
		const group = v.group || '';
		if (!groups.has(group)) groups.set(group, []);
		groups.get(group)!.push(v);
	}

	return [...groups.entries()].map(([label, items]) => ({ label, items }));
});

const flatList = computed(() => groupedVariables.value.flatMap((g) => g.items));

// The picker confirms `variables[selectedIndex]` (its own order), so the
// highlight follows that entry, not its position in the grouped list: with
// interleaved groups the two orders differ and Enter would insert another row.
function isSelected(variable: Variable): boolean {
	return props.variables[props.selectedIndex]?.key === variable.key;
}

// With an `id` on the list, each option is `${id}-option-${index}` (index in
// `variables`), so the field that keeps focus can name the highlighted one
// through aria-activedescendant.
const attrs = useAttrs();
function optionId(variable: Variable): string | undefined {
	const listId = attrs['id'];
	if (typeof listId !== 'string' || !listId) return undefined;
	return `${listId}-option-${props.variables.findIndex((v) => v.key === variable.key)}`;
}

// Scroll selected item into view
watch(
	() => props.selectedIndex,
	() => {
		nextTick(() => {
			const selected = menuEl.value?.querySelector('[aria-selected="true"]');
			selected?.scrollIntoView({ block: 'nearest' });
		});
	},
);
</script>

<template>
	<div
		ref="menuEl"
		role="listbox"
		:aria-label="t('builder.variables.title')"
		class="absolute z-[100] min-w-[200px] max-w-[280px] max-h-60 overflow-y-auto bg-bg-elevated border border-border-subtle rounded-lg shadow-[0_4px_6px_-1px_rgba(0,0,0,0.15),0_2px_4px_-2px_rgba(0,0,0,0.15)] p-1 animate-eb-slide-up"
		:style="{ top: `${position.top}px`, left: `${position.left}px` }"
	>
		<div class="py-1.5 px-2 text-2xs font-bold uppercase tracking-[0.05em] text-text-tertiary">
			{{ t('builder.variables.title') }}
		</div>
		<div v-if="flatList.length === 0" class="py-3 px-2 text-xs text-text-tertiary text-center">
			{{ t('builder.variables.noMatches', { query }) }}
		</div>
		<template v-for="group in groupedVariables" :key="group.label">
			<div
				v-if="groupedVariables.length > 1"
				class="py-1.5 px-2 text-2xs font-semibold text-text-tertiary uppercase tracking-[0.04em]"
			>
				{{ group.label || t('builder.variables.title') }}
			</div>
			<button
				v-for="v in group.items"
				:key="v.key"
				class="flex items-center gap-2 w-full py-1.5 px-2 text-caption text-left border-none rounded bg-transparent cursor-pointer transition-[background-color] duration-(--motion-fast) hover:bg-bg-surface-hover"
				:class="{ 'bg-brand/[0.08]': isSelected(v) }"
				:id="optionId(v)"
				type="button"
				role="option"
				:aria-selected="isSelected(v)"
				@mousedown.prevent="emit('select', v)"
			>
				<span class="font-medium text-brand font-mono text-xs">{{ v.key }}</span>
				<span v-if="v.label !== v.key" class="text-text-tertiary text-2xs whitespace-nowrap overflow-hidden text-ellipsis">{{ v.label }}</span>
			</button>
		</template>
	</div>
</template>

