<script setup lang="ts">

defineProps<{
	value: string;
	placeholder?: string;
	type?: 'text' | 'url';
	/** Names the input for assistive tech; the visible label sits outside this component. */
	label?: string;
}>();

const emit = defineEmits<{
	(e: 'update', value: string): void;
}>();

function handleInput(event: Event) {
	emit('update', (event.target as HTMLInputElement).value);
}
</script>

<template>
	<input
		:type="type ?? 'text'"
		:aria-label="label"
		class="w-full py-2 px-2.5 text-[13px] border border-border-subtle rounded-lg bg-bg-surface text-text-primary outline-none eb-input-ring placeholder:text-text-disabled"
		:value="value"
		:placeholder="placeholder"
		@input="handleInput"
	/>
</template>

