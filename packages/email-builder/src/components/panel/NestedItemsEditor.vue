<script setup lang="ts">
import { computed } from 'vue';
import type { Component } from 'vue';
import type { EditorBlock, BlockType, EmailTheme } from '../../types';
import { editorModuleFor } from '../../blocks';
import { Trash2, Plus, ChevronRight } from '@lucide/vue';

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
}>();

const emit = defineEmits<{
	(e: 'select-child', childId: string): void;
	(e: 'add-child', childType: BlockType): void;
	(e: 'remove-child', childId: string): void;
	(e: 'reorder-children', children: unknown[]): void;
}>();

const blockType = computed(() => props.block.type);

const chevronBgImage = "url(\"data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%238b8b96' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";

// The composite block's Editor module owns both shapes: how to project its
// children into a flat list (`childrenView`) and which block types can be
// inserted (`allowedChildTypes`). This component is now a thin dispatcher.
const children = computed<Array<{ id: string; type: string; label: string; icon: Component | null }>>(() => {
	const mod = editorModuleFor(blockType.value);
	return mod?.childrenView?.(props.block as never) ?? [];
});

const validChildTypes = computed<{ value: string; label: string; icon: Component | null }[]>(() => {
	const mod = editorModuleFor(blockType.value);
	const allowed = mod?.allowedChildTypes?.() ?? [];
	return allowed.map((t) => {
		const childMod = editorModuleFor(t as BlockType);
		return {
			value: t,
			label: childMod?.label ?? t,
			icon: childMod?.icon ?? null,
		};
	});
});
</script>

<template>
	<div class="border-t border-border-subtle py-3 px-4">
		<div class="flex items-center justify-between mb-2">
			<span class="text-[10px] font-bold text-text-tertiary uppercase tracking-[0.08em]">
				{{ blockType === 'accordion' ? 'Sections' : 'Children' }}
			</span>
			<span class="text-[10px] font-medium tabular-nums text-text-disabled">{{ children.length }}</span>
		</div>

		<div class="flex flex-col gap-1 mb-2">
			<div
				v-for="child in children"
				:key="child.id"
				class="group/item flex items-center gap-1.5 py-[7px] px-2 border border-border-subtle rounded-lg cursor-pointer transition-all duration-[120ms] hover:bg-bg-surface-hover hover:border-border-subtle"
				@click="emit('select-child', child.id)"
			>
				<component
					v-if="child.icon"
					:is="child.icon"
					:size="14"
					class="text-text-tertiary shrink-0 group-hover/item:text-brand"
				/>
				<span class="flex-1 text-xs text-text-primary whitespace-nowrap overflow-hidden text-ellipsis">{{ child.label }}</span>
				<ChevronRight :size="12" class="text-text-tertiary shrink-0 opacity-0 group-hover/item:opacity-100 transition-opacity duration-[120ms]" />
				<button
					class="flex items-center justify-center w-[22px] h-[22px] border-none rounded bg-none text-text-tertiary cursor-pointer shrink-0 opacity-0 group-hover/item:opacity-100 transition-[opacity,color,background-color] duration-[120ms] hover:text-error hover:bg-error-subtle"
					type="button"
					title="Remove"
					@click.stop="emit('remove-child', child.id)"
				>
					<Trash2 :size="12" />
				</button>
			</div>

			<div v-if="children.length === 0" class="p-3 text-center text-xs text-text-tertiary">
				No items yet
			</div>
		</div>

		<!-- Add child -->
		<div v-if="validChildTypes.length > 0" class="mt-1">
			<select
				class="w-full py-[7px] px-2 text-xs font-medium border border-dashed border-border-strong rounded-lg bg-bg-surface text-text-secondary cursor-pointer outline-none appearance-none bg-no-repeat bg-[right_8px_center] transition-all duration-[120ms] hover:bg-bg-surface-hover hover:border-text-tertiary hover:text-text-primary"
				:style="{ backgroundImage: chevronBgImage }"
				@change="(e) => { const val = (e.target as HTMLSelectElement).value; if (val) { emit('add-child', val as BlockType); (e.target as HTMLSelectElement).value = ''; } }"
			>
				<option value="">+ Add block...</option>
				<option v-for="t in validChildTypes" :key="t.value" :value="t.value">
					{{ t.label }}
				</option>
			</select>
		</div>
	</div>
</template>
