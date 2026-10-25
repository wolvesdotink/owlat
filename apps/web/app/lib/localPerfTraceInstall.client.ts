/**
 * Installs the local performance trace (`lib/localPerfTrace.ts`) for a page
 * load that opted in. `plugins/perf-trace.client.ts` imports this module only
 * after the opt-in check, so a browser that never opted in never downloads it.
 */
import type { Router } from 'vue-router';
import { createLocalPerfTrace, observeLongTasks, type LocalPerfTrace } from '~/lib/localPerfTrace';
import { LOCAL_PERF_TRACE_KEY } from '~/lib/localPerfTraceOptIn';
import { routeLabel, setLocalPerfSink, startPerfCollection } from '~/lib/perfTelemetry';
import { sharedSubscriptionCounts } from '~/lib/sharedConvexSubscriptions';

/** What the browser console gets while the local trace is on. */
interface PerfTraceHandle {
	readonly limit: number;
	/** The trace as JSON. */
	export(): string;
	/** Save the trace as a JSON file. Nothing goes over the network. */
	download(): void;
	clear(): void;
}

declare global {
	interface Window {
		owlatPerfTrace?: PerfTraceHandle;
	}
}

/** The public runtime config fields the trace's build stamp reads. */
export interface PerfTraceBuildConfig {
	owlatVersion?: unknown;
	owlatGitSha?: unknown;
	owlatBuildDate?: unknown;
	deploymentMode?: unknown;
	isDesktopBuild?: unknown;
}

/** The part of the Nuxt app the trace needs: the page lifecycle hook. */
export interface PerfTraceApp {
	hook(name: 'page:finish', fn: () => void): unknown;
}

/**
 * Wire the trace into the router and the page lifecycle. Takes the router and
 * config the plugin read in its own Nuxt context, and must run before the
 * first navigation so the initial page is sampled too.
 */
export function installLocalPerfTrace(options: {
	nuxtApp: PerfTraceApp;
	router: Router;
	config: PerfTraceBuildConfig;
	limit: number;
}): void {
	const { nuxtApp, router, config, limit } = options;
	const knownRoutes = new Set<string>();
	for (const record of router.getRoutes()) {
		if (typeof record.name === 'string' && record.name) knownRoutes.add(record.name);
	}
	const version = String(config.owlatVersion ?? 'dev');
	const trace = createLocalPerfTrace({
		limit,
		build: {
			version,
			gitSha: String(config.owlatGitSha ?? 'unknown'),
			buildDate: String(config.owlatBuildDate ?? 'unknown'),
			deploymentMode: String(config.deploymentMode ?? 'selfhost'),
			desktop: config.isDesktopBuild === true,
		},
		knownRoutes,
		now: () => performance.now(),
		subscriptionCounts: sharedSubscriptionCounts,
	});
	const currentRoute = () => routeLabel(router.currentRoute.value.name);

	setLocalPerfSink((event, properties) => trace.record(event, properties), { currentRoute });
	startPerfCollection(router);
	// One subscription sample per navigation, taken once the destination has
	// rendered: what its page opened and what the page before left lingering.
	// Only `page:finish` proves that. In Nuxt 4.5 it is called from the page
	// Suspense's `onResolve` alone, so it fires once the new page resolved
	// (with the `out-in` page transition, after the old page left and released
	// its queries). `page:loading:end` does not: the router plugin also calls it
	// for every failed, aborted or duplicated navigation and from
	// `router.onError`. So a sample is armed by a successful navigation only,
	// cancelled by any failed one, taken on the next `page:finish` while the
	// route is still the armed destination, and recorded one frame later (so
	// post-flush watchers and scope disposals have finished) if no newer
	// navigation replaced it. A query-only change keeps the page mounted and
	// resolves no Suspense, so it takes no sample of its own.
	let pending: { route: string; fullPath: string } | null = null;
	const stillCurrent = (armed: { fullPath: string }) =>
		pending === armed && router.currentRoute.value.fullPath === armed.fullPath;
	router.afterEach((to, _from, failure) => {
		pending = failure ? null : { route: routeLabel(to.name), fullPath: to.fullPath };
	});
	nuxtApp.hook('page:finish', () => {
		const armed = pending;
		if (!armed || !stillCurrent(armed)) return;
		requestAnimationFrame(() => {
			if (!stillCurrent(armed)) return;
			pending = null;
			const counts = sharedSubscriptionCounts();
			trace.record('owlat_subscriptions', {
				route: armed.route,
				active_count: counts.active,
				lingering_count: counts.lingering,
				lingering_body_count: counts.lingeringBody,
			});
		});
	});
	observeLongTasks((duration) => trace.recordLongTask(currentRoute(), duration));

	window.owlatPerfTrace = consoleHandle(trace, version);
	globalThis.console?.info(
		`Owlat local performance trace is on (${trace.limit} samples, nothing is sent). ` +
			`Use owlatPerfTrace.export(), .download() or .clear(); ` +
			`remove localStorage '${LOCAL_PERF_TRACE_KEY}' to turn it off.`
	);
}

function consoleHandle(trace: LocalPerfTrace, version: string): PerfTraceHandle {
	return {
		limit: trace.limit,
		export: () => trace.export(),
		download() {
			const url = URL.createObjectURL(new Blob([trace.export()], { type: 'application/json' }));
			const link = document.createElement('a');
			link.href = url;
			link.download = `owlat-perf-trace-${version.replace(/[^\w.-]+/g, '-')}.json`;
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 0);
		},
		clear: () => trace.clear(),
	};
}
