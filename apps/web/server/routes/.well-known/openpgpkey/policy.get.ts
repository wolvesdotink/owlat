/**
 * GET /.well-known/openpgpkey/policy — the WKD policy file (direct method,
 * draft-koch-openpgp-webkey-service §3.1).
 *
 * Its mere presence signals that this host publishes keys over WKD; the body is
 * an (optionally flag-bearing) plain-text file. We publish an empty policy —
 * i.e. no special flags — served as `text/plain`. Public and content-free, so no
 * authentication is involved.
 */
import { api } from '@owlat/api';
import { publicConvexClient } from '../../../utils/publicConvexClient';

export default defineEventHandler(async (event): Promise<string> => {
	const client = publicConvexClient(event);
	const flags = await client.query(api.workspaces.featureFlags.getFeatureFlags, {});
	if (!flags.sealedMail) {
		throw createError({ statusCode: 404, statusMessage: 'Not Found' });
	}
	setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8');
	setResponseHeader(event, 'Cache-Control', 'no-store');
	return '';
});
