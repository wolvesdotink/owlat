import { logError } from '~/lib/runtimeLog';
import type { ClientErrorReporter, ClientErrorReporterKey } from '~/lib/clientErrorReporter';
import type { PostHogHandle } from '~/composables/usePostHog';

/**
 * Global error handler plugin.
 * Catches unhandled Vue errors and promise rejections, shows one generic error
 * toast for them, and forwards every one to PostHog Error Tracking when it is
 * available. Render failures inside a pane boundary (AppErrorBoundary) never
 * get here: the boundary shows its own fallback and reports them through the
 * reporter provided below, without a toast.
 */

// User-facing copy is intentionally generic — a raw error.message can leak
// internals (stack frames, ids, backend phrasing) and is rarely actionable.
// The real message/stack still goes to PostHog via captureToPostHog.
const GENERIC_ERROR_KEY = 'shell.error.toast';
// Only for an error raised before the catalog has loaded: a key path means
// nothing to a reader, the English sentence at least says what happened.
const GENERIC_ERROR_BEFORE_I18N = 'Something went wrong. Please refresh and try again.';

// One failure tends to arrive as a burst (a render error retried by every
// re-render, the same rejection from several subscribers). Repeats collapse
// into the toast already showing, and for this long after one was shown.
const REPEAT_WINDOW_MS = 3000;

interface MessageResolver {
	t: (key: string) => string;
	te: (key: string) => boolean;
}

export default defineNuxtPlugin((nuxtApp) => {
	const { showToast } = useToast();

	function captureToPostHog(error: unknown, source: string) {
		// Empty until `analytics.posthog` resolves on, and again once it is turned
		// off — an exception raised in between is logged locally and not shipped.
		const ph = (nuxtApp['$posthog'] as PostHogHandle | null)?.value ?? null;
		if (!ph) return;

		const err = error instanceof Error ? error : new Error(String(error));
		ph.capture('$exception', {
			$exception_message: err.message,
			$exception_type: err.name,
			$exception_stack_trace_raw: err.stack,
			$exception_source: source,
		});
	}

	// Resolved per toast, not once: this plugin can run before @nuxtjs/i18n has
	// its messages, and the copy must follow a later language switch.
	function genericErrorCopy(): string {
		const i18n = nuxtApp['$i18n'] as Partial<MessageResolver> | undefined;
		if (typeof i18n?.t !== 'function' || typeof i18n.te !== 'function') {
			return GENERIC_ERROR_BEFORE_I18N;
		}
		return i18n.te(GENERIC_ERROR_KEY) ? i18n.t(GENERIC_ERROR_KEY) : GENERIC_ERROR_BEFORE_I18N;
	}

	let toastOnScreen = false;
	let lastToastAt = Number.NEGATIVE_INFINITY;

	function notify() {
		const now = Date.now();
		if (toastOnScreen || now - lastToastAt < REPEAT_WINDOW_MS) return;
		toastOnScreen = true;
		lastToastAt = now;
		showToast(genericErrorCopy(), 'error', {
			onDismiss: () => {
				toastOnScreen = false;
			},
		});
	}

	function report(error: unknown, source: string) {
		captureToPostHog(error, source);
		if (import.meta.dev) logError(`[${source}]:`, error);
	}

	// Catch Vue component errors
	nuxtApp.vueApp.config.errorHandler = (error, _instance, info) => {
		notify();
		report(error, `vue:${info}`);
	};

	// Catch unhandled promise rejections. The `.client` suffix already keeps this
	// plugin out of the server bundle.
	window.addEventListener('unhandledrejection', (event) => {
		notify();
		report(event.reason, 'unhandledrejection');
	});

	// Failures a pane boundary already shows: diagnostics only, no toast.
	nuxtApp.vueApp.provide(
		'owlat:client-error-reporter' satisfies ClientErrorReporterKey,
		report satisfies ClientErrorReporter
	);
});
