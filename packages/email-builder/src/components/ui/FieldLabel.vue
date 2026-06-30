<script setup lang="ts">
defineProps<{
	size?: 'sm' | 'md';
}>();
</script>

<template>
	<label
		class="font-medium leading-none"
		:class="size === 'sm'
			? 'text-[10px] text-text-tertiary'
			: 'text-[12.5px] text-text-primary tracking-[-0.01em]'"
	>
		<slot />
	</label>
</template>
