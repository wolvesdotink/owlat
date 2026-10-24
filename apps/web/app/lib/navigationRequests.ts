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
 * through the history: the router's `go`/`back`/`forward`, or the browser's
 * own buttons. Each is seen synchronously, when it is made, before any guard
 * of its own runs. A traversal's destination is known only once the history
 * reports it, which a browser does in a later task; from the moment one is
 * asked for until then, no destination is the latest.
 */
import type { RouteLocationNormalized, RouteLocationRaw, Router } from 'vue-router';

type WrappedMethod = 'push' | 'replace' | 'go' | 'back' | 'forward';
type TrackedRouter = Pick<Router, WrappedMethod | 'resolve' | 'options'>;

interface NavigationRequests {
	/** Whether `to` is what the router was last asked for, directly or through a redirect. */
	isLatest: (to: RouteLocationNormalized) => boolean;
	stop: () => void;
}

export function trackNavigationRequests(router: TrackedRouter): NavigationRequests {
	// Null while no destination is known: before the first request, and while a
	// traversal waits for the history to name its destination.
	let latest: string | null = null;

	const note = (target: RouteLocationRaw | string) => {
		try {
			latest = router.resolve(target).fullPath;
		} catch {
			// The router throws the same error at the caller and navigates nowhere.
		}
	};
	const forget = () => {
		latest = null;
	};

	const restores: Array<() => void> = [];
	const wrap = <K extends WrappedMethod>(
		key: K,
		onCall: (...args: Parameters<Router[K]>) => void
	) => {
		const original = router[key] as (...args: Parameters<Router[K]>) => ReturnType<Router[K]>;
		const tracked = ((...args: Parameters<Router[K]>) => {
			onCall(...args);
			return original(...args);
		}) as Router[K];
		router[key] = tracked;
		restores.push(() => {
			// Someone may have wrapped it in turn; theirs stays, ours keeps forwarding.
			if (router[key] === tracked) router[key] = original as Router[K];
		});
	};
	wrap('push', note);
	wrap('replace', note);
	// `back` and `forward` call the router's own `go`, not the property, so each
	// needs its own wrapper.
	wrap('go', forget);
	wrap('back', forget);
	wrap('forward', forget);
	const stopListening = router.options.history.listen((to) => note(to));

	return {
		isLatest: (to) =>
			latest !== null && (to.fullPath === latest || to.redirectedFrom?.fullPath === latest),
		stop: () => {
			stopListening();
			for (const restore of restores) restore();
		},
	};
}
