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
		class="w-full py-2 px-2.5 text-caption pointer-coarse:text-base border border-border-strong rounded-lg bg-bg-surface text-text-primary outline-none eb-input-ring placeholder:text-text-tertiary"
		:value="value"
		:placeholder="placeholder"
		@input="handleInput"
	/>
</template>

