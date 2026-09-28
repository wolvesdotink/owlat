import { extractOperationError } from '@owlat/shared/operationError';
import { ConvexHttpClient } from 'convex/browser';
import type { H3Event } from 'h3';
import { buildInternalTokenUrl } from './internalTokenUrl';

/**
 * Exchange the better-auth session cookie for a Convex JWT and return an
 * authenticated `ConvexHttpClient`. This proves AUTHENTICATION only — the admin
 * PROBE is each gate's own job, so `requirePlatformAdmin` and `requireOrgAdmin`
 * share this preamble and `mapGateError`, and differ only in the authorization
 * query they run.
 *
 * Throws 503 when Convex isn't configured, 401 when the request carries no
 * usable session.
 *
 * Pattern:
 *   1. Exchange the session cookie for a Convex JWT via the internal
 *      `/api/auth/convex/token` proxy (which forwards cookies to Convex).
 *   2. Create a `ConvexHttpClient` and set the JWT as auth.
 */
export async function authedConvexClient(event: H3Event): Promise<ConvexHttpClient> {
	const config = useRuntimeConfig();
	const convexUrl = config.public.convexUrl as string;
	if (!convexUrl) {
		throw createError({ statusCode: 503, message: 'Convex not configured' });
	}

	const cookieHeader = getHeader(event, 'cookie');
	if (!cookieHeader) {
		throw createError({ statusCode: 401, message: 'Not authenticated' });
	}

	// Build the internal token-exchange URL from the TRUSTED configured origin,
	// never from the request `Host` header — forwarding the caller's cookie to a
	// spoofable host is a credential-leaking SSRF. `siteUrl` always has a
	// non-empty default (see nuxt.config.ts runtimeConfig).
	const siteUrl = config.public.siteUrl as string;
	const tokenResp = await fetch(buildInternalTokenUrl(siteUrl), {
		method: 'GET',
		headers: { cookie: cookieHeader },
	});
	if (!tokenResp.ok) {
		throw createError({ statusCode: 401, message: 'Not authenticated' });
	}

	const { token } = (await tokenResp.json()) as { token?: string | null };
	if (!token) {
		throw createError({ statusCode: 401, message: 'No auth token' });
	}

	const client = new ConvexHttpClient(convexUrl);
	client.setAuth(token);
	return client;
}

/**
 * Map a failed gate probe to the HTTP error the route answers with, so every
 * admin gate reports the same failure the same way. Only an Operation error is
 * an access answer: `forbidden` is 403 with the gate's own message and
 * `unauthenticated` is 401. Anything else (Convex unreachable, a timeout, an
 * unexpected throw) is 503: an outage must not read as "access required", and
 * must not escape as an opaque 500 either.
 *
 * An error that already carries an HTTP status (a `createError` result, such as
 * the gate's own 403) is returned untouched, so a gate can wrap its whole probe
 * in one `try` without the mapper rewriting its answer. The result is meant to
 * be thrown: `catch (e) { throw mapGateError(e, { forbiddenMessage }) }`.
 */
export function mapGateError(e: unknown, options: { forbiddenMessage: string }): Error {
	if (isHttpError(e)) {
		return e;
	}
	const category = extractOperationError(e)?.category;
	if (category === 'forbidden') {
		return createError({ statusCode: 403, message: options.forbiddenMessage });
	}
	if (category === 'unauthenticated') {
		return createError({ statusCode: 401, message: 'Not authenticated' });
	}
	return createError({
		statusCode: 503,
		message: 'Could not verify access: the backend is unreachable.',
	});
}

/** An error that already carries an HTTP status, as `createError` produces. */
function isHttpError(e: unknown): e is Error & { statusCode: number } {
	return e instanceof Error && typeof (e as { statusCode?: unknown }).statusCode === 'number';
}
