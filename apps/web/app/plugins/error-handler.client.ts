import type posthog from 'posthog-js';
import { logError } from '~/lib/runtimeLog';

/**
 * Global error handler plugin.
 * Catches unhandled Vue errors and shows toast notifications to the user.
 * Also forwards errors to PostHog Error Tracking when available.
 */
export default defineNuxtPlugin((nuxtApp) => {
	const { showToast } = useToast();

	function captureToPostHog(error: unknown, source: string) {
		const ph = nuxtApp['$posthog'] as typeof posthog | null;
		if (!ph) return;

		const err = error instanceof Error ? error : new Error(String(error));
		ph.capture('$exception', {
			$exception_message: err.message,
			$exception_type: err.name,
			$exception_stack_trace_raw: err.stack,
			$exception_source: source,
		});
	}

	// User-facing copy is intentionally generic — a raw error.message can leak
	// internals (stack frames, ids, backend phrasing) and is rarely actionable.
	// The real message/stack still goes to PostHog via captureToPostHog.
	const GENERIC_ERROR_COPY = 'Something went wrong. Please refresh and try again.';

	// Catch Vue component errors
	nuxtApp.vueApp.config.errorHandler = (error, _instance, info) => {
		showToast(GENERIC_ERROR_COPY, 'error');
		captureToPostHog(error, `vue:${info}`);

		if (import.meta.dev) {
			logError(`[Vue Error] ${info}:`, error);
		}
	};

	// Catch unhandled promise rejections
	if (import.meta.client) {
		window.addEventListener('unhandledrejection', (event) => {
			showToast(GENERIC_ERROR_COPY, 'error');
			captureToPostHog(event.reason, 'unhandledrejection');

			if (import.meta.dev) {
				logError('[Unhandled Rejection]:', event.reason);
			}
		});
	}
});
