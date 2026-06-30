import { isDesktopRuntime, getActiveWorkspace } from '~/lib/desktop/activeWorkspace';
import { authClient } from '~/lib/auth-client';

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let inflightRequest: Promise<string | null> | null = null;

const REFRESH_BUFFER_MS = 60_000;

/**
 * Where/how to fetch the Convex JWT.
 *
 * Web: same-origin relative path + cookies (the Nitro proxy forwards them).
 * Desktop: absolute URL to the active workspace's Convex site, with no cookies —
 * the session rides in the `Better-Auth-Cookie` header that the cross-domain
 * client stores (read here via `authClient.getCookie()`).
 */
function buildTokenRequest(): { url: string; init: RequestInit } {
	if (isDesktopRuntime()) {
		const base = (getActiveWorkspace()?.convexSiteUrl ?? '').replace(/\/+$/, '');
		const getCookie = (authClient as unknown as { getCookie?: () => string }).getCookie;
		const cookie = getCookie ? getCookie() : '';
		return {
			url: `${base}/api/auth/convex/token`,
			init: {
				method: 'GET',
				credentials: 'omit',
				headers: cookie ? { 'Better-Auth-Cookie': cookie } : {},
			},
		};
	}
	return {
		url: '/api/auth/convex/token',
		init: { method: 'GET', credentials: 'include' },
	};
}

function getTokenExpiry(jwt: string): number {
	try {
		const payload = JSON.parse(atob(jwt.split('.')[1] ?? ''));
		return (payload.exp ?? 0) * 1000;
	} catch {
		return 0;
	}
}

export function resetConvexAuthTokenCache() {
	cachedToken = null;
	tokenExpiresAt = 0;
	inflightRequest = null;
}

async function fetchToken(): Promise<string | null> {
	try {
		const { url, init } = buildTokenRequest();
		const response = await fetch(url, init);

		if (!response.ok) {
			resetConvexAuthTokenCache();
			return null;
		}

		const data = (await response.json()) as { token?: string | null };
		const token = data.token ?? null;

		if (!token) {
			resetConvexAuthTokenCache();
			return null;
		}

		cachedToken = token;
		tokenExpiresAt = getTokenExpiry(token);
		return token;
	} catch {
		resetConvexAuthTokenCache();
		return null;
	}
}

export async function getConvexAuthToken(forceRefreshToken = false): Promise<string | null> {
	const now = Date.now();

	if (!forceRefreshToken && cachedToken && tokenExpiresAt - now > REFRESH_BUFFER_MS) {
		return cachedToken;
	}

	if (!inflightRequest) {
		inflightRequest = fetchToken().finally(() => {
			inflightRequest = null;
		});
	}

	return inflightRequest;
}
