import { getOptional } from './env';
import { secretMatches } from './crypto';

/**
 * Client-IP trust policy shared by BOTH rate limiters:
 *   - the public-endpoint limiter (`publicRateLimit.getClientIp`), and
 *   - BetterAuth's sign-in / password-reset limiter (`auth/ipAddress.ts`).
 *
 * `RATE_LIMIT_TRUSTED_PROXY` is parsed here, once, and the rule "a header the
 * client can set is believed only when the proxy secret verifies" lives here,
 * so the two limiters cannot drift apart on which forwarded header they trust.
 *
 * Forwarded headers (`CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`) are
 * client-supplied. A Convex deployment is directly reachable at its
 * `*.convex.site` URL (or its site port), so a request can carry any value
 * without passing through the fronting proxy. Keying a limiter on such a value
 * would give every distinct value its own bucket.
 *
 * Modes:
 *   - unset / unrecognised → no header is trusted; every caller shares one bucket.
 *   - `xforwarded[:<hops>]` → `X-Forwarded-For`, read from the right, where the
 *     trusted proxy appends the peer it saw. Needs no secret. The two limiters
 *     read the chain differently (see `resolveBetterAuthIpAddressConfig`).
 *   - `cloudflare` → `CF-Connecting-IP`, `xrealip` → `X-Real-IP`. Both headers
 *     are client-settable, so they are trusted ONLY when the request also
 *     presents `X-Owlat-Proxy-Secret` equal to `RATE_LIMIT_PROXY_SECRET`
 *     (constant-time compared). The proxy injects that header and strips any
 *     client copy. No secret configured, or a missing/wrong one → the header is
 *     not trusted and the caller lands in the shared bucket.
 */

/** Header the trusted reverse proxy injects, carrying `RATE_LIMIT_PROXY_SECRET`. */
export const PROXY_SECRET_HEADER = 'X-Owlat-Proxy-Secret';

/** Modes whose IP header is client-settable and therefore needs the proxy secret. */
type SecretGatedModeKind = 'cloudflare' | 'xrealip';

export type TrustedProxyMode =
	| { kind: 'unset' }
	| { kind: 'unrecognised'; raw: string }
	| { kind: SecretGatedModeKind }
	| { kind: 'xforwarded'; hops: number };

/** The client-IP header each secret-gated mode reads. */
export const SECRET_GATED_IP_HEADER: Record<SecretGatedModeKind, string> = {
	cloudflare: 'CF-Connecting-IP',
	xrealip: 'X-Real-IP',
};

/** Parse a raw `RATE_LIMIT_TRUSTED_PROXY` value. */
function parseTrustedProxyMode(raw: string | undefined): TrustedProxyMode {
	const mode = raw?.trim().toLowerCase();
	if (!mode) return { kind: 'unset' };
	if (mode === 'cloudflare' || mode === 'xrealip') return { kind: mode };
	if (mode === 'xforwarded' || mode.startsWith('xforwarded:')) {
		// `xforwarded:<hops>` — number of trusted proxies appending to XFF.
		const hops = Math.max(1, Number.parseInt(mode.split(':')[1] ?? '1', 10) || 1);
		return { kind: 'xforwarded', hops };
	}
	return { kind: 'unrecognised', raw: mode };
}

/** The deployment's configured trusted-proxy mode. */
export function getTrustedProxyMode(): TrustedProxyMode {
	return parseTrustedProxyMode(getOptional('RATE_LIMIT_TRUSTED_PROXY'));
}

export function isSecretGatedMode(mode: TrustedProxyMode): mode is { kind: SecretGatedModeKind } {
	return mode.kind === 'cloudflare' || mode.kind === 'xrealip';
}

/**
 * Whether the request presents the configured proxy secret. False when
 * `RATE_LIMIT_PROXY_SECRET` is unset, so an empty configuration never verifies.
 */
function hasVerifiedProxySecret(request: Request): boolean {
	const proxySecret = getOptional('RATE_LIMIT_PROXY_SECRET');
	const presented = request.headers.get(PROXY_SECRET_HEADER);
	return secretMatches(presented, proxySecret);
}

/**
 * Resolve the client IP used as a per-IP rate-limit key, or `'unknown'` (the
 * shared bucket) when no forwarded header is trusted for this request.
 */
export function resolveClientIp(
	request: Request,
	mode: TrustedProxyMode = getTrustedProxyMode()
): string {
	if (isSecretGatedMode(mode)) {
		if (!hasVerifiedProxySecret(request)) return 'unknown';
		return request.headers.get(SECRET_GATED_IP_HEADER[mode.kind])?.trim() || 'unknown';
	}
	if (mode.kind === 'xforwarded') {
		const parts = (request.headers.get('X-Forwarded-For') ?? '')
			.split(',')
			.map((p) => p.trim())
			.filter(Boolean);
		// The real client is `hops` entries from the right; entries to its left are
		// caller-supplied and untrusted.
		return parts[parts.length - mode.hops] || 'unknown';
	}
	return 'unknown';
}

/**
 * Return the request with the secret-gated IP header removed when the proxy
 * secret does not verify. For the sign-in limiter, whose header list is static
 * configuration and cannot check a per-request secret: with the header gone,
 * BetterAuth resolves no client IP and keys the request into its single shared
 * bucket, the same outcome as the public limiter's `'unknown'` bucket. Other
 * modes, and requests that verify, pass through unchanged.
 */
export function withoutUnverifiedForwardedIp(
	request: Request,
	mode: TrustedProxyMode = getTrustedProxyMode()
): Request {
	if (!isSecretGatedMode(mode)) return request;
	const header = SECRET_GATED_IP_HEADER[mode.kind];
	if (!request.headers.has(header) || hasVerifiedProxySecret(request)) return request;
	const headers = new Headers(request.headers);
	headers.delete(header);
	return new Request(request, { headers });
}
