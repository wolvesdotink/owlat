/**
 * GET /.well-known/mta-sts.txt — serve this deployment's own MTA-STS policy
 * (RFC 8461 §3.2).
 *
 * MTA-STS requires the policy file to be served over HTTPS from the
 * `mta-sts.<domain>` host ONLY. This route is therefore HOST-MATCHED: it answers
 * only when the request `Host` is `mta-sts.<something>`, and 404s on any other
 * host (including the primary web host) so the policy can't be fetched from the
 * wrong origin. The policy body itself is derived server-side by the public
 * `getMtaStsPolicy` Convex query (the single source of truth shared with the DNS
 * guidance + verify surfaces), which returns null — and this route 404s — when
 * nothing is being published (`mtaStsMode` unset/`none`, or no inbound mail
 * host). The file is public and carries only the deployment's own MX host, so no
 * authentication is involved.
 */
import { api } from '@owlat/api';
import { MTA_STS_CONTENT_TYPE, MTA_STS_POLICY_HOST } from '@owlat/shared/mtaStsPolicy';
import { publicConvexClient } from '../../utils/publicConvexClient';

/**
 * The MTA-STS policy file is valid ONLY on the `mta-sts.<domain>` host (RFC 8461
 * §3.2). Case-insensitive; a bare port suffix on the host is tolerated. The
 * label is derived from `MTA_STS_POLICY_HOST` so it stays in lockstep with the
 * DNS-guidance/verify surfaces (one source of truth for `mta-sts`).
 */
export function isMtaStsHost(host: string): boolean {
	return host.toLowerCase().startsWith(`${MTA_STS_POLICY_HOST}.`);
}

export default defineEventHandler(async (event): Promise<string> => {
	const host = getRequestHost(event) ?? '';
	if (!isMtaStsHost(host)) {
		throw createError({ statusCode: 404, statusMessage: 'Not Found' });
	}

	const client = publicConvexClient(event);
	const policy = await client.query(api.domains.mtaSts.getMtaStsPolicy, {});
	if (!policy) {
		throw createError({ statusCode: 404, statusMessage: 'Not Found' });
	}

	setResponseHeader(event, 'Content-Type', MTA_STS_CONTENT_TYPE);
	// Senders cache the fetched policy up to its own `max_age`; a modest HTTP
	// cache is fine and keeps the Convex query off the hot path.
	setResponseHeader(event, 'Cache-Control', 'public, max-age=3600');
	return policy.body;
});
