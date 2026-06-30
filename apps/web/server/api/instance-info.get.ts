// Public instance-discovery endpoint for the desktop app.
//
// When a user adds a workspace in the desktop app they type only the instance's
// web URL (e.g. https://acme.owlat.app). The app then probes
// `GET {siteUrl}/api/instance-info` to discover the Convex client URL, the
// Convex site URL (where /api/auth/* lives) and the deployment mode — so the
// user does not have to know or type three separate URLs.
//
// This lives in the web (Nitro) tier rather than as a Convex HTTP action to
// avoid a chicken-and-egg: the desktop cannot call a Convex action until it
// already knows `convexSiteUrl`, which is exactly what it is trying to learn.
//
// The response carries only values already exposed in the public bundle, so it
// is safe to serve cross-origin with a permissive CORS header (no credentials).
export default defineEventHandler((event) => {
	const config = useRuntimeConfig(event);
	const pub = config.public;

	// The desktop webview origin (`tauri://localhost` / `https://tauri.localhost`)
	// is allow-listed globally in nuxt.config.ts `security.corsHandler.origin`,
	// which reflects the matching origin into Access-Control-Allow-Origin. We do
	// not set ACAO here to avoid emitting a conflicting second header.
	setHeader(event, 'Cache-Control', 'no-store');

	const siteUrl = (pub.siteUrl as string) || '';
	let host = '';
	try {
		host = siteUrl ? new URL(siteUrl).host : '';
	} catch {
		host = '';
	}

	return {
		// Human-facing label shown in the workspace switcher. Falls back to the
		// host when no company name is configured.
		name: (pub.companyName as string) || host || 'Owlat',
		// Convex client (WebSocket) endpoint — what `new ConvexClient(url)` takes.
		convexUrl: (pub.convexUrl as string) || '',
		// Convex site endpoint — hosts /api/auth/* (BetterAuth + convex token).
		convexSiteUrl: (pub.convexSiteUrl as string) || '',
		// The instance's web origin — used as the login page base + deep-link return.
		siteUrl,
		// 'selfhost' | 'hosted' — drives onboarding/billing UI gating.
		deploymentMode: (pub.deploymentMode as string) || 'selfhost',
	};
});
