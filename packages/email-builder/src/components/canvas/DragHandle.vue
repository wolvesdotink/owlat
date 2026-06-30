<script setup lang="ts">
import { GripVertical } from '@lucide/vue';

defineProps<{
	visible: boolean;
}>();
</script>

<template>
	<div
		:class="[
			'absolute top-1/2 -left-7 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded text-text-tertiary cursor-grab z-[5] transition-opacity duration-150 active:cursor-grabbing drag-handle',
			visible ? 'opacity-100' : 'opacity-0 group-hover/block:opacity-100',
		]"
	>
		<GripVertical :size="14" />
	</div>
</template>
