<script setup lang="ts">
defineProps<{
	size?: 'sm' | 'md';
}>();
</script>

<template>
	<label
		class="font-medium leading-none"
		:class="size === 'sm'
			? 'text-2xs text-text-tertiary'
			: 'text-caption text-text-primary tracking-[-0.01em]'"
	>
		<slot />
	</label>
</template>
