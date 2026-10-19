import {
	createLocalPerfTrace,
	LOCAL_PERF_TRACE_KEY,
	observeLongTasks,
	readLocalPerfTraceLimit,
	type LocalPerfTrace,
} from '~/lib/localPerfTrace';
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
 */
export default defineNuxtPlugin(() => {
	const limit = readLocalPerfTraceLimit(storage());
	if (limit === null) return;

	const config = useRuntimeConfig().public;
	const router = useRouter();
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
	// One subscription sample per settled navigation: what the page opened and
	// what the previous one left lingering.
	router.afterEach((to, _from, failure) => {
		if (failure) return;
		const counts = sharedSubscriptionCounts();
		trace.record('owlat_subscriptions', {
			route: routeLabel(to.name),
			active_count: counts.active,
			lingering_count: counts.lingering,
			lingering_body_count: counts.lingeringBody,
		});
	});
	observeLongTasks((duration) => trace.recordLongTask(currentRoute(), duration));

	window.owlatPerfTrace = consoleHandle(trace, version);
	globalThis.console?.info(
		`Owlat local performance trace is on (${trace.limit} samples, nothing is sent). ` +
			`Use owlatPerfTrace.export(), .download() or .clear(); ` +
			`remove localStorage '${LOCAL_PERF_TRACE_KEY}' to turn it off.`
	);
});

function storage(): Storage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
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
