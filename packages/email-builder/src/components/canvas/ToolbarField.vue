<script setup lang="ts">
import { computed } from 'vue';
import type { PropertyField } from '../../schema/types';
import { AlignLeft, AlignCenter, AlignRight, AlignJustify, Maximize2 } from '@lucide/vue';

const props = defineProps<{
	field: PropertyField;
	value: unknown;
}>();

const emit = defineEmits<{
	(e: 'update', key: string, value: unknown): void;
}>();

const alignIcons: Record<string, typeof AlignLeft> = {
	left: AlignLeft,
	center: AlignCenter,
	right: AlignRight,
	justify: AlignJustify,
	full: Maximize2,
};

const alignOptions = computed(() => props.field.alignOptions ?? ['left', 'center', 'right']);

function handleNumberChange(event: Event) {
	const target = event.target as HTMLInputElement;
	const val = Number(target.value);
	emit('update', props.field.key, val);
}

function handleSelectChange(event: Event) {
	const target = event.target as HTMLSelectElement;
	const opt = props.field.options?.find((o) => String(o.value) === target.value);
	emit('update', props.field.key, opt?.value ?? target.value);
}
</script>

<template>
	<div class="flex items-center gap-0.5">
		<!-- Alignment buttons -->
		<template v-if="field.type === 'align'">
			<button
				v-for="opt in alignOptions"
				:key="opt"
				class="flex items-center justify-center w-[26px] h-[26px] border-none bg-transparent rounded text-text-secondary cursor-pointer transition-[background-color,color] duration-100 hover:bg-black/[0.08]"
				:class="{ 'bg-black/[0.12] text-brand': value === opt }"
				:title="opt"
				@click.stop="emit('update', field.key, opt)"
			>
				<component :is="alignIcons[opt]" :size="14" />
			</button>
		</template>

		<!-- Number / Slider inline -->
		<template v-else-if="field.type === 'number' || field.type === 'slider'">
			<label class="text-[11px] text-text-tertiary mr-1 whitespace-nowrap">{{ field.label }}</label>
			<input
				type="number"
				class="w-12 h-[26px] text-xs border border-border-default rounded px-1 text-center bg-transparent text-inherit focus:outline-none focus:border-brand"
				:value="value"
				:min="field.min"
				:max="field.max"
				:step="field.step ?? 1"
				@input="handleNumberChange"
				@click.stop
			/>
			<span v-if="field.unit" class="text-[10px] text-text-tertiary">{{ field.unit }}</span>
		</template>

		<!-- Select -->
		<template v-else-if="field.type === 'select'">
			<select
				class="h-[26px] text-xs border border-border-default rounded px-1 bg-transparent text-inherit cursor-pointer focus:outline-none focus:border-brand"
				:value="String(value)"
				@change="handleSelectChange"
				@click.stop
			>
				<option
					v-for="opt in field.options"
					:key="String(opt.value)"
					:value="String(opt.value)"
				>
					{{ opt.label }}
				</option>
			</select>
		</template>
	</div>
</template>

