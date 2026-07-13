/**
 * GET /.well-known/openpgpkey/policy — the WKD policy file (direct method,
 * draft-koch-openpgp-webkey-service §3.1).
 *
 * Its mere presence signals that this host publishes keys over WKD; the body is
 * an (optionally flag-bearing) plain-text file. We publish an empty policy —
 * i.e. no special flags — served as `text/plain`. Public and content-free, so no
 * authentication is involved.
 */
export default defineEventHandler((event): string => {
	setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8');
	setResponseHeader(event, 'Cache-Control', 'public, max-age=3600');
	return '';
});
