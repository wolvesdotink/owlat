<script setup lang="ts">
import { computed, type Component } from 'vue';
import type { EditorBlock, EmailTheme, Variable, SlashCommand } from '../../types';
import type { ParentContext } from './types';

// Preview components
import TextPreview from './previews/TextPreview.vue';
import ImagePreview from './previews/ImagePreview.vue';
import ButtonPreview from './previews/ButtonPreview.vue';
import DividerPreview from './previews/DividerPreview.vue';
import SpacerPreview from './previews/SpacerPreview.vue';
import SocialPreview from './previews/SocialPreview.vue';
import MenuPreview from './previews/MenuPreview.vue';
import ListPreview from './previews/ListPreview.vue';
import ProgressBarPreview from './previews/ProgressBarPreview.vue';
import AccordionPreview from './previews/AccordionPreview.vue';
import ColumnsPreview from './previews/ColumnsPreview.vue';
import ContainerPreview from './previews/ContainerPreview.vue';
import HeroPreview from './previews/HeroPreview.vue';
import IframePreview from './previews/IframePreview.vue';

const previewComponents: Record<string, Component> = {
	text: TextPreview,
	image: ImagePreview,
	button: ButtonPreview,
	divider: DividerPreview,
	spacer: SpacerPreview,
	social: SocialPreview,
	menu: MenuPreview,
	list: ListPreview,
	progressBar: ProgressBarPreview,
	accordion: AccordionPreview,
	columns: ColumnsPreview,
	container: ContainerPreview,
	hero: HeroPreview,
	// Iframe fallback for complex types
	table: IframePreview,
	rawHtml: IframePreview,
	video: IframePreview,
	carousel: IframePreview,
};

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
	nested?: boolean;
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

const previewComponent = computed(() => {
	return previewComponents[props.block.type] || IframePreview;
});
</script>

<template>
	<component
		:is="previewComponent"
		:block="block"
		:theme="theme"
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
</template>
