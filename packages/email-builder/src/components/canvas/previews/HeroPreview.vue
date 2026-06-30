<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue';
import type { EditorBlock, EmailTheme, HeroBlockContent, Variable, SlashCommand } from '../../../types';
import type { ParentContext } from '../types';
import { VueDraggable } from 'vue-draggable-plus';
import { ImageIcon } from '@lucide/vue';
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

const content = computed(() => props.block.content as HeroBlockContent);

// Hero historically renders a single-stop gradient (a flat fill), so it allows
// a minimum of one stop rather than the usual two.
const gradientCss = computed(() => buildGradientCss(content.value.backgroundGradient, 1));

const overlayStyles = computed(() => {
	if (!content.value.overlayColor) return undefined;
	return {
		position: 'absolute' as const,
		inset: '0',
		backgroundColor: content.value.overlayColor,
		pointerEvents: 'none' as const,
	};
});

const heroStyles = computed(() => {
	const bgParts: string[] = [];
	if (content.value.backgroundImage) bgParts.push(`url(${content.value.backgroundImage})`);
	if (gradientCss.value) bgParts.push(gradientCss.value);

	return {
	backgroundImage: bgParts.length ? bgParts.join(', ') : undefined,
	backgroundPosition: content.value.backgroundPosition || 'center',
	backgroundSize: content.value.backgroundSize || 'cover',
	backgroundRepeat: 'no-repeat',
	backgroundColor: content.value.backgroundColor || '#f0f0f0',
	minHeight: content.value.mode === 'fixed-height' ? `${content.value.height || 400}px` : '200px',
	paddingTop: `${content.value.paddingTop ?? 40}px`,
	paddingRight: `${content.value.paddingRight ?? 24}px`,
	paddingBottom: `${content.value.paddingBottom ?? 40}px`,
	paddingLeft: `${content.value.paddingLeft ?? 24}px`,
	display: 'flex',
	flexDirection: 'column' as const,
	justifyContent:
		content.value.verticalAlign === 'top' ? 'flex-start'
		: content.value.verticalAlign === 'bottom' ? 'flex-end'
		: 'center',
	marginTop: `${content.value.marginTop ?? 0}px`,
	marginRight: `${content.value.marginRight ?? 0}px`,
	marginBottom: `${content.value.marginBottom ?? 0}px`,
	marginLeft: `${content.value.marginLeft ?? 0}px`,
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
</script>

<template>
	<div :style="heroStyles" class="relative rounded-sm overflow-hidden">
		<!-- Overlay color layer -->
		<div v-if="overlayStyles" :style="overlayStyles" />

		<!-- No-image placeholder -->
		<div
			v-if="!content.backgroundImage && !content.backgroundGradient && !content.overlayColor"
			class="absolute inset-0 flex items-center justify-center"
		>
			<div class="flex flex-col items-center gap-1 text-text-tertiary">
				<ImageIcon :size="32" />
				<span class="text-xs">Set background image</span>
			</div>
		</div>

		<VueDraggable
			:model-value="content.items"
			:group="`hero-${block.id}`"
			handle=".drag-handle"
			:animation="150"
			ghost-class="opacity-30"
			class="min-h-[40px] relative z-[1]"
			@update:model-value="handleItemReorder"
		>
			<div
				v-for="item in content.items"
				:key="item.id"
				class="relative group/nested-block"
				:data-block-id="item.id"
				:class="[
					'border rounded my-0.5 transition-[border-color] duration-150',
					item.id === selectedNestedItemId
						? 'border-brand'
						: 'border-transparent hover:border-white/20',
				]"
				@click="(e) => handleChildSelect(item.id, e)"
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
	</div>
</template>
