/**
 * The place the router was last asked to go.
 *
 * Vue Router lets a newer request replace a navigation whose guards are still
 * running, a request for the page already shown included (that one runs no
 * guard at all), and it notices only after the whole queue of global guards.
 * A guard that acts outside the router, such as loading its `to` as a new
 * document, cannot rely on that check: an earlier guard in the queue may have
 * awaited while the person asked for something else. It has to ask
 * {@link NavigationRequests.isLatest} first.
 *
 * Requests reach the router through `push`/`replace` (links, `navigateTo`) or
 * through the history (back, forward, `go`). Both are seen here synchronously,
 * when they are made, before any guard of theirs runs.
 */
import type { RouteLocationNormalized, RouteLocationRaw, Router } from 'vue-router';

type TrackedRouter = Pick<Router, 'push' | 'replace' | 'resolve' | 'options'>;

interface NavigationRequests {
	/** Whether `to` is what the router was last asked for, directly or through a redirect. */
	isLatest: (to: RouteLocationNormalized) => boolean;
	stop: () => void;
}

export function trackNavigationRequests(router: TrackedRouter): NavigationRequests {
	// Null until the first request is seen: an unknown request is never the latest.
	let latest: string | null = null;

	const note = (target: RouteLocationRaw | string) => {
		try {
			latest = router.resolve(target).fullPath;
		} catch {
			// The router throws the same error at the caller and navigates nowhere.
		}
	};

	const push = router.push;
	const replace = router.replace;
	const trackedPush: Router['push'] = (to) => {
		note(to);
		return push(to);
	};
	const trackedReplace: Router['replace'] = (to) => {
		note(to);
		return replace(to);
	};
	router.push = trackedPush;
	router.replace = trackedReplace;
	const stopListening = router.options.history.listen((to) => note(to));

	return {
		isLatest: (to) =>
			latest !== null && (to.fullPath === latest || to.redirectedFrom?.fullPath === latest),
		stop: () => {
			stopListening();
			// Someone may have wrapped them in turn; theirs stays, ours keeps forwarding.
			if (router.push === trackedPush) router.push = push;
			if (router.replace === trackedReplace) router.replace = replace;
		},
	};
}
