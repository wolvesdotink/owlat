<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
	label: string;
}>();

const displayText = computed(() => `{{${props.label}}}`);
</script>

<template>
	<span
		class="inline-flex items-center rounded-md border border-border-subtle bg-bg-surface px-2 py-0.5 text-[11px] font-medium text-text-secondary"
	>
		<span
			class="mr-1 inline-flex h-4 w-4 items-center justify-center rounded bg-brand/15 text-[10px] text-brand"
		>
			{}
		</span>
		{{ displayText }}
	</span>
</template>
