import type posthog from 'posthog-js';

/**
 * Composable for PostHog analytics.
 * Returns safe no-op methods when PostHog isn't initialized.
 */
export function usePostHog() {
	const nuxtApp = useNuxtApp();

	function getInstance(): typeof posthog | null {
		return (nuxtApp.$posthog as typeof posthog | null) ?? null;
	}

	function capture(event: string, properties?: Record<string, unknown>) {
		getInstance()?.capture(event, properties);
	}

	function identify(userId: string, traits?: Record<string, unknown>) {
		getInstance()?.identify(userId, traits);
	}

	function setOrganization(orgId: string, traits?: Record<string, unknown>) {
		getInstance()?.group('organization', orgId, traits);
	}

	function reset() {
		getInstance()?.reset();
	}

	function captureError(error: unknown, context?: Record<string, unknown>) {
		const ph = getInstance();
		if (!ph) return;

		const err = error instanceof Error ? error : new Error(String(error));
		ph.capture('$exception', {
			$exception_message: err.message,
			$exception_type: err.name,
			$exception_stack_trace_raw: err.stack,
			...context,
		});
	}

	return {
		getInstance,
		capture,
		identify,
		setOrganization,
		reset,
		captureError,
	};
}
