/**
 * GET /api/v1/openapi.json — the OpenAPI document of this instance's public
 * API, with the instance's own API address as its server, so a client or an
 * agent pointed at a self-hosted instance can read what it offers.
 *
 * The address comes from `CONVEX_SITE_URL`, which a self-hosted deployment
 * derives from `NUXT_PUBLIC_CONVEX_SITE_URL`: the same address the web app
 * shows as the API base URL. The request's Host and forwarded headers are
 * not read, since anyone can set them. Without a configured address the
 * document keeps the placeholder server of the committed file.
 */

import { buildOpenApiDocument } from '@owlat/public-contract/openapi';
import { httpAction } from '../_generated/server';
import { getOptional } from '../lib/env';
import { publicCorsHeaders } from '../lib/httpResponse';

/**
 * The serialized document per server address. The contract is fixed for a
 * deployed bundle, so each warm isolate builds it once.
 */
const documents = new Map<string, string>();

function documentText(serverUrl: string | undefined): string {
	const key = serverUrl ?? '';
	let text = documents.get(key);
	if (text === undefined) {
		text = JSON.stringify(buildOpenApiDocument(undefined, { serverUrl }));
		documents.set(key, text);
	}
	return text;
}

// public: the document describes the open-source public API and holds no data
// of the instance beyond its public API address. Like the health probe it is
// not rate limited: the answer is a cached string, and a limiter would cost a
// database write per request. CORS allows any origin, since no credential
// rides along.
export const getOpenApiDocument = httpAction(async (_ctx, request) => {
	const headers = publicCorsHeaders('GET, OPTIONS');
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers });
	}
	const serverUrl = getOptional('CONVEX_SITE_URL')?.trim().replace(/\/+$/, '') || undefined;
	return new Response(documentText(serverUrl), {
		status: 200,
		headers: {
			...headers,
			'Content-Type': 'application/json',
			'Cache-Control': 'public, max-age=300',
		},
	});
});
