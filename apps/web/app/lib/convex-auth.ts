import { isDesktopRuntime } from '~/lib/desktop/activeWorkspace';
import { desktopConvexTokenRequest } from '~/lib/auth-client';

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let inflightRequest: Promise<string | null> | null = null;
/**
 * The boot warm-up's request, held for the FIRST non-forced caller (the Convex
 * client's initial `setAuth` fetch). A token it produced is served from the
 * cache anyway; what this keeps is a `null` answer (signed-out visitor), which
 * the cache never stores, so that the client does not ask a second time for the
 * same "no session" the warm-up has already been told.
 */
let warmupRequest: Promise<string | null> | null = null;

/**
 * Why the last token fetch came back without a token. The Convex client only
 * sees `null` either way; the plugin's auth-loss handler reads this to tell a
 * session the server turned away from a request that never got an answer.
 *
 * - `no-session`: the server answered and has no session for us (401/403, a 200
 *   without a token, or a desktop with no workspace to ask);
 * - `unreachable`: no usable answer (network error, timeout, 5xx, a body that is
 *   not JSON), which says nothing about the session.
 */
export type ConvexTokenFailure = 'no-session' | 'unreachable';
let lastFailure: ConvexTokenFailure | null = null;

/** Why the most recent token fetch failed, or `null` if it produced a token. */
export function lastConvexTokenFailure(): ConvexTokenFailure | null {
	return lastFailure;
}

const REFRESH_BUFFER_MS = 60_000;

/**
 * Where/how to fetch the Convex JWT.
 *
 * Web: same-origin relative path + cookies (the Nitro proxy forwards them).
 * Desktop: absolute URL to the active workspace's Convex site, with no cookies —
 * the session rides in the `Better-Auth-Cookie` header that the workspace's
 * cross-domain client stores. Both come from the one client bound to that
 * workspace. Null on a desktop with no workspace: there is nowhere to ask.
 */
function buildTokenRequest(): { url: string; init: RequestInit } | null {
	if (isDesktopRuntime()) {
		const target = desktopConvexTokenRequest();
		if (!target) return null;
		const base = target.convexSiteUrl.replace(/\/+$/, '');
		const cookie = target.cookie;
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

function clearCachedToken() {
	cachedToken = null;
	tokenExpiresAt = 0;
}

function fail(reason: ConvexTokenFailure): null {
	clearCachedToken();
	lastFailure = reason;
	return null;
}

export function resetConvexAuthTokenCache() {
	clearCachedToken();
	inflightRequest = null;
	warmupRequest = null;
	lastFailure = null;
}

async function fetchToken(): Promise<string | null> {
	try {
		const request = buildTokenRequest();
		if (!request) return fail('no-session');
		const response = await fetch(request.url, request.init);

		if (!response.ok) {
			return fail(
				response.status === 401 || response.status === 403 ? 'no-session' : 'unreachable'
			);
		}

		const data = (await response.json()) as { token?: string | null };
		const token = data.token ?? null;

		if (!token) return fail('no-session');

		cachedToken = token;
		tokenExpiresAt = getTokenExpiry(token);
		lastFailure = null;
		return token;
	} catch {
		return fail('unreachable');
	}
}

export async function getConvexAuthToken(forceRefreshToken = false): Promise<string | null> {
	const now = Date.now();
	// One caller only, forced or not: after that the normal cache rules apply.
	const warmup = warmupRequest;
	warmupRequest = null;

	if (!forceRefreshToken && cachedToken && tokenExpiresAt - now > REFRESH_BUFFER_MS) {
		return cachedToken;
	}

	if (!forceRefreshToken && warmup) {
		return warmup;
	}

	if (!inflightRequest) {
		inflightRequest = fetchToken().finally(() => {
			inflightRequest = null;
		});
	}

	return inflightRequest;
}

/**
 * Start the Convex token fetch during boot, before anything needs the token, so
 * the round trip overlaps the i18n catalog load instead of following it
 * (plugins/0.auth-warmup.client.ts). Goes through the same in-flight dedupe as
 * every other caller. The token stays in memory only; it is never persisted.
 */
export function warmConvexAuthToken(): void {
	if (warmupRequest || inflightRequest) return;
	warmupRequest = getConvexAuthToken();
	// The first real caller receives this promise and handles its result; a
	// rejection can't happen (`fetchToken` catches), but never leave one unhandled.
	warmupRequest.catch(() => {});
}
