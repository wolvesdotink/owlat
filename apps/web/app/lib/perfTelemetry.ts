/**
 * Performance samples on their way to PostHog.
 *
 * `plugins/posthog.client.ts` arms this only when a PostHog key is configured,
 * and attaches a sender only while `analytics.posthog` is on and the client is
 * running. Until it is armed every report is a no-op, so a deployment without
 * PostHog pays for nothing but the `performance.mark` calls.
 *
 * A sample is a timing and a route NAME (`dashboard-postbox-folder`), never a
 * URL, an id or anything about the person. The boot samples are taken before
 * the PostHog client can exist (the shell mounts while `posthog-js` is still
 * loading), so a handful of them wait in memory for the sender. They leave the
 * browser only once the flag is on and the client is started, and they are
 * forgotten when an admin switches the flag back off.
 */

export type PerfProperties = Record<string, number | string>;
type PerfSender = (event: string, properties: PerfProperties) => void;

/** Enough for one page load's boot and vitals samples; the rest is dropped. */
const PENDING_LIMIT = 20;

let armed = false;
let routeName: () => string = () => 'unknown';
let sender: PerfSender | null = null;
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

export function reportPerf(event: string, properties: PerfProperties): void {
	if (!armed) return;
	const sample: PerfProperties = { route: routeName(), ...properties };
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
