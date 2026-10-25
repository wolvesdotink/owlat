import { readLocalPerfTraceLimit } from '~/lib/localPerfTraceOptIn';

/**
 * The opt-in local performance trace (see `lib/localPerfTrace`).
 *
 * Off by default and decided once per page load: unless this browser has
 * `localStorage['owlat:perf-trace']` set, the plugin returns before it creates
 * anything, and a report keeps costing what it did before. When it is set,
 * every `lib/perfTelemetry` sample also lands in a bounded in-memory buffer,
 * with long tasks and the shared subscription counts beside it, and the
 * console gets `owlatPerfTrace` to export, download or clear it. This works
 * with or without PostHog and never sends anything.
 *
 * The trace is imported only after the opt-in check, so it stays out of the
 * boot bundle. The plugin awaits the install: Nuxt starts the first
 * navigation after every plugin has run, so the initial page is still sampled.
 */
export default defineNuxtPlugin(async (nuxtApp) => {
	const limit = readLocalPerfTraceLimit(storage());
	if (limit === null) return;

	// Read in the plugin's own Nuxt context, before the import below.
	const config = useRuntimeConfig().public;
	const router = useRouter();
	const { installLocalPerfTrace } = await import('~/lib/localPerfTraceInstall.client');
	installLocalPerfTrace({ nuxtApp, router, config, limit });
});

function storage(): Storage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}
