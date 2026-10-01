<script setup lang="ts">
import { computed, defineAsyncComponent, inject } from 'vue';
import type { EditorBlock, EmailTheme, ContainerBlockContent, Variable, SlashCommand } from '../../../types';
import { blockBoxStyle } from '../../../utils/blocks';
import type { ParentContext } from '../types';
import { VueDraggable } from 'vue-draggable-plus';
import { gradientCss as buildGradientCss } from '../../../utils/gradient';

// Lazy import to break circular dependency
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

// Nested items register their element like root Blocks do, so the toolbar
// can anchor to a selected item at any depth.
const setBlockElement = inject<(blockId: string, el: HTMLElement | null) => void>(
	'setBlockElement',
	() => {}
);

const content = computed(() => props.block.content as ContainerBlockContent);

const gradientCss = computed(() => buildGradientCss(content.value.backgroundGradient));

const containerStyles = computed(() => {
	const bgColor = content.value.backgroundColor || 'transparent';

	// Build background-image from image and/or gradient
	const bgParts: string[] = [];
	if (content.value.backgroundImage) bgParts.push(`url(${content.value.backgroundImage})`);
	if (gradientCss.value) bgParts.push(gradientCss.value);

	return {
		backgroundColor: bgColor,
		backgroundImage: bgParts.length ? bgParts.join(', ') : undefined,
		backgroundPosition: content.value.backgroundImage ? (content.value.backgroundPosition || 'center') : undefined,
		backgroundSize: content.value.backgroundImage ? (content.value.backgroundSize || 'cover') : undefined,
		backgroundRepeat: content.value.backgroundImage ? 'no-repeat' : undefined,
		...blockBoxStyle(props.block),
		borderRadius: content.value.borderRadius ? `${content.value.borderRadius}px` : undefined,
		borderWidth: content.value.borderWidth ? `${content.value.borderWidth}px` : undefined,
		borderColor: content.value.borderColor || undefined,
		borderStyle: content.value.borderWidth ? (content.value.borderStyle || 'solid') : undefined,
		maxWidth: content.value.maxWidth && content.value.maxWidth < 100 ? `${content.value.maxWidth}%` : undefined,
	};
});

function handleItemReorder(newItems: unknown[]) {
	emit('update-children', props.block.id, newItems);
}

function handleChildSelect(itemId: string, event: MouseEvent) {
	event.stopPropagation();
	const el = event.currentTarget as HTMLElement;
	emit('select-nested', {
		itemId,
		context: { type: 'container', parentId: props.block.id },
		element: el,
	});
}

// Double-clicking a nested text Block opens it in the inline editor, in place.
function handleChildDoubleClick(item: { id: string; type: string }) {
	if (item.type === 'text') emit('double-click-block', item.id);
}
</script>

<template>
	<div :style="containerStyles" class="min-h-[40px]">
		<VueDraggable
			:model-value="content.items"
			:group="`container-${block.id}`"
			handle=".drag-handle"
			:animation="150"
			ghost-class="opacity-30"
			class="min-h-[40px]"
			@update:model-value="handleItemReorder"
		>
			<div
				v-for="item in content.items"
				:key="item.id"
				class="relative group/nested-block"
				:data-block-id="item.id"
				:ref="(el) => setBlockElement(item.id, el as HTMLElement | null)"
				:class="[
					'border rounded my-0.5 transition-[border-color] duration-(--motion-fast)',
					item.id === selectedNestedItemId
						? 'border-brand'
						: 'border-transparent hover:border-border-subtle',
				]"
				@click="(e) => handleChildSelect(item.id, e)"
				@dblclick="handleChildDoubleClick(item)"
			>
				<DocumentBlock
					:block="{ id: item.id, type: item.type, content: item.content } as EditorBlock"
					:theme="theme"
					:nested="true"
					:selected-nested-item-id="selectedNestedItemId"
					:inline-edit-block-id="inlineEditBlockId"
					:variables="variables"
					@select-nested="(payload: { itemId: string; context: ParentContext; element: HTMLElement }) => emit('select-nested', payload)"
					@update-children="(blockId: string, children: unknown[]) => emit('update-children', blockId, children)"
					@double-click-block="(id: string) => emit('double-click-block', id)"
					@exit-inline-edit="emit('exit-inline-edit')"
					@slash-command-select="(cmd: SlashCommand, blockId: string) => emit('slash-command-select', cmd, blockId)"
					@insert-block-after="(id: string) => emit('insert-block-after', id)"
					@open-link-dialog="(id: string) => emit('open-link-dialog', id)"
				/>
			</div>
		</VueDraggable>
		<div v-if="content.items.length === 0" class="flex items-center justify-center h-[60px] border-2 border-dashed border-border-subtle rounded text-[11px] text-text-tertiary bg-bg-surface">
			Drop blocks here
		</div>
	</div>
</template>
