<script setup lang="ts">
import { ref, shallowRef } from 'vue';
import type { BlockType } from '../../types';
import { Plus } from '@lucide/vue';
import BlockPickerPopover from './BlockPickerPopover.vue';

defineProps<{
	afterBlockId: string;
	isDragging?: boolean;
	/** Restrict the insertable palette to this allowlist (EmailBuilderConfig.blockTypes). Undefined = all. */
	blockTypes?: BlockType[];
}>();

const emit = defineEmits<{
	(e: 'insert-block', type: BlockType, afterBlockId: string): void;
}>();

const isHovered = ref(false);
const showPicker = ref(false);
const buttonRef = shallowRef<HTMLElement | null>(null);

function handleSelect(type: BlockType, afterBlockId: string) {
	emit('insert-block', type, afterBlockId);
	showPicker.value = false;
	isHovered.value = false;
}
</script>

<template>
	<div
		v-if="!isDragging"
		class="relative h-2 group/insert"
		@mouseenter="isHovered = true"
		@mouseleave="isHovered = false"
	>
		<!-- Horizontal line -->
		<div
			class="absolute top-1/2 left-0 right-0 h-px -translate-y-1/2 transition-all duration-(--motion-moderate) origin-center"
			:class="isHovered || showPicker ? 'bg-brand/20 scale-x-100' : 'bg-transparent scale-x-0'"
			:style="isHovered || showPicker ? 'animation: eb-insert-line 150ms ease both' : ''"
		/>

		<!-- Plus button -->
		<button
			ref="buttonRef"
			class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-5 rounded-full border bg-bg-elevated flex items-center justify-center cursor-pointer transition-all duration-(--motion-moderate) z-[2]"
			:class="[
				isHovered || showPicker
					? 'opacity-100 scale-100'
					: 'opacity-0 scale-75 pointer-events-none',
				showPicker
					? 'border-brand bg-brand text-white'
					: 'border-brand/40 text-brand/60 hover:bg-brand hover:text-white hover:border-brand',
			]"
			type="button"
			@click.stop="showPicker = !showPicker"
		>
			<Plus :size="12" :stroke-width="2.5" />
		</button>

		<!-- Block picker popover -->
		<BlockPickerPopover
			v-if="showPicker && buttonRef"
			:anchor-element="buttonRef"
			:block-types="blockTypes"
			@select="(type: BlockType) => handleSelect(type, afterBlockId)"
			@close="showPicker = false"
		/>
	</div>
</template>
