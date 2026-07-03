/**
 * Desktop deep-link handling.
 *
 * Two kinds of `owlat://` links:
 *   - `owlat://auth?ott=...&state=...` — the sign-in handshake return; redeems
 *     the one-time token into the pending workspace (see useDesktopWorkspaces).
 *   - `owlat://thread/{id}`, `owlat://chat/{id}`, ... — navigation into the SPA.
 *
 * Driven from the boot plugin (a path that definitely runs in the webview),
 * handling both the cold-start URL and links delivered while already running.
 */
import { completeConnection } from '~/composables/useDesktopWorkspaces';
import { parseMailto } from '~/lib/desktop/mailto';

const NAV_ROUTE_MAP: Record<string, string> = {
	'thread/': '/dashboard/inbox/',
	'chat/': '/dashboard/chat/',
	'knowledge/': '/dashboard/knowledge/',
	'file/': '/dashboard/files/',
	'contact/': '/dashboard/audience/contacts/',
};

export async function handleDeepLink(url: string): Promise<void> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return;
	}

	// mailto: — opened when Owlat is the default mail handler. Parse RFC-6068
	// recipients + subject and open the compose window seeded with them.
	if (parsed.protocol === 'mailto:') {
		const mailto = parseMailto(url);
		if (mailto) {
			const q = new URLSearchParams();
			if (mailto.to.length) q.set('to', mailto.to.join(', '));
			if (mailto.cc.length) q.set('cc', mailto.cc.join(', '));
			if (mailto.bcc.length) q.set('bcc', mailto.bcc.join(', '));
			if (mailto.subject) q.set('subject', mailto.subject);
			if (mailto.body) q.set('body', mailto.body);
			try {
				const { openCompose } = await import('@owlat/desktop/src/compose');
				await openCompose(`/compose?${q.toString()}`);
			} catch (e) {
				console.warn('[desktop] mailto handling failed:', e);
			}
		}
		return;
	}

	if (parsed.protocol !== 'owlat:') return;

	// owlat://auth?ott=...&state=...  → host is "auth"
	if (parsed.host === 'auth' || parsed.pathname.replace(/^\/+/, '').startsWith('auth')) {
		const ott = parsed.searchParams.get('ott');
		const state = parsed.searchParams.get('state');
		if (ott && state) {
			try {
				await completeConnection({ ott, state });
			} catch (e) {
				console.error('[desktop] workspace connection failed:', e);
			}
		}
		return;
	}

	// Navigation: combine host + path → "thread/123", match a route prefix.
	const afterScheme = `${parsed.host}${parsed.pathname}`.replace(/^\/+/, '');
	for (const [prefix, route] of Object.entries(NAV_ROUTE_MAP)) {
		if (afterScheme.startsWith(prefix)) {
			window.location.assign(`${route}${afterScheme.slice(prefix.length)}`);
			return;
		}
	}
	if (afterScheme) window.location.assign(`/dashboard/${afterScheme}`);
}

/** Register deep-link handling: process the launch URL, then subscribe to live ones. */
export async function setupDeepLinks(): Promise<void> {
	try {
		const { getInitialDeepLinks, onDeepLink } = await import('@owlat/desktop/src/deeplink');
		for (const url of await getInitialDeepLinks()) {
			await handleDeepLink(url);
		}
		await onDeepLink((urls) => {
			for (const url of urls) void handleDeepLink(url);
		});
	} catch (e) {
		console.warn('[desktop] deep-link setup skipped:', e);
	}
}
