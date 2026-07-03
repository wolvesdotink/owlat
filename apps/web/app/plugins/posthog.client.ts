import type PostHog from 'posthog-js';
import { logWarn } from '~/lib/runtimeLog';

export default defineNuxtPlugin(async (_nuxtApp) => {
	const config = useRuntimeConfig();
	const apiKey = config.public.posthogApiKey as string;
	const host = config.public.posthogHost as string;

	if (!apiKey) {
		if (import.meta.dev) {
			logWarn('NUXT_PUBLIC_POSTHOG_API_KEY is not set. PostHog not initialized.');
		}
		return {
			provide: {
				posthog: null as typeof PostHog | null,
			},
		};
	}

	// Lazily import posthog-js only when a key is configured, so the ~193KB
	// library is code-split out of the main chunk for the default (no-key) build.
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

	// Track SPA pageviews on route change
	const router = useRouter();
	router.afterEach((to) => {
		posthog.capture('$pageview', {
			$current_url: window.location.origin + to.fullPath,
		});
	});

	return {
		provide: {
			posthog: posthog as typeof posthog | null,
		},
	};
});
