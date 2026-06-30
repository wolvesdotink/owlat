<script setup lang="ts">
import { computed } from 'vue';
import type { EditorBlock, CommonBlockProperties } from '../../types';
import ColorField from './fields/ColorField.vue';
import NumberField from './fields/NumberField.vue';
import SelectField from './fields/SelectField.vue';
import FieldLabel from '../ui/FieldLabel.vue';

const props = defineProps<{
	block: EditorBlock;
}>();

const emit = defineEmits<{
	(e: 'update', key: string, value: unknown): void;
}>();

const content = computed(() => props.block.content as CommonBlockProperties);

const borderWidth = computed(() => (content.value.borderWidth as number) ?? 0);
const borderColor = computed(() => (content.value.borderColor as string) ?? '#000000');
const borderStyle = computed(() => (content.value.borderStyle as string) ?? 'none');

const borderStyleOptions = [
	{ label: 'None', value: 'none' },
	{ label: 'Solid', value: 'solid' },
	{ label: 'Dashed', value: 'dashed' },
	{ label: 'Dotted', value: 'dotted' },
];

const previewStyle = computed(() => {
	if (borderStyle.value === 'none' || borderWidth.value === 0) {
		return { borderBottom: '1px dashed var(--color-border, #d1d5db)' };
	}
	return {
		borderBottom: `${borderWidth.value}px ${borderStyle.value} ${borderColor.value}`,
	};
});
</script>

<template>
	<div class="flex flex-col gap-2">
		<!-- Border preview strip -->
		<div class="h-0 w-full rounded-sm" :style="previewStyle" />

		<div class="flex gap-2">
			<!-- Width -->
			<div class="flex flex-col gap-[3px]">
				<FieldLabel size="sm">Width</FieldLabel>
				<NumberField
					:value="borderWidth"
					:min="0"
					:max="10"
					unit="px"
					@update="(val) => emit('update', 'borderWidth', val)"
				/>
			</div>

			<!-- Style -->
			<div class="flex flex-col gap-[3px] flex-1">
				<FieldLabel size="sm">Style</FieldLabel>
				<SelectField
					:value="borderStyle"
					:options="borderStyleOptions"
					@update="(val) => emit('update', 'borderStyle', val)"
				/>
			</div>
		</div>

		<!-- Color -->
		<div class="flex flex-col gap-[3px]">
			<FieldLabel size="sm">Color</FieldLabel>
			<ColorField
				:value="borderColor"
				@update="(val) => emit('update', 'borderColor', val)"
			/>
		</div>
	</div>
</template>
