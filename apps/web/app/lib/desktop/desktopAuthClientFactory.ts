/**
 * Where desktop hydration leaves the builder of the active workspace's auth
 * client (`lib/desktop/desktopAuthClient.ts`, loaded on demand) for
 * `lib/auth-client.ts` to pick up. Kept apart from both so the web app's entry
 * bundle carries no desktop auth code, and so the many tests that stub
 * `auth-client` need not know about it.
 */
type Factory = (convexSiteUrl: string) => unknown;

let factory: Factory | null = null;

export function setDesktopAuthClientFactory(next: Factory | null): void {
	factory = next;
}

export function getDesktopAuthClientFactory<Client>(): ((convexSiteUrl: string) => Client) | null {
	return factory as ((convexSiteUrl: string) => Client) | null;
}
