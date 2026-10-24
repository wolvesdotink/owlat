<script setup lang="ts">
import { computed } from 'vue';
import type { Component } from 'vue';
import type { EditorBlock, BlockType, EmailTheme } from '../../types';
import { editorModuleFor } from '../../blocks';
import type { NestedChild } from '../../blocks/_module';
import { Trash2, Plus, ChevronRight } from '@lucide/vue';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

const { t, label } = useBuilderI18n();

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
const children = computed<NestedChild[]>(() => {
	const mod = editorModuleFor(blockType.value);
	return mod?.childrenView?.(props.block as never) ?? [];
});

/** The row's text: block labels are registry copy; entry titles are the author's. */
function childLabel(child: NestedChild): string {
	if (child.labelKey) return t(child.labelKey);
	if (child.column !== undefined) {
		const typeLabel = label(editorModuleFor(child.type as BlockType)?.label ?? child.type);
		return t('builder.panel.nested.columnChild', { column: child.column, block: typeLabel });
	}
	return childrenAreBlocks.value ? label(child.label) : child.label;
}

// Selecting and removing a child address a Block by id. Entries that are not
// Blocks (accordion sections) are edited through the block's own fields.
const childrenAreBlocks = computed(
	() => editorModuleFor(blockType.value)?.childrenAreBlocks !== false
);

const validChildTypes = computed<{ value: string; label: string; icon: Component | null }[]>(() => {
	const mod = editorModuleFor(blockType.value);
	const allowed = mod?.allowedChildTypes?.() ?? [];
	return allowed.map((type) => {
		const childMod = editorModuleFor(type as BlockType);
		return {
			value: type,
			label: label(childMod?.label ?? type),
			icon: childMod?.icon ?? null,
		};
	});
});
</script>

<template>
	<div class="border-t border-border-subtle py-3 px-4">
		<div class="flex items-center justify-between mb-2">
			<span class="text-[10px] font-bold text-text-tertiary uppercase tracking-[0.08em]">
				{{
					blockType === 'accordion'
						? t('builder.panel.nested.sections')
						: t('builder.panel.nested.children')
				}}
			</span>
			<span class="text-[10px] font-medium tabular-nums text-text-disabled">{{ children.length }}</span>
		</div>

		<div class="flex flex-col gap-1 mb-2">
			<!--
				The row is a plain container, not a `role="button"`: it holds the
				Remove button, and a button makes all of its descendants
				presentational, which stripped that control out of the a11y tree
				entirely. The row's own "edit this child" action is a real <button>
				spanning the label, so the two controls are siblings. Rows for entries
				that are not Blocks carry the label only.
			-->
			<div
				v-for="child in children"
				:key="child.id"
				class="flex items-center gap-1.5 py-[7px] px-2 border border-border-subtle rounded-lg"
				:class="
					childrenAreBlocks &&
					'group/item transition-colors duration-(--motion-moderate) hover:bg-bg-surface-hover hover:border-border-subtle'
				"
			>
				<span
					v-if="!childrenAreBlocks"
					class="flex-1 text-xs text-text-primary whitespace-nowrap overflow-hidden text-ellipsis"
					>{{ childLabel(child) }}</span
				>
				<button
					v-else
					class="flex flex-1 items-center gap-1.5 min-w-0 border-none bg-transparent p-0 text-left cursor-pointer"
					type="button"
					:aria-label="t('builder.panel.nested.edit', { item: childLabel(child) })"
					@click="emit('select-child', child.id)"
				>
					<component
						v-if="child.icon"
						:is="child.icon"
						:size="14"
						class="text-text-tertiary shrink-0 group-hover/item:text-brand"
					/>
					<span
						class="flex-1 text-xs text-text-primary whitespace-nowrap overflow-hidden text-ellipsis"
						>{{ childLabel(child) }}</span
					>
					<ChevronRight
						:size="12"
						class="text-text-tertiary shrink-0 opacity-0 group-hover/item:opacity-100 transition-opacity duration-(--motion-fast)"
					/>
				</button>
				<button
					v-if="childrenAreBlocks"
					class="flex items-center justify-center w-[22px] h-[22px] border-none rounded bg-none text-text-tertiary cursor-pointer shrink-0 opacity-0 group-hover/item:opacity-100 transition-[opacity,color,background-color] duration-(--motion-fast) hover:text-error hover:bg-error-subtle"
					type="button"
					:title="t('builder.panel.nested.remove', { item: childLabel(child) })"
					:aria-label="t('builder.panel.nested.remove', { item: childLabel(child) })"
					@click.stop="emit('remove-child', child.id)"
				>
					<Trash2 :size="12" />
				</button>
			</div>

			<div v-if="children.length === 0" class="p-3 text-center text-xs text-text-tertiary">
				{{ t('builder.panel.nested.empty') }}
			</div>
		</div>

		<!-- Add child -->
		<div v-if="validChildTypes.length > 0" class="mt-1">
			<select
				:aria-label="
					blockType === 'accordion'
						? t('builder.panel.nested.addSection')
						: t('builder.panel.nested.addChild')
				"
				class="w-full py-[7px] px-2 text-xs font-medium border border-dashed border-border-strong rounded-lg bg-bg-surface text-text-secondary cursor-pointer outline-none appearance-none bg-no-repeat bg-[right_8px_center] transition-colors duration-(--motion-moderate) hover:bg-bg-surface-hover hover:border-text-tertiary hover:text-text-primary"
				:style="{ backgroundImage: chevronBgImage }"
				@change="(e) => { const val = (e.target as HTMLSelectElement).value; if (val) { emit('add-child', val as BlockType); (e.target as HTMLSelectElement).value = ''; } }"
			>
				<option value="">{{ t('builder.panel.nested.addBlock') }}</option>
				<option
					v-for="childType in validChildTypes"
					:key="childType.value"
					:value="childType.value"
				>
					{{ childType.label }}
				</option>
			</select>
		</div>
	</div>
</template>
