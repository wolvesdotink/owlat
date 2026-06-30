<script setup lang="ts">
import { CheckCircle } from '@lucide/vue';

defineProps<{
	/** Show the success check icon (e.g. "no issues found"). */
	success?: boolean;
}>();
</script>

<template>
	<div class="ep-analysis-empty">
		<CheckCircle v-if="success" class="ep-analysis-empty-icon" />
		<slot />
	</div>
</template>

<style scoped>
.ep-analysis-empty {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 16px 0;
	font-size: 12px;
	color: var(--ep-text-tertiary);
}

.ep-analysis-empty-icon {
	width: 14px;
	height: 14px;
	color: var(--ep-success);
}
</style>
