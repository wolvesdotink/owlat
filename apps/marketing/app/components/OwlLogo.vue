<script setup lang="ts">
defineProps<{
	size?: string;
}>();
</script>

<template>
	<div
		class="shrink-0"
		:style="{
			width: size || '72px',
			height: size || '72px',
			background: 'linear-gradient(135deg, var(--color-brand) 20%, var(--color-accent) 80%)',
			WebkitMask: 'url(/logo.svg) no-repeat center / contain',
			mask: 'url(/logo.svg) no-repeat center / contain',
		}"
		aria-hidden="true"
	/>
</template>
