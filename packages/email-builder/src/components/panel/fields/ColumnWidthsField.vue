<script setup lang="ts">
import { computed } from 'vue';
import {
	getColumnWidthPercents,
	isValidColumnWidths,
	MIN_COLUMN_WIDTH_PERCENT,
	setColumnWidth,
} from '@owlat/shared';
import type { ColumnsBlockContent } from '../../../types';
import { useBuilderI18n } from '../../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

const props = defineProps<{
	content: ColumnsBlockContent;
	/** The visible field label, used as the group's legend. */
	label: string;
}>();

const emit = defineEmits<{
	/** New custom widths, or `undefined` to go back to the ratio preset. */
	(e: 'update', value: number[] | undefined): void;
}>();

const count = computed(() => props.content.columnCount);
const isCustom = computed(() => isValidColumnWidths(props.content.columnWidths, count.value));
const widths = computed(() =>
	getColumnWidthPercents(count.value, props.content.ratio, props.content.columnWidths)
);
const maxWidth = computed(() => 100 - MIN_COLUMN_WIDTH_PERCENT * (count.value - 1));
// At most three inputs per row: the 300px popover leaves a fourth or fifth
// input too narrow for two digits next to the number spinner.
const gridColumns = computed(() => `repeat(${Math.min(count.value, 3)}, minmax(0, 1fr))`);

function startCustom() {
	emit('update', widths.value);
}

// Committed on `change` (blur, Enter, the spinner), not on every keystroke:
// typing "40" passes through "4", which would clamp to the minimum and move
// the neighbouring column.
function commit(index: number, event: Event) {
	const input = event.target as HTMLInputElement;
	const next = setColumnWidth(widths.value, index, Number.parseFloat(input.value));
	input.value = String(next[index]);
	emit('update', next);
}
</script>

<template>
	<fieldset v-if="count > 1" class="flex flex-col gap-[5px] border-none p-0 m-0 min-w-0">
		<legend
			class="p-0 mb-[5px] text-caption font-medium leading-none text-text-primary tracking-[-0.01em]"
		>
			{{ label }}
		</legend>
		<template v-if="isCustom">
			<div class="grid gap-1" :style="{ gridTemplateColumns: gridColumns }">
				<label
					v-for="(width, index) in widths"
					:key="index"
					class="flex items-center border border-border-strong rounded-lg bg-bg-surface eb-input-ring"
				>
					<input
						type="number"
						:aria-label="t('builder.panel.columnWidths.column', { index: index + 1 })"
						class="w-0 flex-1 py-1.5 pl-1.5 text-caption pointer-coarse:text-base font-medium tabular-nums text-center border-none bg-transparent text-text-primary outline-none appearance-number-plain"
						:value="width"
						:min="MIN_COLUMN_WIDTH_PERCENT"
						:max="maxWidth"
						step="1"
						@change="commit(index, $event)"
					/>
					<span
						class="text-2xs font-medium text-text-tertiary pr-1.5 select-none"
						aria-hidden="true"
						>%</span
					>
				</label>
			</div>
			<p class="text-2xs leading-[1.4] text-text-tertiary m-0">
				{{ t('builder.panel.columnWidths.help', { min: MIN_COLUMN_WIDTH_PERCENT }) }}
			</p>
			<button
				type="button"
				class="self-start text-2xs font-medium text-text-secondary underline underline-offset-2 bg-transparent border-none p-0 cursor-pointer hover:text-text-primary"
				@click="emit('update', undefined)"
			>
				{{ t('builder.panel.columnWidths.usePreset') }}
			</button>
		</template>
		<button
			v-else
			type="button"
			class="self-start py-1.5 px-2.5 text-caption font-medium border border-border-strong rounded-lg bg-bg-surface text-text-primary cursor-pointer transition-colors duration-(--motion-fast) hover:bg-bg-surface-hover"
			@click="startCustom"
		>
			{{ t('builder.panel.columnWidths.customize') }}
		</button>
	</fieldset>
</template>
