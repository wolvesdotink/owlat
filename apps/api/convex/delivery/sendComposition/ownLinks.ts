/**
 * Send composition (module) — this instance's own subscription links.
 *
 * Link wrapping leaves these alone wherever they appear in the body, for the
 * reasons the footer's anchors opt out (see `footer.ts`): an opt-out must keep
 * working when the tracking host is down, is not engagement, and its contact
 * token must not be stored in click records or sent in `email.clicked`
 * webhooks.
 *
 * The web app serves the recipient pages (`/unsubscribe`, `/preferences`) and
 * the Convex site serves the one-click and verify endpoints (`/unsub/...`,
 * `/prefs/...`).
 */

const SITE_PATHS = ['/unsubscribe', '/preferences'] as const;
const CONVEX_SITE_PATHS = ['/unsub', '/prefs'] as const;

export interface OwnOrigins {
	siteUrl?: string | undefined;
	convexSiteUrl?: string | undefined;
}

function trimOrigin(url: string | undefined): string | undefined {
	const trimmed = url?.trim().replace(/\/+$/, '').toLowerCase();
	return trimmed ? trimmed : undefined;
}

/**
 * True when `href` points at one of `paths` under `origin`. The path must end
 * there or continue with `/`, `?` or `#`, so `/unsubscribe-later` on the same
 * host is an ordinary link.
 */
function pointsAt(href: string, origin: string | undefined, paths: readonly string[]): boolean {
	if (!origin) return false;
	return paths.some((path) => {
		const prefix = `${origin}${path}`;
		if (!href.startsWith(prefix)) return false;
		const next = href.charAt(prefix.length);
		return next === '' || next === '/' || next === '?' || next === '#';
	});
}

export function isOwnSubscriptionLink(href: string, origins: OwnOrigins): boolean {
	const url = href.trim().toLowerCase();
	return (
		pointsAt(url, trimOrigin(origins.siteUrl), SITE_PATHS) ||
		pointsAt(url, trimOrigin(origins.convexSiteUrl), CONVEX_SITE_PATHS)
	);
}
