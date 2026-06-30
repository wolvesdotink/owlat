<script setup lang="ts">
/**
 * ErrorBoundary — catches errors from child components and displays a fallback UI.
 * Uses Vue's onErrorCaptured lifecycle hook.
 *
 * Usage:
 *   <UiErrorBoundary>
 *     <YourComponent />
 *   </UiErrorBoundary>
 */

const props = withDefaults(
	defineProps<{
		/** Custom fallback message */
		fallbackMessage?: string;
		/** Whether to show a retry button */
		showRetry?: boolean;
	}>(),
	{
		fallbackMessage: 'Something went wrong. Please try again.',
		showRetry: true,
	}
);

const error = ref<Error | null>(null);
const errorInfo = ref<string>('');

onErrorCaptured((err: Error, _instance, info: string) => {
	error.value = err;
	errorInfo.value = info;
	// Return false to stop propagation to parent error handlers
	return false;
});

function handleRetry() {
	error.value = null;
	errorInfo.value = '';
}
</script>

<template>
	<slot v-if="!error" />
	<div v-else class="p-6 border border-error/20 bg-error/5 rounded-lg text-center">
		<div class="flex flex-col items-center gap-3">
			<Icon name="lucide:alert-circle" class="w-8 h-8 text-error" />
			<p class="text-sm text-text-secondary">{{ fallbackMessage }}</p>
			<button
				v-if="showRetry"
				class="px-4 py-1.5 text-sm font-medium bg-bg-elevated border border-border-default rounded-md hover:bg-bg-base transition-colors"
				@click="handleRetry"
			>
				Try again
			</button>
		</div>
	</div>
</template>
