<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import type { EditorBlock, EmailTheme, AccordionBlockContent, Variable } from '../../../types';
import { blockBoxStyle } from '../../../utils/blocks';
import { ChevronDownIcon } from '@coolicons/vue';
import { useBuilderI18n } from '../../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

// Lazy import to break the circular dependency, as ContainerPreview does.
const DocumentBlock = defineAsyncComponent(() => import('../DocumentBlock.vue'));

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
	variables?: Variable[];
}>();

const content = computed(() => props.block.content as AccordionBlockContent);

// Which section the canvas shows open. Canvas-only state: the sent email's
// initial section stays `initialExpanded`, but the author can open any section
// here to see what it holds. Its Blocks are edited through the Content panel.
const expandedIndex = ref(content.value.initialExpanded ?? 0);
watch(
	() => content.value.initialExpanded,
	(initial) => {
		expandedIndex.value = initial ?? 0;
	}
);

function sectionContentId(sectionId: string): string {
	return `eb-accordion-${props.block.id}-${sectionId}`;
}

const wrapperStyles = computed(() => ({
	...blockBoxStyle(props.block),
}));
</script>

<template>
	<div :style="wrapperStyles">
		<div class="flex flex-col" :style="{ borderRadius: content.borderRadius ? `${content.borderRadius}px` : undefined, overflow: content.borderRadius ? 'hidden' : undefined }">
			<div
				v-for="(section, idx) in content.sections"
				:key="section.id"
				class="border"
				:style="{
					borderColor: content.sectionBorderColor || '#e0e0e0',
					borderTopWidth: idx === 0 ? '1px' : '0',
				}"
			>
				<button
					type="button"
					class="flex w-full items-center justify-between py-3 px-4 text-left cursor-pointer"
					:aria-expanded="idx === expandedIndex"
					:aria-controls="idx === expandedIndex ? sectionContentId(section.id) : undefined"
					@click="expandedIndex = idx"
					:style="{
						backgroundColor: content.headerBackgroundColor || '#f5f5f5',
						color: content.headerTextColor || '#333333',
						fontSize: `${content.headerFontSize || 16}px`,
						fontFamily: theme.fontFamily || 'Arial, sans-serif',
						fontWeight: '600',
					}"
				>
					<span>{{ section.title || t('builder.canvas.preview.untitledSection') }}</span>
					<ChevronDownIcon
						:size="16"
						aria-hidden="true"
						class="transition-transform duration-(--motion-moderate) ease-spring"
						:class="{ '-rotate-90': idx !== expandedIndex }"
						:style="{ color: content.iconColor || '#666666' }"
					/>
				</button>
				<div
					v-if="idx === expandedIndex"
					:id="sectionContentId(section.id)"
					class="py-3 px-4 text-sm"
					:style="{
						backgroundColor: content.contentBackgroundColor || '#ffffff',
						color: theme.bodyTextColor || '#333333',
					}"
				>
					<span v-if="section.items.length === 0" class="text-text-tertiary">{{
						t('builder.canvas.preview.sectionPlaceholder')
					}}</span>
					<template v-else>
						<DocumentBlock
							v-for="item in section.items"
							:key="item.id"
							:block="{ id: item.id, type: item.type, content: item.content } as EditorBlock"
							:theme="theme"
							:nested="true"
							:variables="variables"
						/>
					</template>
				</div>
			</div>
		</div>
	</div>
</template>
