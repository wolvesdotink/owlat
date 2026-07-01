/**
 * Resolving the Convex dashboard URL shown in the self-host onboarding banner.
 *
 * The dashboard is a separate container on port 6791 that, on a hardened
 * self-host, is bound to `127.0.0.1` and reached over an SSH tunnel — it is NOT
 * served on the same public host as the web app. So the old "swap the current
 * browser URL's port to 6791" heuristic only happens to be right when you open
 * the app straight off `localhost`; behind a proxy or custom hostname it points
 * at a port that isn't listening.
 *
 * These pure helpers make the resolution testable and give the UI three
 * ordered sources, so it can label a real value differently from a guess:
 *   1. `override`   — an explicit URL the operator entered (persisted locally).
 *   2. `configured` — a build-time value from runtime config
 *                     (`NUXT_PUBLIC_CONVEX_DASHBOARD_URL`).
 *   3. `derived`    — the legacy port-swap heuristic, clearly flagged as a guess.
 *
 * Everything fails soft: bad input never throws, it falls back to the localhost
 * default.
 */

export const CONVEX_DASHBOARD_PORT = '6791';
export const DEFAULT_CONVEX_DASHBOARD_URL = `http://localhost:${CONVEX_DASHBOARD_PORT}`;

/**
 * Accept only well-formed http(s) URLs. Returns a normalized string or `null`
 * (fail-soft) so callers can treat empty/garbage input the same as "unset".
 */
export function normalizeDashboardUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		return url.toString();
	} catch {
		return null;
	}
}

/**
 * Legacy heuristic: reuse the current origin but force port 6791 and drop the
 * path/query/hash. Only reliable when the app is opened via `localhost` (or a
 * host that also happens to expose the dashboard on 6791). Never throws.
 */
export function deriveConvexDashboardUrl(currentHref: string | null | undefined): string {
	if (!currentHref) return DEFAULT_CONVEX_DASHBOARD_URL;
	try {
		const url = new URL(currentHref);
		url.port = CONVEX_DASHBOARD_PORT;
		url.pathname = '/';
		url.search = '';
		url.hash = '';
		return url.toString();
	} catch {
		return DEFAULT_CONVEX_DASHBOARD_URL;
	}
}

export type DashboardUrlSource = 'override' | 'configured' | 'derived';

export interface ResolvedDashboardUrl {
	url: string;
	/**
	 * `override`/`configured` are real, trustworthy values; `derived` is a guess
	 * the UI should flag so the operator knows to correct it behind a proxy.
	 */
	source: DashboardUrlSource;
}

/**
 * Resolve the dashboard URL from the three ordered sources. An explicit operator
 * override wins, then a build-time configured value, then the derived guess.
 */
export function resolveConvexDashboardUrl(opts: {
	override?: string | null;
	configured?: string | null;
	currentHref?: string | null;
}): ResolvedDashboardUrl {
	const override = normalizeDashboardUrl(opts.override);
	if (override) return { url: override, source: 'override' };

	const configured = normalizeDashboardUrl(opts.configured);
	if (configured) return { url: configured, source: 'configured' };

	return { url: deriveConvexDashboardUrl(opts.currentHref), source: 'derived' };
}
