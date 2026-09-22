import type { FunctionArgs, FunctionReference } from 'convex/server';
import { computed, watch } from 'vue';
import { useConvexQuery, type ArgsOrFactory, type ConvexQueryResult } from './useConvexQuery';
import {
	categoryTreatment,
	normalizeToOperationError,
	operationCopy,
	resolveOperationCopy,
} from '~/lib/operationError';

/** Read counterpart to useBackendOperation. Render errorMessage in UiQueryBoundary. */
export function useBackendQuery<Query extends FunctionReference<'query'>>(
	query: Query,
	args: ArgsOrFactory<FunctionArgs<Query>>,
	options?: { timeout?: number; keepPreviousData?: boolean }
) {
	return useBackendQueryState(useConvexQuery(query, args, options));
}

/** Adapt a session-gated query without changing its subscription or auth lifecycle. */
export function useBackendQueryState<T>(query: ConvexQueryResult<T>) {
	const { t, locale, te } = useI18n();
	const posthog = usePostHog();
	const operationError = computed(() =>
		query.error.value ? normalizeToOperationError(query.error.value) : null
	);
	const errorMessage = computed(() => {
		const error = operationError.value;
		return error
			? resolveOperationCopy(
					operationCopy(error, { locale: locale.value, hasMessage: (key) => te(key) }),
					t
				)
			: undefined;
	});
	// Copy remains reactive to locale changes; reporting/redirects run only when
	// the underlying error changes, never as a side effect of rendering it.
	watch(
		query.error,
		(error) => {
			if (!error) return;
			const operation = normalizeToOperationError(error);
			const treatment = categoryTreatment(operation.category);
			if (treatment.report)
				posthog.captureError(error, {
					$exception_source: 'backend_query',
					error_category: operation.category,
				});
			if (treatment.surface === 'redirect') void navigateTo('/auth/login');
		},
		{ immediate: true }
	);
	return { ...query, operationError, errorMessage };
}
