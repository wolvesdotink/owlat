/**
 * GET /.well-known/openpgpkey/hu/<hash> — WKD key retrieval (direct method,
 * draft-koch-openpgp-webkey-service §3.1).
 *
 * A discovering client (e.g. Thunderbird, or another Owlat instance) requests
 * the local-part hash `zbase32(SHA-1(lowercase(localpart)))` at the address's own
 * domain. We match the stored key by (request host, hash) and return the BINARY
 * transferable public key as `application/octet-stream`. Unknown local-part =>
 * 404. Public by design — WKD serves public key material to the world.
 */
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@owlat/api';

export default defineEventHandler(async (event): Promise<Uint8Array> => {
	const hash = getRouterParam(event, 'hash') ?? '';
	if (!hash) {
		throw createError({ statusCode: 404, statusMessage: 'Not Found' });
	}

	// Direct method: the key is served from the address's own domain, so the
	// request Host IS the domain we match against.
	const host = (getRequestHost(event) ?? '').toLowerCase();
	if (!host) {
		throw createError({ statusCode: 404, statusMessage: 'Not Found' });
	}

	const config = useRuntimeConfig(event);
	const convexUrl = config.public.convexUrl ?? '';
	if (!convexUrl) {
		throw createError({ statusCode: 404, statusMessage: 'Not Found' });
	}

	const client = new ConvexHttpClient(convexUrl);
	const result = await client.query(api.e2ee.keys.getKeyForWkd, { domain: host, wkdHash: hash });
	if (!result) {
		throw createError({ statusCode: 404, statusMessage: 'Not Found' });
	}

	setResponseHeader(event, 'Content-Type', 'application/octet-stream');
	setResponseHeader(event, 'Cache-Control', 'public, max-age=3600');
	return new Uint8Array(Buffer.from(result.binaryBase64, 'base64'));
});
