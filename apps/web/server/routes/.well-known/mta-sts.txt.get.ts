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
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@owlat/api';
import { MTA_STS_CONTENT_TYPE } from '@owlat/shared/mtaStsPolicy';

/**
 * The MTA-STS policy file is valid ONLY on the `mta-sts.<domain>` host (RFC 8461
 * §3.2). Case-insensitive; a bare port suffix on the host is tolerated.
 */
export function isMtaStsHost(host: string): boolean {
	return host.toLowerCase().startsWith('mta-sts.');
}

export default defineEventHandler(async (event): Promise<string> => {
	const host = getRequestHost(event) ?? '';
	if (!isMtaStsHost(host)) {
		throw createError({ statusCode: 404, statusMessage: 'Not Found' });
	}

	const config = useRuntimeConfig(event);
	const convexUrl = (config.public as { convexUrl?: string }).convexUrl ?? '';
	if (!convexUrl) {
		throw createError({ statusCode: 404, statusMessage: 'Not Found' });
	}

	const client = new ConvexHttpClient(convexUrl);
	const policy = await client.query(api.domains.domains.getMtaStsPolicy, {});
	if (!policy) {
		throw createError({ statusCode: 404, statusMessage: 'Not Found' });
	}

	setResponseHeader(event, 'Content-Type', MTA_STS_CONTENT_TYPE);
	// Senders cache the fetched policy up to its own `max_age`; a modest HTTP
	// cache is fine and keeps the Convex query off the hot path.
	setResponseHeader(event, 'Cache-Control', 'public, max-age=3600');
	return policy.body;
});
