<script setup lang="ts">

defineProps<{
	value: string;
	placeholder?: string;
	type?: 'text' | 'url';
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
		class="w-full py-2 px-2.5 text-[13px] border border-border-subtle rounded-lg bg-bg-surface text-text-primary outline-none eb-input-ring placeholder:text-text-disabled"
		:value="value"
		:placeholder="placeholder"
		@input="handleInput"
	/>
</template>

