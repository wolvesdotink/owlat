<script setup lang="ts">
/**
 * ErrorBoundary — keeps a failure inside the part of the page that failed. When
 * a component in the slot throws, the slot is replaced by a fallback with Retry
 * and the error stops here, so the rest of the page keeps working.
 *
 * Usage:
 *   <UiErrorBoundary :reset-keys="[messageId]">
 *     <YourComponent />
 *   </UiErrorBoundary>
 *
 * - `resetKeys`: a failed boundary renders its slot again once any key changes,
 *   so selecting another message recovers without a Retry. Keys are compared by
 *   value (`Object.is` per entry), never by array identity: a parent passing a
 *   fresh `[id]` literal on every render must not clear a failure.
 * - `capture`: which captured errors this boundary contains. Declined errors
 *   keep propagating to outer boundaries and the app's error handler.
 * - `#fallback="{ error, retry }"` replaces the default fallback markup.
 *
 * The boundary must sit around the component that may fail: a component cannot
 * catch its own setup or render failure.
 */
import { computed, onErrorCaptured, ref, watch } from 'vue';
import { useUiI18n } from '../../composables/useUiI18n';

// `fallbackMessage` has no default: prop defaults are evaluated outside the
// setup context, where `useUiI18n()` cannot run. It is resolved below instead.
const props = withDefaults(
	defineProps<{
		/** Custom fallback message. Defaults to the localized copy. */
		fallbackMessage?: string;
		/** A second, quieter line under the message. */
		fallbackDetail?: string;
		/** Whether to show a retry button */
		showRetry?: boolean;
		/** Values whose change clears a captured failure. */
		resetKeys?: readonly unknown[];
		/** Return false to let an error pass through. Default: contain every error. */
		capture?: (error: unknown, info: string) => boolean;
		/** Names the boundary in the console line a captured error writes. */
		name?: string;
	}>(),
	{
		fallbackMessage: undefined,
		fallbackDetail: undefined,
		showRetry: true,
		resetKeys: undefined,
		capture: undefined,
		name: undefined,
	}
);

const emit = defineEmits<{
	/** A failure was contained (after it was logged). */
	captured: [error: unknown, info: string];
}>();

defineSlots<{
	default?: () => unknown;
	fallback?: (scope: { error: unknown; retry: () => void }) => unknown;
}>();

const { t } = useUiI18n();

const message = computed(() => props.fallbackMessage ?? t('ui.errorBoundary.message'));

// Boxed so a thrown `null` / `undefined` still counts as a failure.
const failure = ref<{ error: unknown } | null>(null);

onErrorCaptured((err: unknown, _instance, info: string) => {
	if (props.capture && !props.capture(err, info)) return;
	failure.value = { error: err };
	// Surface the error for debugging — the fallback UI hides it otherwise.
	console.error(`[ErrorBoundary${props.name ? `:${props.name}` : ''}] captured (${info}):`, err);
	emit('captured', err, info);
	// Return false to stop propagation to parent error handlers
	return false;
});

function sameKeys(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	return a.every((key, index) => Object.is(key, b[index]));
}

// Runs before the boundary re-renders, so content that fails again under the
// new keys is caught by that render rather than cleared by this watcher.
watch(
	() => props.resetKeys,
	(next, previous) => {
		if (failure.value && !sameKeys(previous, next)) failure.value = null;
	}
);

function retry() {
	failure.value = null;
}
</script>

<template>
	<slot v-if="!failure" />
	<slot v-else name="fallback" :error="failure.error" :retry="retry">
		<div role="alert" class="p-6 border border-error/20 bg-error/5 rounded-lg text-center">
			<div class="flex flex-col items-center gap-3">
				<Icon name="lucide:alert-circle" class="w-8 h-8 text-error" />
				<p class="text-sm text-text-secondary">{{ message }}</p>
				<p v-if="fallbackDetail" class="text-xs text-text-tertiary">{{ fallbackDetail }}</p>
				<button
					v-if="showRetry"
					type="button"
					class="px-4 py-1.5 text-sm font-medium bg-bg-elevated border border-border-default rounded-md hover:bg-bg-base transition-colors"
					@click="retry"
				>
					{{ t('ui.actions.retry') }}
				</button>
			</div>
		</div>
	</slot>
</template>
