/**
 * `ConvexHttpClient` exposes `setAdminAuth` at runtime for deploy-key
 * authentication but omits it from its published types. This is the one place
 * that reaches past the type surface; the workers that talk to internal Convex
 * functions build their client through it.
 */
interface AdminAuthClient {
	setAdminAuth(adminKey: string): void;
}

export function createAdminConvexClient<Client extends object>(
	ConvexClient: new (url: string) => Client,
	url: string,
	adminKey: string
): Client {
	const client = new ConvexClient(url);
	(client as unknown as AdminAuthClient).setAdminAuth(adminKey);
	return client;
}
