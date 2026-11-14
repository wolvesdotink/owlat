/**
 * The one-click target of a test preview's `List-Unsubscribe` header
 * (`delivery/testPreviewLinks.ts`). A mail provider POSTs it when the member
 * presses its unsubscribe button: it answers 200 like the real endpoint and
 * changes nothing, as there is no contact behind a preview. A GET, from a
 * person or a link scanner, goes to the web app's preview page.
 */

import type { HttpRouter } from 'convex/server';
import { httpAction } from '../_generated/server';
import { getOptional } from '../lib/env';
import { TEST_PREVIEW_QUERY } from './testPreviewLinks';

const handleTestPreviewOneClick = httpAction(async () => {
	return new Response(JSON.stringify({ ok: true, data: { preview: true } }), {
		status: 200,
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
	});
});

const redirectTestPreviewLinkToPage = httpAction(async () => {
	const siteUrl = getOptional('SITE_URL')?.trim().replace(/\/+$/, '');
	if (!siteUrl) return new Response('Not found', { status: 404 });
	return new Response(null, {
		status: 302,
		headers: {
			Location: `${siteUrl}/unsubscribe?${TEST_PREVIEW_QUERY}`,
			'Cache-Control': 'no-store',
		},
	});
});

/**
 * Exact routes, so the router matches them before the `/unsub/` token prefix
 * and a preview never reaches the token handlers. The path is the one
 * `testPreviewLinks.ts` writes into the header.
 */
export function registerTestPreviewRoutes(http: HttpRouter): void {
	http.route({ path: '/unsub/test-preview', method: 'POST', handler: handleTestPreviewOneClick });
	http.route({
		path: '/unsub/test-preview',
		method: 'GET',
		handler: redirectTestPreviewLinkToPage,
	});
}
