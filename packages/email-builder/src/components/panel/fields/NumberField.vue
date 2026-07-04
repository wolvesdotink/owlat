<script setup lang="ts">
import { computed } from 'vue';
import { Minus, Plus } from '@lucide/vue';

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

const effectiveStep = computed(() => props.step ?? 1);

function handleInput(event: Event) {
	const val = parseFloat((event.target as HTMLInputElement).value);
	if (!isNaN(val)) emit('update', clamp(val));
}

function increment() {
	emit('update', clamp(props.value + effectiveStep.value));
}

function decrement() {
	emit('update', clamp(props.value - effectiveStep.value));
}

function clamp(val: number): number {
	if (props.min !== undefined && val < props.min) return props.min;
	if (props.max !== undefined && val > props.max) return props.max;
	return val;
}
</script>

<template>
	<div class="group flex items-center border border-border-subtle rounded-lg bg-bg-surface min-w-[120px] eb-input-ring">
		<button
			class="flex items-center justify-center w-[30px] h-8 border-none bg-transparent text-text-disabled cursor-pointer shrink-0 transition-[background-color,color] duration-(--motion-fast) hover:not-disabled:bg-bg-surface-hover hover:not-disabled:text-text-secondary active:not-disabled:bg-bg-overlay disabled:opacity-25 disabled:cursor-not-allowed"
			type="button"
			tabindex="-1"
			:disabled="min !== undefined && value <= min"
			@click="decrement"
		>
			<Minus :size="12" />
		</button>
		<input
			type="number"
			class="flex-1 w-0 min-w-[2.5rem] py-1.5 px-0 text-[13px] font-medium tabular-nums text-center border-none bg-transparent text-text-primary outline-none appearance-number-plain"
			:value="value"
			:min="min"
			:max="max"
			:step="effectiveStep"
			@input="handleInput"
		/>
		<div v-if="unit" class="text-[11px] font-medium text-text-tertiary pr-0.5 select-none tracking-[0.02em]">{{ unit }}</div>
		<button
			class="flex items-center justify-center w-[30px] h-8 border-none bg-transparent text-text-disabled cursor-pointer shrink-0 transition-[background-color,color] duration-(--motion-fast) hover:not-disabled:bg-bg-surface-hover hover:not-disabled:text-text-secondary active:not-disabled:bg-bg-overlay disabled:opacity-25 disabled:cursor-not-allowed"
			type="button"
			tabindex="-1"
			:disabled="max !== undefined && value >= max"
			@click="increment"
		>
			<Plus :size="12" />
		</button>
	</div>
</template>

