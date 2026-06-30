import type { ConvexClient } from 'convex/browser';

/**
 * Returns the Convex client instance.
 * Must be used on the client side only.
 */
export function useConvex(): ConvexClient | null {
	const nuxtApp = useNuxtApp();
	return nuxtApp.$convex as ConvexClient | null;
}

/**
 * Returns the Convex client, throwing a descriptive error if it is unavailable.
 *
 * Use this at the point of use (inside client-side event handlers) instead of a
 * non-null assertion on `useConvex()` — it converts a silent `null` dereference
 * crash into an explicit, debuggable error. Client-side only.
 */
export function requireConvex(): ConvexClient {
	const convex = useConvex();
	if (!convex) {
		throw new Error(
			'Convex client is unavailable. requireConvex() must run on the client after the Convex plugin has initialized.'
		);
	}
	return convex;
}
