<script setup lang="ts">
/**
 * QueryBoundary — the shared loading / error / empty / content state machine
 * for any of the query composables (`useConvexQuery`, `useOrganizationQuery`,
 * `usePaginatedQuery`, or the higher-level wrappers that re-expose `isLoading`
 * and an optional `error`).
 *
 * Those composables deliver query faults (backend throw, permission denial, or
 * the 10s subscription timeout) into a local `error` ref and never re-throw, so
 * the global error handler never sees them. Without this boundary a faulted
 * query renders either an infinite-feeling spinner or a misleading empty state.
 *
 * Pass the destructured `isLoading` / `error` straight through, plus an `empty`
 * predicate for the no-data case. The `error` branch renders `UiErrorAlert` with
 * a retry control; wire `@retry` to a refetch, or leave it unwired and the
 * boundary falls back to reloading the page.
 *
 * Usage:
 *   <UiQueryBoundary :loading="isLoading" :error="error" :empty="(data ?? []).length === 0">
 *     <template #loading>…optional custom skeleton…</template>
 *     <template #empty><UiEmptyState … /></template>
 *     <YourContent :data="data" />
 *   </UiQueryBoundary>
 */
import { computed, getCurrentInstance } from 'vue';

interface Props {
	/** Truthy while the underlying query has not delivered its first result. */
	loading?: boolean;
	/** The query composable's `error` ref value (null when healthy). */
	error?: Error | null;
	/** True when the query resolved but produced no rows to show. */
	empty?: boolean;
	/** Heading for the default error alert. */
	errorTitle?: string;
	/** Override copy for the default error alert (otherwise derived from `error`). */
	errorMessage?: string;
	/** Label under the spinner in the default loading slot. */
	loadingLabel?: string;
	/** Hide the retry control on the default error state. */
	hideRetry?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	loading: false,
	error: null,
	empty: false,
	errorTitle: 'Failed to load',
	errorMessage: undefined,
	loadingLabel: 'Loading…',
	hideRetry: false,
});

const emit = defineEmits<{
	/** Fired when the user clicks retry. Unwired → falls back to a page reload. */
	retry: [];
}>();

// Captured during setup — getCurrentInstance() returns null once called from an
// event handler (the instance is no longer active), which would make retry
// wrongly fall back to a page reload even when the caller wired `@retry`.
const instance = getCurrentInstance();
const hasRetryListener = computed(() => !!instance?.vnode.props?.['onRetry']);

const displayMessage = computed(
	() =>
		props.errorMessage ?? props.error?.message ?? 'Something went wrong while loading this view.'
);

function handleRetry() {
	if (hasRetryListener.value) {
		emit('retry');
	} else if (typeof window !== 'undefined') {
		window.location.reload();
	}
}
</script>

<template>
	<!-- Error takes precedence: a faulted query may still have stale data/empty. -->
	<slot v-if="error" name="error" :error="error" :retry="handleRetry">
		<div class="flex flex-col items-center gap-4 py-12 px-6">
			<div class="w-full max-w-md">
				<UiErrorAlert :title="errorTitle" :message="displayMessage" variant="error" />
			</div>
			<UiButton v-if="!hideRetry" variant="secondary" size="sm" @click="handleRetry">
				<template #iconLeft><Icon name="lucide:refresh-cw" class="w-4 h-4" /></template>
				Try again
			</UiButton>
		</div>
	</slot>

	<slot v-else-if="loading" name="loading">
		<div class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">{{ loadingLabel }}</p>
			</div>
		</div>
	</slot>

	<slot v-else-if="empty" name="empty">
		<UiEmptyState
			icon="lucide:inbox"
			title="Nothing to show"
			description="There's no data to display yet."
		/>
	</slot>

	<slot v-else />
</template>
