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
import { api } from '@owlat/api';
import { publicConvexClient } from '../../../../utils/publicConvexClient';

/** A WKD `hu/<hash>` segment is zbase32(SHA-1(localpart)) — exactly 32 z-base-32 chars. */
const WKD_HASH_RE = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{32}$/i;

export default defineEventHandler(async (event): Promise<Uint8Array> => {
	const hash = getRouterParam(event, 'hash') ?? '';
	// Validate the hash shape before any Convex round-trip: a malformed segment
	// can never match a stored key, so answer 404 directly.
	if (!WKD_HASH_RE.test(hash)) {
		throw createError({ statusCode: 404, statusMessage: 'Not Found' });
	}

	// Direct method: the key is served from the address's own domain, so the
	// request Host IS the domain we match against. Strip any `:port` suffix so a
	// self-host on a nonstandard port still matches its stored bare domain.
	const host = (getRequestHost(event) ?? '').toLowerCase().replace(/:\d+$/, '');
	if (!host) {
		throw createError({ statusCode: 404, statusMessage: 'Not Found' });
	}

	const client = publicConvexClient(event);
	const result = await client.query(api.e2ee.keys.getKeyForWkd, { domain: host, wkdHash: hash });
	if (!result) {
		throw createError({ statusCode: 404, statusMessage: 'Not Found' });
	}

	setResponseHeader(event, 'Content-Type', 'application/octet-stream');
	setResponseHeader(event, 'Cache-Control', 'no-store');
	return new Uint8Array(Buffer.from(result.binaryBase64, 'base64'));
});
