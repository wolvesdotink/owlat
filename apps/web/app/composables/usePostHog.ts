import type posthog from 'posthog-js';
import type { ShallowRef } from 'vue';

/**
 * The box `plugins/posthog.client.ts` provides as `$posthog`.
 *
 * It holds the client only while `analytics.posthog` is on: the plugin fills it
 * once the flag resolves true and empties it when the flag flips off, so a
 * reactive reader re-runs on both edges and every method below falls back to a
 * no-op in between.
 */
export type PostHogHandle = ShallowRef<typeof posthog | null>;

/**
 * Composable for PostHog analytics.
 * Returns safe no-op methods when PostHog isn't initialized.
 */
export function usePostHog() {
	const nuxtApp = useNuxtApp();

	function getInstance(): typeof posthog | null {
		return (nuxtApp.$posthog as PostHogHandle | null)?.value ?? null;
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
