/**
 * Shared helper for the public `/.well-known/*` server routes.
 *
 * Each of them (`mta-sts.txt`, `openpgpkey/hu/<hash>`, `owlat.json`) needs the
 * public Convex URL and a `ConvexHttpClient` to derive its body server-side, and
 * each must 404 rather than error when the URL is unset. This centralises that
 * shape so the three routes stay identical (DRY) and a missing config always
 * degrades to a plain 404.
 */
import { ConvexHttpClient } from 'convex/browser';
import type { H3Event } from 'h3';

export function publicConvexClient(event: H3Event): ConvexHttpClient {
	const config = useRuntimeConfig(event);
	const convexUrl = config.public.convexUrl ?? '';
	if (!convexUrl) {
		throw createError({ statusCode: 404, statusMessage: 'Not Found' });
	}
	return new ConvexHttpClient(convexUrl);
}
