<script setup lang="ts">
const props = defineProps<{
	value: number;
	min?: number;
	max?: number;
}>();

const emit = defineEmits<{
	(e: 'update', value: number): void;
}>();

function handleInput(event: Event) {
	const val = parseInt((event.target as HTMLInputElement).value) || 0;
	const clamped = Math.max(props.min ?? -Infinity, Math.min(props.max ?? Infinity, val));
	emit('update', clamped);
}
</script>

<template>
	<input
		type="number"
		class="w-12 py-[3px] px-0.5 text-xs tabular-nums text-center border-none border-b border-b-transparent bg-transparent text-text-primary outline-none appearance-number-plain transition-[border-color] duration-150 hover:border-b-border-default focus:border-b-brand"
		:value="value"
		:min="min"
		:max="max"
		@input="handleInput"
	/>
</template>
