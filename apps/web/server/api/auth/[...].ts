// Proxy auth requests to Convex to avoid CORS issues
// See: https://www.better-auth.com/docs/integrations/convex
import { logError } from '~/lib/runtimeLog';

export default defineEventHandler(async (event) => {
	const config = useRuntimeConfig();
	const convexSiteUrl = config.convexSiteUrlInternal || config.public.convexSiteUrl;

	if (!convexSiteUrl) {
		throw createError({
			statusCode: 500,
			message: 'NUXT_PUBLIC_CONVEX_SITE_URL is not configured',
		});
	}

	// Get the path after /api/auth/
	const path = event.path.replace(/^\/api\/auth/, '/api/auth');

	// Build the target URL
	const targetUrl = `${convexSiteUrl.replace(/\/+$/, '')}${path}`;
	try {
		// Validate URL early so misconfigurations fail clearly
		new URL(targetUrl);
	} catch {
		throw createError({
			statusCode: 500,
			message: `Invalid NUXT_PUBLIC_CONVEX_SITE_URL or auth path: ${targetUrl}`,
		});
	}

	// Get request body for non-GET requests
	let body: string | undefined;
	if (event.method !== 'GET' && event.method !== 'HEAD') {
		body = await readRawBody(event);
	}

	// Forward headers, filtering out host-related ones
	const headers = new Headers();
	const incomingHeaders = getHeaders(event);

	for (const [key, value] of Object.entries(incomingHeaders)) {
		// Skip headers that shouldn't be forwarded
		if (
			key.toLowerCase() === 'host' ||
			key.toLowerCase() === 'connection' ||
			key.toLowerCase() === 'content-length'
		) {
			continue;
		}
		if (value) {
			headers.set(key, value);
		}
	}

	// Explicitly ensure cookies are forwarded
	const cookieHeader = getHeader(event, 'cookie');
	if (cookieHeader) {
		headers.set('cookie', cookieHeader);
	}

	// BetterAuth's rate limiter keys on the FIRST (leftmost) entry of
	// X-Forwarded-For. A client-supplied X-Forwarded-For puts an
	// attacker-controlled value there, so appending the peer IP after it would
	// let an attacker rotate the leftmost entry per request and mint a fresh
	// rate-limit bucket, defeating sign-in / forget-password / sign-up limits.
	// Overwrite the header with the trusted connecting peer IP only, deliberately
	// discarding any client-appended value. Behind a trusted reverse proxy (e.g.
	// Caddy) the peer is that proxy, so the rate-limit key becomes the proxy's own
	// IP: a single shared auth-limit bucket for the whole deployment. That is
	// intentional and acceptable for this single-org self-hosted deployment. Do NOT
	// "restore" per-client granularity by re-reading the dropped client entry: it
	// is attacker-controlled and doing so reopens the rate-limit bypass. With
	// nothing in front (local dev) this supplies the peer IP the limiter would
	// otherwise lack.
	const peerIp = getRequestIP(event);
	if (peerIp) {
		headers.set('x-forwarded-for', peerIp);
	} else {
		headers.delete('x-forwarded-for');
	}

	// Make the proxied request to Convex
	let response: Response;
	try {
		response = await fetch(targetUrl, {
			method: event.method,
			headers,
			body,
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		if (import.meta.dev) {
			logError('[Auth Proxy] Failed to reach Convex auth endpoint', {
				targetUrl,
				method: event.method,
				error: errorMessage,
			});
		}

		throw createError({
			statusCode: 502,
			statusMessage: 'Bad Gateway',
			message: import.meta.dev
				? `Failed to reach Convex auth endpoint at ${targetUrl}. Check NUXT_PUBLIC_CONVEX_SITE_URL and ensure Convex dev is running.`
				: 'Authentication service is temporarily unavailable',
			data: import.meta.dev
				? {
						targetUrl,
						method: event.method,
						cause: errorMessage,
					}
				: undefined,
		});
	}

	// Handle Set-Cookie headers specially - there can be multiple
	// We need to modify cookies to work with our proxy domain
	const setCookieHeaders = response.headers.getSetCookie();
	if (setCookieHeaders && setCookieHeaders.length > 0) {
		for (let cookie of setCookieHeaders) {
			// Remove Domain attribute so cookie works on current domain (localhost or production)
			cookie = cookie.replace(/;\s*Domain=[^;]*/gi, '');
			// Remove Secure flag for localhost development
			if (import.meta.dev) {
				cookie = cookie.replace(/;\s*Secure/gi, '');
			}
			// Ensure SameSite is set to Lax for cross-site compatibility
			if (!cookie.toLowerCase().includes('samesite')) {
				cookie += '; SameSite=Lax';
			}
			appendResponseHeader(event, 'Set-Cookie', cookie);
		}
	}

	// Forward other response headers back to client
	response.headers.forEach((value, key) => {
		const lowerKey = key.toLowerCase();
		// Skip headers that H3 handles automatically or that we handle specially
		if (
			lowerKey !== 'content-encoding' &&
			lowerKey !== 'transfer-encoding' &&
			lowerKey !== 'content-length' &&
			lowerKey !== 'set-cookie'
		) {
			setHeader(event, key, value);
		}
	});

	// Set status code
	setResponseStatus(event, response.status);

	// Return response body
	const responseBody = await response.text();
	return responseBody;
});
