import { getOptional } from '../lib/env';
import {
	getTrustedProxyMode,
	isSecretGatedMode,
	PROXY_SECRET_HEADER,
	SECRET_GATED_IP_HEADER,
	withoutUnverifiedForwardedIp,
	type TrustedProxyMode,
} from '../lib/clientIp';
import { logWarn } from '../lib/runtimeLog';

/**
 * Client-IP resolution for BetterAuth's built-in sign-in / password-reset
 * limiter, derived from the shared policy in `lib/clientIp.ts` (the same one
 * `publicRateLimit.getClientIp` uses).
 *
 * BetterAuth reads the client IP from a STATIC header list, so it cannot check
 * the per-request proxy secret the `cloudflare` / `xrealip` modes require. The
 * secret is therefore checked in front of BetterAuth, by `withVerifiedClientIp`
 * on the `/api/auth/*` HTTP route: an unverified request has the IP header
 * removed before BetterAuth sees it. Per mode:
 *   - `cloudflare` → `CF-Connecting-IP`, `xrealip` → `X-Real-IP`, each only on a
 *     request whose `X-Owlat-Proxy-Secret` verifies; otherwise the shared bucket.
 *   - `xforwarded` → `X-Forwarded-For`; with `RATE_LIMIT_TRUSTED_PROXIES` set,
 *     BetterAuth walks the chain right-to-left, skips trusted hops, and keys the
 *     first untrusted entry. Without it, only a single-value header is trusted
 *     and a multi-hop chain lands in the shared bucket. The `:<hops>` suffix the
 *     public limiter honours is ignored here.
 *   - unset / unrecognised → no header is trusted; the shared bucket.
 *
 * "The shared bucket" is BetterAuth's `no-trusted-ip` key: when no client IP
 * resolves, the limiter keeps throttling on one per-path bucket. An empty
 * `ipAddressHeaders` list is used for that, never `disableIpTracking`, which
 * would turn the sign-in / reset limiter off entirely.
 */
type BetterAuthIpAddressConfig = {
	ipAddressHeaders?: string[];
	trustedProxies?: string[];
	disableIpTracking?: boolean;
};

export function resolveBetterAuthIpAddressConfig(
	mode: TrustedProxyMode = getTrustedProxyMode()
): BetterAuthIpAddressConfig {
	switch (mode.kind) {
		case 'cloudflare':
		case 'xrealip':
			// Safe only together with `withVerifiedClientIp` on the auth route, which
			// removes this header from any request whose proxy secret does not verify.
			return { ipAddressHeaders: [SECRET_GATED_IP_HEADER[mode.kind].toLowerCase()] };
		case 'xforwarded': {
			const trustedProxies = (getOptional('RATE_LIMIT_TRUSTED_PROXIES') ?? '')
				.split(/[\s,]+/)
				.map((entry) => entry.trim())
				.filter(Boolean);
			return {
				ipAddressHeaders: ['x-forwarded-for'],
				...(trustedProxies.length > 0 ? { trustedProxies } : {}),
			};
		}
		default:
			return { ipAddressHeaders: [] };
	}
}

// Emit the removed-header advisory at most once per warm instance.
let warnedUnverifiedHeader = false;

/**
 * Wrap a BetterAuth instance so every request reaching its HTTP handler first
 * goes through the proxy-secret check (`withoutUnverifiedForwardedIp`). Used
 * where `/api/auth/*` is registered on the HTTP router. The first time a header
 * is removed, log why, so a deployment whose traffic is mostly sign-in still
 * learns that its proxy is not presenting the secret.
 */
export function withVerifiedClientIp<
	Auth extends { handler: (request: Request) => Promise<Response> },
>(auth: Auth): Auth {
	return {
		...auth,
		handler: (request: Request) => {
			const mode = getTrustedProxyMode();
			const checked = withoutUnverifiedForwardedIp(request, mode);
			if (checked !== request && isSecretGatedMode(mode) && !warnedUnverifiedHeader) {
				warnedUnverifiedHeader = true;
				logWarn(
					`[auth] RATE_LIMIT_TRUSTED_PROXY='${mode.kind}': ignored ${SECRET_GATED_IP_HEADER[mode.kind]} on an /api/auth request because ${PROXY_SECRET_HEADER} did not match RATE_LIMIT_PROXY_SECRET (or RATE_LIMIT_PROXY_SECRET is unset). Such sign-in and password-reset requests share one rate-limit bucket. Have your trusted proxy inject ${PROXY_SECRET_HEADER} on every origin that reaches /api/auth, including the web app origin.`
				);
			}
			return auth.handler(checked);
		},
	};
}
