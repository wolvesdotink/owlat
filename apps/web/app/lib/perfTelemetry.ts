/**
 * Performance samples on their way to PostHog.
 *
 * `plugins/posthog.client.ts` arms this only when a PostHog key is configured,
 * and attaches a sender only while `analytics.posthog` is on and the client is
 * running. Until it is armed every report is a no-op, so a deployment without
 * PostHog pays for nothing but the `performance.mark` calls.
 *
 * The properties a sample adds are a timing and a route NAME
 * (`dashboard-postbox-folder`), never a URL, an id or anything about the
 * person. PostHog itself still attaches its default properties to every
 * capture, `$current_url` and `$pathname` among them, which the plugin's
 * `before_send` reduces to the route pattern (`lib/analyticsPrivacy`). The
 * boot samples are taken before the PostHog client can exist (the shell mounts
 * while `posthog-js` is still loading), so a handful of them wait in memory for
 * the sender. They leave the browser only once the flag is on and the client
 * is started, and they are forgotten when an admin switches the flag back off.
 *
 * A local trace (`lib/localPerfTrace`, opted into per browser) is a second
 * sink: it sees every sample whether or not PostHog is configured, armed or
 * sending, and keeps it in memory. Without either, a report does nothing.
 */
import type { Router } from 'vue-router';
import { observeWebVitals } from '~/lib/webVitals';

export type PerfProperties = Record<string, number | string>;
type PerfSender = (event: string, properties: PerfProperties) => void;

/** Enough for one page load's boot and vitals samples; the rest is dropped. */
const PENDING_LIMIT = 20;

let armed = false;
let routeName: () => string = () => 'unknown';
let sender: PerfSender | null = null;
let localSink: PerfSender | null = null;
const pending: Array<[string, PerfProperties]> = [];
let settledViews = 0;
let firstRoute: string | null = null;

/** Start collecting. `currentRoute` names the route a sample was taken on. */
export function armPerfReporting(options: { currentRoute: () => string }): void {
	armed = true;
	routeName = options.currentRoute;
}

/**
 * Attach (or with `null`, detach) the function that ships samples. Attaching
 * flushes what waited; detaching forgets it, because a flag switched off must
 * not send the samples taken while it was on.
 */
export function setPerfSender(next: PerfSender | null): void {
	sender = next;
	if (!next) {
		pending.length = 0;
		return;
	}
	for (const [event, properties] of pending.splice(0)) next(event, properties);
}

/**
 * Hand every sample to `sink` as well, PostHog or not; with `null`, stop.
 * `currentRoute` names the route a sample was taken on.
 */
export function setLocalPerfSink(
	sink: PerfSender | null,
	options?: { currentRoute: () => string }
): void {
	localSink = sink;
	if (options) routeName = options.currentRoute;
}

export function reportPerf(event: string, properties: PerfProperties): void {
	if (!armed && !localSink) return;
	const sample: PerfProperties = { route: routeName(), ...properties };
	localSink?.(event, sample);
	if (!armed) return;
	if (sender) sender(event, sample);
	else if (pending.length < PENDING_LIMIT) pending.push([event, sample]);
}

/** Called after every successful navigation. */
export function noteViewSettled(route: string): void {
	settledViews += 1;
	firstRoute ??= route;
}

/**
 * True while the app still shows the route the page load landed on. A shell
 * that mounts after a sign-in navigation is not a cold boot, and timing it from
 * navigation start would count the time spent typing a password.
 */
export function isFirstView(): boolean {
	return settledViews <= 1;
}

/** The route name the page load landed on, once the first navigation settled. */
export function landingRoute(): string {
	return firstRoute ?? 'unknown';
}

/** Route name of a location, never its path: names carry no ids or addresses. */
export function routeLabel(name: unknown): string {
	return typeof name === 'string' && name ? name : 'unknown';
}

let collecting = false;

/**
 * The page-load side shared by both sinks: settled navigations (for
 * `isFirstView`) and the web vitals. Started by whichever sink comes first,
 * once, so a tab with PostHog and a local trace observes everything one time.
 */
export function startPerfCollection(router: Pick<Router, 'afterEach'>): void {
	if (collecting) return;
	collecting = true;
	router.afterEach((to, _from, failure) => {
		if (!failure) noteViewSettled(routeLabel(to.name));
	});
	observeWebVitals((vitals) =>
		reportPerf('owlat_web_vitals', { ...vitals, landing_route: landingRoute() })
	);
}
