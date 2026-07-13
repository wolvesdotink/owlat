/**
 * GET /.well-known/owlat.json — this instance's signed manifest.
 *
 * A world-readable descriptor another Owlat instance fetches to discover our
 * E2EE capabilities and pin our signing key (TOFU): instance public key,
 * `features.e2ee`, the published key-directory digest, a rotation-feed URL, and
 * a detached OpenPGP signature over the whole payload. Derived server-side by
 * the `getSignedManifest` Convex action (which signs with the sealed instance
 * key); returns null — and this route 404s — before the instance identity has
 * been minted. Public; no authentication involved.
 */
import { api } from '@owlat/api';
import { publicConvexClient } from '../../utils/publicConvexClient';

export default defineEventHandler(async (event): Promise<unknown> => {
	const client = publicConvexClient(event);
	const manifest = await client.action(api.e2ee.manifest.getSignedManifest, {});
	if (!manifest) {
		throw createError({ statusCode: 404, statusMessage: 'Not Found' });
	}

	setResponseHeader(event, 'Content-Type', 'application/json; charset=utf-8');
	setResponseHeader(event, 'Cache-Control', 'no-store');
	return manifest;
});
