import type { ConvexClient } from 'convex/browser';

declare module '#app' {
	interface NuxtApp {
		$convex: ConvexClient | null;
	}
}

declare module 'vue' {
	interface ComponentCustomProperties {
		$convex: ConvexClient | null;
	}
}

export {};
