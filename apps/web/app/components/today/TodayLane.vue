<script setup lang="ts">
/**
 * One Workbench lane: a heading with its count, a one-line hint saying what
 * belongs here, and the lane's bands below.
 */
defineProps<{ id: string; title: string; hint: string; count: number }>();
</script>

<template>
	<section :aria-labelledby="id">
		<h2 :id="id" class="flex items-baseline gap-2">
			<span class="text-base font-medium text-text-primary">{{ title }}</span>
			<span v-if="count > 0" class="text-sm tabular-nums text-text-tertiary">{{ count }}</span>
		</h2>
		<p class="mb-4 mt-0.5 text-xs text-text-tertiary">{{ hint }}</p>
		<slot />
	</section>
</template>
