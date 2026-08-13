<script setup lang="ts">
import { GripVertical } from '@lucide/vue';

defineProps<{
	visible: boolean;
}>();
</script>

<template>
	<!--
		Pointer-only grip: it is not focusable, and keyboard users reorder with
		Alt+Arrow, so it stays out of the accessibility tree rather than adding an
		unnamed control to every block in the canvas list.
	-->
	<div
		aria-hidden="true"
		:class="[
			'absolute top-1/2 -left-7 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded text-text-tertiary cursor-grab z-[5] transition-opacity duration-(--motion-fast) active:cursor-grabbing drag-handle',
			visible ? 'opacity-100' : 'opacity-0 group-hover/block:opacity-100',
		]"
	>
		<GripVertical :size="14" />
	</div>
</template>
