<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
	value: number;
	min?: number;
	max?: number;
	step?: number;
	unit?: string;
}>();

const emit = defineEmits<{
	(e: 'update', value: number): void;
}>();

const effectiveMin = computed(() => props.min ?? 0);
const effectiveMax = computed(() => props.max ?? 100);

const fillPercent = computed(() => {
	const range = effectiveMax.value - effectiveMin.value;
	if (range <= 0) return 0;
	return ((props.value - effectiveMin.value) / range) * 100;
});

function handleInput(event: Event) {
	const val = parseFloat((event.target as HTMLInputElement).value);
	if (!isNaN(val)) emit('update', val);
}
</script>

<template>
	<div class="flex items-center gap-2.5 min-h-8">
		<input
			type="range"
			class="flex-1 slider-thumb-brand"
			:value="value"
			:min="effectiveMin"
			:max="effectiveMax"
			:step="step ?? 1"
			:style="{ '--fill': fillPercent + '%' }"
			@input="handleInput"
		/>
		<span class="text-xs font-semibold tabular-nums text-text-primary min-w-10 text-right whitespace-nowrap tracking-[-0.01em]">{{ value }}{{ unit ?? '' }}</span>
	</div>
</template>

