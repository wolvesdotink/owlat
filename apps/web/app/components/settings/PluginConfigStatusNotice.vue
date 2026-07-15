<script setup lang="ts">
defineProps<{
	isLoading: boolean;
	errorMessage?: string;
}>();

defineEmits<{ retry: [] }>();
</script>

<template>
	<div
		v-if="isLoading"
		data-testid="plugin-config-status-loading"
		class="px-6 py-3 bg-bg-surface border-b border-border-subtle text-sm text-text-secondary"
	>
		Checking plugin environment and capability approvals… Disabling remains available.
	</div>
	<div
		v-else-if="errorMessage"
		data-testid="plugin-config-status-error"
		class="px-6 py-3 bg-error/5 border-b border-border-subtle flex items-center justify-between gap-3"
	>
		<p class="text-sm text-error">
			Plugin configuration check failed: {{ errorMessage }} Disabling remains available.
		</p>
		<UiButton
			size="sm"
			variant="secondary"
			data-testid="retry-plugin-config"
			@click="$emit('retry')"
		>
			Retry
		</UiButton>
	</div>
</template>
