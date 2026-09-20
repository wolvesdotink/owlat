import type PostHog from 'posthog-js';
import { shallowRef, watch } from 'vue';
import type { PostHogHandle } from '~/composables/usePostHog';
import { logWarn } from '~/lib/runtimeLog';

/**
 * PostHog boots only when the instance has `analytics.posthog` ON.
 *
 * A configured key is a deployment fact, not consent: on a self-hosted,
 * privacy-positioned product the admin's flag decides whether anything is
 * captured at all. So this plugin never calls `init()` at boot — it waits for
 * `analytics.posthog` to resolve true and only then loads and starts the
 * library. Nothing leaves the browser before that: no `init`, no `$pageview`,
 * no `/decide` round-trip.
 *
 * The flag arrives over a Convex subscription, which resolves after the plugin
 * has returned, so consumers are handed a `shallowRef` box rather than the
 * client itself (Nuxt's `provide` installs a non-configurable getter, and the
 * ref also lets watchers react to the client appearing). While the box is empty
 * every `usePostHog()` method is a no-op — events fired before the flag
 * resolves are DROPPED, not queued, because replaying them on opt-in would
 * capture exactly the pre-consent activity the flag exists to prevent.
 *
 * `getFeatureFlags` is a public query, so a signed-out visitor resolves the
 * flag too and a legitimately-on instance still measures its login page. When
 * the query is slow, failing, or the backend is unreachable, the resolved value
 * is the shipped default — off — and the safe outcome is the one that happens.
 */
export default defineNuxtPlugin(() => {
	const config = useRuntimeConfig();
	const apiKey = config.public.posthogApiKey as string;
	const host = config.public.posthogHost as string;

	const handle: PostHogHandle = shallowRef<typeof PostHog | null>(null);
	const provide = { posthog: handle };

	if (!apiKey) {
		if (import.meta.dev) {
			logWarn('NUXT_PUBLIC_POSTHOG_API_KEY is not set. PostHog not initialized.');
		}
		return { provide };
	}

	const { isEnabled } = useFeatureFlag();
	// Resolved before the first `await` — a composable is only callable while the
	// Nuxt instance is the current one.
	const router = useRouter();

	let client: typeof PostHog | null = null;
	let starting = false;

	async function enable() {
		if (starting) return;
		starting = true;
		try {
			if (!client) {
				// Lazily import posthog-js only when a key is configured and the flag
				// is on, so the ~193KB library is code-split out of the main chunk for
				// the default (no-key, no-flag) build.
				const { default: posthog } = await import('posthog-js');
				posthog.init(apiKey, {
					// runtimeConfig.public.posthogHost already carries the default host.
					api_host: host,
					capture_pageview: false,
					capture_pageleave: true,
					persistence: 'localStorage+cookie',
					loaded: (ph) => {
						if (import.meta.dev) {
							ph.debug();
						}
					},
				});
				client = posthog;

				// Track SPA pageviews on route change
				router.afterEach((to) => {
					handle.value?.capture('$pageview', {
						$current_url: window.location.origin + to.fullPath,
					});
				});
			}

			// A previous session's opt-out is persisted in localStorage, so re-enabling
			// the flag has to clear it explicitly. No `$opt_in` event: the flag is an
			// admin's deployment setting, not a per-visitor consent gesture worth
			// recording.
			client.opt_in_capturing({ captureEventName: false });
			handle.value = client;
		} finally {
			starting = false;
		}

		// The flag can flip back off while the dynamic import is in flight.
		if (!isEnabled('analytics.posthog')) disable();
	}

	function disable() {
		handle.value = null;
		if (!client) return;
		// Stop the automatic capture the library does on its own ($pageleave) and
		// forget the identity it stored, so a re-enable does not resume the same
		// person's timeline.
		client.opt_out_capturing();
		client.reset();
	}

	watch(
		() => isEnabled('analytics.posthog'),
		(on) => {
			if (on) void enable();
			else disable();
		},
		{ immediate: true }
	);

	return { provide };
});
