import type PostHog from 'posthog-js';
import { shallowRef, watch } from 'vue';
import type { PostHogHandle } from '~/composables/usePostHog';
import {
	armPerfReporting,
	landingRoute,
	noteViewSettled,
	reportPerf,
	setPerfSender,
} from '~/lib/perfTelemetry';
import {
	isPrivateRouteName,
	sanitizeAnalyticsEvent,
	routePattern,
	type ResolvedRoute,
} from '~/lib/analyticsPrivacy';
import { logWarn } from '~/lib/runtimeLog';
import { observeWebVitals } from '~/lib/webVitals';

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
 *
 * Performance samples (web vitals and the `usePerfMark` timings) ride the same
 * gate: collected only when a key is configured, sent only through the running
 * client. Their own properties are route names, never URLs. See
 * `lib/perfTelemetry`.
 *
 * What an event may say about the page is settled once, at the SDK boundary:
 * every event passes `sanitizeAnalyticsEvent` as `before_send`, which reduces
 * each URL the SDK or the app attached to a route pattern and drops events from
 * the pages that handle a credential. The SDK is not even started on those
 * pages; it starts on the next ordinary one. See `lib/analyticsPrivacy`.
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

	startPerfReporting(router, handle);

	let client: typeof PostHog | null = null;
	let starting = false;
	/** The flag was on but the SDK waited for the visitor to leave a private page. */
	let deferred = false;

	function routeOf(pathname: string): ResolvedRoute | null {
		try {
			const location = router.resolve(pathname);
			const record = location.matched[location.matched.length - 1];
			if (!record) return null;
			return {
				name: routeLabel(location.name),
				pattern: routePattern(record.path, location.params),
			};
		} catch {
			return null;
		}
	}

	/** Read from the address bar: the router may not have settled at boot. */
	function onPrivatePage(): boolean {
		return isPrivateRouteName(routeOf(window.location.pathname)?.name);
	}

	// Pageviews come from here because `capture_pageview` is off, and a start
	// deferred on a private page happens on the first navigation away from it.
	router.afterEach((to, _from, failure) => {
		if (failure) return;
		if (!client) {
			if (deferred && isEnabled('analytics.posthog')) void enable();
			return;
		}
		handle.value?.capture('$pageview', { route: routeLabel(to.name) });
	});

	async function enable() {
		if (starting) return;
		starting = true;
		try {
			if (!client) {
				// Starting the SDK records the entry URL into its persistence, so a
				// credential-bearing page does not get to be the entry.
				deferred = onPrivatePage();
				if (deferred) return;
				// Lazily import posthog-js only when a key is configured and the flag
				// is on, so the ~193KB library is code-split out of the main chunk for
				// the default (no-key, no-flag) build.
				const { default: posthog } = await import('posthog-js');
				// Loading yields: revocation must win before init can make requests.
				if (!isEnabled('analytics.posthog')) return;
				deferred = onPrivatePage();
				if (deferred) return;
				posthog.init(apiKey, {
					// runtimeConfig.public.posthogHost already carries the default host.
					api_host: host,
					capture_pageview: false,
					// Time on page is route-level analytics; the leave event carries the
					// same URL properties as any other and goes through before_send.
					capture_pageleave: true,
					persistence: 'localStorage+cookie',
					before_send: (event) =>
						sanitizeAnalyticsEvent(event, { base: window.location.href, routeOf }),
					// The /flags request sends the stored person-initial properties (the
					// entry URL and referrer) without passing before_send, and this app
					// evaluates its feature flags in Convex, not PostHog. Also keeps the
					// project's remote settings from switching on the features below.
					advanced_disable_flags: true,
					// Replay records the DOM (message bodies, link targets) and heatmaps
					// key their payload by raw page URL; neither is used here.
					disable_session_recording: true,
					enable_heatmaps: false,
					// PostHog's own web vitals and network timings carry per-request URLs;
					// `lib/webVitals` already reports vitals labelled by route name.
					capture_performance: false,
					// Fragments never identify a route in this app.
					disable_capture_url_hashes: true,
					// Element text and these attributes in a mail client are subjects,
					// addresses and file names. Clicks still report element, classes and
					// the link's route (href is kept and reduced by before_send).
					mask_all_text: true,
					autocapture: {
						element_attribute_ignorelist: [
							'value',
							'title',
							'alt',
							'aria-label',
							'placeholder',
							'src',
							'srcset',
							'action',
							'formaction',
						],
					},
					// The referring origin is legitimate attribution; before_send
					// reduces the referrer itself to that origin.
					save_referrer: true,
					loaded: (ph) => {
						if (import.meta.dev) {
							ph.debug();
						}
					},
				});
				client = posthog;
			}

			// A previous session's opt-out is persisted in localStorage, so re-enabling
			// the flag has to clear it explicitly. No `$opt_in` event: the flag is an
			// admin's deployment setting, not a per-visitor consent gesture worth
			// recording.
			client.opt_in_capturing({ captureEventName: false });
			handle.value = client;
		} catch {
			disable();
			logWarn('PostHog could not be initialized.');
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

/** Route name of a location, never its path: names carry no ids or addresses. */
function routeLabel(name: unknown): string {
	return typeof name === 'string' && name ? name : 'unknown';
}

function startPerfReporting(router: ReturnType<typeof useRouter>, handle: PostHogHandle) {
	armPerfReporting({ currentRoute: () => routeLabel(router.currentRoute.value.name) });
	router.afterEach((to, _from, failure) => {
		if (!failure) noteViewSettled(routeLabel(to.name));
	});
	observeWebVitals((vitals) =>
		reportPerf('owlat_web_vitals', { ...vitals, landing_route: landingRoute() })
	);
	// The box fills when the client is running and the flag is on, and empties
	// when the flag flips off; the samples follow it.
	watch(handle, (client) => {
		setPerfSender(client ? (event, properties) => client.capture(event, properties) : null);
	});
}
