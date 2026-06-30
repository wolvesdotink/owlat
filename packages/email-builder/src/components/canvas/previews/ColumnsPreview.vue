<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue';
import type { EditorBlock, EmailTheme, ColumnsBlockContent, Variable, SlashCommand } from '../../../types';
import type { ParentContext } from '../types';
import { getColumnWidths } from '../../../utils/blocks';
import { VueDraggable } from 'vue-draggable-plus';

// Lazy import to break circular dependency (DocumentBlock imports this component)
const DocumentBlock = defineAsyncComponent(() => import('../DocumentBlock.vue'));

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
	selectedNestedItemId?: string | null;
	inlineEditBlockId?: string | null;
	variables?: Variable[];
}>();

const emit = defineEmits<{
	(e: 'select-nested', payload: { itemId: string; context: ParentContext; element: HTMLElement }): void;
	(e: 'update-children', blockId: string, children: unknown[]): void;
	(e: 'double-click-block', blockId: string): void;
	(e: 'exit-inline-edit'): void;
	(e: 'slash-command-select', command: SlashCommand, blockId: string): void;
	(e: 'insert-block-after', blockId: string): void;
	(e: 'open-link-dialog', blockId: string): void;
}>();

const content = computed(() => props.block.content as ColumnsBlockContent);

const wrapperStyles = computed(() => ({
	paddingTop: `${content.value.paddingTop ?? 16}px`,
	paddingRight: `${content.value.paddingRight ?? 24}px`,
	paddingBottom: `${content.value.paddingBottom ?? 16}px`,
	paddingLeft: `${content.value.paddingLeft ?? 24}px`,
	marginTop: `${content.value.marginTop ?? 0}px`,
	marginRight: `${content.value.marginRight ?? 0}px`,
	marginBottom: `${content.value.marginBottom ?? 0}px`,
	marginLeft: `${content.value.marginLeft ?? 0}px`,
}));

const columnWidths = computed(() =>
	getColumnWidths(content.value.columnCount, content.value.ratio)
);

const direction = computed(() => content.value.direction || 'ltr');

function getColumnStyles(colIdx: number) {
	const colStyle = content.value.columnStyles?.[colIdx];
	if (!colStyle) return {};

	const bgParts: string[] = [];
	if (colStyle.backgroundImage) bgParts.push(`url(${colStyle.backgroundImage})`);

	const hasBorder = colStyle.borderWidth && colStyle.borderWidth > 0 && colStyle.borderStyle !== 'none';

	return {
		backgroundColor: colStyle.backgroundColor || undefined,
		backgroundImage: bgParts.length ? bgParts.join(', ') : undefined,
		backgroundPosition: colStyle.backgroundImage ? (colStyle.backgroundPosition || 'center') : undefined,
		backgroundSize: colStyle.backgroundImage ? (colStyle.backgroundSize || 'cover') : undefined,
		backgroundRepeat: colStyle.backgroundImage ? 'no-repeat' : undefined,
		verticalAlign: colStyle.verticalAlign || undefined,
		paddingTop: colStyle.paddingTop != null ? `${colStyle.paddingTop}px` : undefined,
		paddingRight: colStyle.paddingRight != null ? `${colStyle.paddingRight}px` : undefined,
		paddingBottom: colStyle.paddingBottom != null ? `${colStyle.paddingBottom}px` : undefined,
		paddingLeft: colStyle.paddingLeft != null ? `${colStyle.paddingLeft}px` : undefined,
		border: hasBorder
			? `${colStyle.borderWidth}px ${colStyle.borderStyle || 'solid'} ${colStyle.borderColor || '#000000'}`
			: undefined,
		borderRadius: colStyle.borderRadius ? `${colStyle.borderRadius}px` : undefined,
	};
}

function handleColumnReorder(colIdx: number, newItems: unknown[]) {
	const newColumns = [...content.value.columns];
	newColumns[colIdx] = newItems as ColumnsBlockContent['columns'][number];
	emit('update-children', props.block.id, newColumns);
}

function handleChildSelect(itemId: string, colIdx: number, event: MouseEvent) {
	event.stopPropagation();
	const el = (event.currentTarget as HTMLElement)?.closest(`[data-block-id="${itemId}"]`) as HTMLElement
		|| event.currentTarget as HTMLElement;
	emit('select-nested', {
		itemId,
		context: { type: 'column', parentId: props.block.id, columnIndex: colIdx },
		element: el,
	});
}
</script>

<template>
	<div :style="wrapperStyles">
		<div class="flex" :style="{ gap: `${content.columnGap || 0}px`, direction: direction }">
			<div
				v-for="(col, colIdx) in content.columns"
				:key="colIdx"
				class="flex flex-col min-h-[40px] border border-dashed border-transparent rounded transition-colors duration-150 hover:border-border-default"
				:style="{ width: columnWidths[colIdx], verticalAlign: content.verticalAlign || 'top', ...getColumnStyles(colIdx) }"
			>
				<VueDraggable
					:model-value="col"
					:group="`column-${block.id}-${colIdx}`"
					handle=".drag-handle"
					:animation="150"
					ghost-class="opacity-30"
					class="flex-1 min-h-[40px]"
					@update:model-value="(newCol: unknown[]) => handleColumnReorder(colIdx, newCol)"
				>
					<div
						v-for="item in col"
						:key="item.id"
						class="relative group/nested-block"
						:data-block-id="item.id"
						:class="[
							'border rounded my-0.5 transition-[border-color] duration-150',
							item.id === selectedNestedItemId
								? 'border-brand'
								: 'border-transparent hover:border-border-subtle',
						]"
						@click="(e) => handleChildSelect(item.id, colIdx, e)"
					>
						<DocumentBlock
							:block="{ id: item.id, type: item.type, content: item.content } as EditorBlock"
							:theme="theme"
							:nested="true"
							:selected-nested-item-id="selectedNestedItemId"
							:inline-edit-block-id="inlineEditBlockId"
							:variables="variables"
						/>
					</div>
				</VueDraggable>
				<div v-if="col.length === 0" class="flex items-center justify-center h-[60px] border-2 border-dashed border-border-subtle rounded text-[11px] text-text-tertiary bg-bg-surface">
					Drop here
				</div>
			</div>
		</div>
	</div>
</template>
