import { getOptional } from '../lib/env';

/**
 * Client-IP resolution for BetterAuth's built-in login/rate limiter, kept in
 * lockstep with `publicRateLimit.getClientIp`.
 *
 * Forwarded headers (`CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`) are
 * CLIENT-SUPPLIED. A caller hitting the directly-reachable Convex origin can set
 * any value, so trusting the *leftmost* `X-Forwarded-For` entry (BetterAuth's
 * unconfigured default) lets an attacker mint a fresh limiter bucket per request
 * and defeat the login/reset throttle entirely (password brute-force,
 * reset-mail flooding).
 *
 * We therefore believe a header only when the deployment declares its fronting
 * proxy via `RATE_LIMIT_TRUSTED_PROXY` (the SAME switch the public limiter uses):
 *   - `cloudflare` → `CF-Connecting-IP` (Cloudflare overwrites it).
 *   - `xrealip`    → `X-Real-IP` (set by the immediate proxy).
 *   - `xforwarded` → `X-Forwarded-For`; with `RATE_LIMIT_TRUSTED_PROXIES` set,
 *                    BetterAuth walks the chain RIGHT-to-left, skips trusted
 *                    hops, and keys the first untrusted (real client) entry — so
 *                    injected leftmost hops are ignored. Without it, only a
 *                    single-value header is trusted and a multi-hop chain fails
 *                    closed.
 * Unset / unrecognised ⇒ NO header is trusted, but the limiter stays ON. We pass
 * an EMPTY `ipAddressHeaders` list (NOT `disableIpTracking`): BetterAuth then
 * resolves no client IP and keys every caller into the single shared
 * `no-trusted-ip` bucket — coarse, but a spoofed header can never multiply
 * buckets AND sign-in/reset are still throttled. `disableIpTracking` would
 * instead turn the login/reset limiter OFF entirely (getIp → null →
 * resolveRateLimitConfig returns null → no throttle), a fail-OPEN regression, so
 * we never use it here. Mirrors publicRateLimit's 'unknown' posture.
 */
type BetterAuthIpAddressConfig = {
	ipAddressHeaders?: string[];
	trustedProxies?: string[];
	disableIpTracking?: boolean;
};

export function resolveBetterAuthIpAddressConfig(): BetterAuthIpAddressConfig {
	const mode = getOptional('RATE_LIMIT_TRUSTED_PROXY')?.trim().toLowerCase();

	if (mode === 'cloudflare') {
		return { ipAddressHeaders: ['cf-connecting-ip'] };
	}
	if (mode === 'xrealip') {
		return { ipAddressHeaders: ['x-real-ip'] };
	}
	if (mode === 'xforwarded' || mode?.startsWith('xforwarded:')) {
		// NOTE: the `xforwarded:<hops>` numeric suffix (honoured by the PUBLIC
		// limiter's getClientIp) is IGNORED here — BetterAuth skips trusted hops by
		// IP via `trustedProxies`, not by count. Supply RATE_LIMIT_TRUSTED_PROXIES
		// to trust a multi-hop chain; without it only a single-value XFF is trusted
		// (multi-hop degrades safely to single-value-only trust).
		const trustedProxies = (getOptional('RATE_LIMIT_TRUSTED_PROXIES') ?? '')
			.split(/[\s,]+/)
			.map((entry) => entry.trim())
			.filter(Boolean);
		return {
			ipAddressHeaders: ['x-forwarded-for'],
			...(trustedProxies.length > 0 ? { trustedProxies } : {}),
		};
	}

	// Fail closed WITHOUT failing open: an empty header list means no spoofable
	// header is trusted (a direct-origin attacker can't mint a fresh bucket per
	// request), while the limiter stays active on the shared `no-trusted-ip`
	// bucket. `disableIpTracking` is deliberately NOT used — it would disable the
	// login/reset limiter altogether.
	return { ipAddressHeaders: [] };
}
