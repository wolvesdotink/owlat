<script setup lang="ts">
const { t } = useI18n();

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
		{{ t('components.settings.pluginConfigStatusNotice.checking') }}
	</div>
	<div
		v-else-if="errorMessage"
		data-testid="plugin-config-status-error"
		class="px-6 py-3 bg-error/5 border-b border-border-subtle flex items-center justify-between gap-3"
	>
		<p class="text-sm text-error">
			{{ t('components.settings.pluginConfigStatusNotice.failed', { message: errorMessage }) }}
		</p>
		<UiButton
			size="sm"
			variant="secondary"
			data-testid="retry-plugin-config"
			@click="$emit('retry')"
		>
			{{ t('common.retry') }}
		</UiButton>
	</div>
</template>
