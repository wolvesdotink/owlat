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
 * a retry control; wire `@retry` to the composable's `refetch` (or, when
 * `:error` merges several reads, to a handler that refetches the failed ones).
 * A surface with nothing to refetch opts into a full page reload with
 * `reload-on-retry`; `app/__tests__/queryBoundaryRetry.lint.test.ts` fails on a
 * boundary that passes `:error` with neither. An unwired boundary still falls
 * back to the reload at runtime. The alert's copy comes from the error's
 * category (`queryErrorCopy`), never the raw message.
 *
 * Usage:
 *   <UiQueryBoundary :loading="isLoading" :error="error" :empty="(data ?? []).length === 0">
 *     <template #loading>…optional custom skeleton…</template>
 *     <template #empty><UiEmptyState … /></template>
 *     <YourContent :data="data" />
 *   </UiQueryBoundary>
 *
 * The loading branch goes through `useDelayedLoading`: a query that answers
 * within 150 ms (a warm cache, a fast backend) renders nothing in between and
 * then its content, instead of flashing the loader for a frame; a loader that
 * did appear stays up for at least 300 ms. Custom `#loading` skeletons get the
 * same treatment.
 */
import { computed, getCurrentInstance } from 'vue';
import { useDelayedLoading } from '@owlat/ui/composables/useDelayedLoading';
import { queryErrorCopy, resolveOperationCopy } from '~/lib/operationError';

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
	/**
	 * Retry reloads the page instead of emitting `retry`. Only for a surface
	 * with no read to refetch; everything else wires `@retry`.
	 */
	reloadOnRetry?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	loading: false,
	error: null,
	empty: false,
	errorTitle: undefined,
	errorMessage: undefined,
	loadingLabel: undefined,
	hideRetry: false,
	reloadOnRetry: false,
});

const { t, te, locale } = useI18n();

const showLoading = useDelayedLoading(() => props.loading);

/**
 * `pending` is the grace period: still loading, loader not shown yet. It
 * renders nothing, which beats both a one-frame spinner and the empty state a
 * not-yet-loaded list would otherwise claim.
 */
const state = computed<'error' | 'loading' | 'pending' | 'empty' | 'content'>(() => {
	if (props.error) return 'error';
	if (showLoading.value) return 'loading';
	if (props.loading) return 'pending';
	return props.empty ? 'empty' : 'content';
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

const displayTitle = computed(
	() => props.errorTitle ?? t('components.ui.queryBoundary.errorTitle')
);
const displayLoadingLabel = computed(
	() => props.loadingLabel ?? t('components.ui.queryBoundary.loadingLabel')
);
// The raw Convex message ("[CONVEX Q(…)] [Request ID: …] Server Error …") is
// not user copy: map the failure onto the ADR-0036 vocabulary instead.
const displayMessage = computed(() => {
	if (props.errorMessage) return props.errorMessage;
	const copy = queryErrorCopy(props.error, 'components.ui.queryBoundary.errorMessage', {
		locale: locale.value,
		hasMessage: (key) => te(key),
	});
	return resolveOperationCopy(copy, t);
});

function handleRetry() {
	if (hasRetryListener.value && !props.reloadOnRetry) {
		emit('retry');
	} else if (typeof window !== 'undefined') {
		window.location.reload();
	}
}
</script>

<template>
	<!-- Error takes precedence: a faulted query may still have stale data/empty. -->
	<slot v-if="state === 'error'" name="error" :error="error" :retry="handleRetry">
		<div class="flex flex-col items-center gap-4 py-12 px-6">
			<div class="w-full max-w-md">
				<UiErrorAlert :title="displayTitle" :message="displayMessage" variant="error" />
			</div>
			<UiButton v-if="!hideRetry" variant="secondary" size="sm" @click="handleRetry">
				<template #iconLeft><Icon name="lucide:refresh-cw" class="w-4 h-4" /></template>
				{{ t('components.ui.queryBoundary.tryAgain') }}
			</UiButton>
		</div>
	</slot>

	<slot v-else-if="state === 'loading'" name="loading">
		<div class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">{{ displayLoadingLabel }}</p>
			</div>
		</div>
	</slot>

	<slot v-else-if="state === 'empty'" name="empty">
		<UiEmptyState
			icon="lucide:inbox"
			:title="t('components.ui.queryBoundary.emptyTitle')"
			:description="t('components.ui.queryBoundary.emptyDescription')"
		/>
	</slot>

	<slot v-else-if="state === 'content'" />
</template>
