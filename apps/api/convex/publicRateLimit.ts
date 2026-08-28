import { v, type Infer } from 'convex/values';
import { internalMutation } from './_generated/server';
import { rateLimiter } from './rateLimiter';
import { getOptional } from './lib/env';
import { logWarn } from './lib/runtimeLog';
import { safeCompare } from './lib/safeCompare';

/**
 * Header a trusted reverse proxy INJECTS (and strips from inbound client
 * requests) carrying `RATE_LIMIT_PROXY_SECRET`. Required to authenticate the
 * `cloudflare` / `xrealip` modes, which otherwise trust a client-settable IP
 * header. See `getClientIp`.
 */
const PROXY_SECRET_HEADER = 'X-Owlat-Proxy-Secret';

/**
 * Rate limit types for public endpoints. The validator is the single source —
 * the TS type is derived from it and the mutation arg reuses it.
 */
export const publicRateLimitTypeValidator = v.union(
	v.literal('formSubmission'),
	v.literal('emailTracking'),
	v.literal('subscriptionManagement'),
	v.literal('doiConfirmation'),
	v.literal('webhookIngestion'),
	v.literal('adminSeed')
);
export type PublicRateLimitType = Infer<typeof publicRateLimitTypeValidator>;

/**
 * Resolve the client IP used as the per-IP rate-limit key for public endpoints.
 *
 * Forwarded headers (`CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`) are
 * CLIENT-SUPPLIED: a caller hitting the deployment directly can set any value,
 * so naively trusting them — especially the *leftmost* `X-Forwarded-For` entry,
 * which is precisely the attacker-controlled one — lets an attacker mint a fresh
 * rate-limit bucket per request and bypass the limit entirely (form/DOI-email
 * flooding, tracking-pixel/webhook abuse).
 *
 * We therefore trust a header only when the deployment declares which trusted
 * proxy sits in front, via `RATE_LIMIT_TRUSTED_PROXY`:
 *   - `xforwarded[:<hops>]`   → `X-Forwarded-For`, read `<hops>` entries from the
 *                               RIGHT (default 1). The trusted proxy appends the
 *                               real client as the rightmost entry, so any
 *                               client-injected leftmost entries are ignored.
 *                               THIS IS THE DOCUMENTED SAFE DEFAULT: a single
 *                               trusted reverse proxy (e.g. Caddy) appending one
 *                               entry is bypass-resistant on its own, because the
 *                               attacker's forged entries can only land to the
 *                               left of the one we read.
 *   - `cloudflare`            → `CF-Connecting-IP` (Cloudflare overwrites it).
 *   - `xrealip`               → `X-Real-IP` (set by the immediate proxy).
 *
 * When unset (or unrecognised), no header is trusted and all callers share a
 * single bucket ('unknown'): coarser, but a spoofed header can never multiply
 * the allowed volume. This collapses the per-IP form-submission limit to one
 * shared window, so a config WARN is emitted once per warm instance to flag
 * that `RATE_LIMIT_TRUSTED_PROXY` is required for per-IP form limits.
 * Deployments behind a known proxy SHOULD set this for per-client limiting.
 *
 * TRUST CAVEAT — `cloudflare` and `xrealip` read a header that is client-settable
 * (there's no socket-peer attribution in a Convex httpAction, so we can't verify
 * the request actually transited the named proxy). A Convex deployment is
 * directly reachable at its `*.convex.site` URL, so an attacker who bypasses the
 * proxy could forge that header and mint one bucket per forged value. To close
 * that bypass the code REQUIRES a proxy-injected shared secret: the trusted proxy
 * sets `X-Owlat-Proxy-Secret: <RATE_LIMIT_PROXY_SECRET>` (and strips any client
 * copy), and the forwarded IP is believed ONLY when that header is present and
 * constant-time-equals the configured secret. When `RATE_LIMIT_PROXY_SECRET` is
 * unset, or the presented secret is absent/wrong, we FAIL CLOSED to the shared
 * 'unknown' bucket rather than trust the spoofable header — so selecting either
 * mode WITHOUT configuring the secret gives coarse (not bypassable) limiting, and
 * a hard startup WARN points at the trap. Prefer `xforwarded`, which reads the
 * proxy-appended entry from the right and is bypass-resistant for a single
 * trusted reverse proxy without any secret.
 */
// Emit the "no trusted proxy configured" advisory at most once per warm
// instance so a busy endpoint doesn't flood the logs.
let warnedMissingTrustedProxy = false;
// And, symmetrically, warn once when an UNCONDITIONALLY-trusted header mode
// (cloudflare / xrealip) is selected — those are safe only behind infra-level
// origin fencing the code can't verify.
let warnedSpoofableProxyMode = false;

export function getClientIp(request: Request): string {
	const mode = getOptional('RATE_LIMIT_TRUSTED_PROXY')?.trim().toLowerCase();
	if (!mode) {
		if (!warnedMissingTrustedProxy) {
			warnedMissingTrustedProxy = true;
			logWarn(
				"[publicRateLimit] RATE_LIMIT_TRUSTED_PROXY is not set — every caller shares one rate-limit bucket ('unknown'), so per-IP form-submission limits cannot isolate clients. Set RATE_LIMIT_TRUSTED_PROXY (cloudflare | xforwarded[:hops] | xrealip) to match your reverse proxy to restore per-IP limiting."
			);
		}
		return 'unknown';
	}

	if (mode === 'cloudflare' || mode === 'xrealip') {
		if (!warnedSpoofableProxyMode) {
			warnedSpoofableProxyMode = true;
			logWarn(
				`[publicRateLimit] RATE_LIMIT_TRUSTED_PROXY='${mode}' reads a client-settable header (${mode === 'cloudflare' ? 'CF-Connecting-IP' : 'X-Real-IP'}). A Convex deployment is directly reachable at its *.convex.site URL, so this header is trusted ONLY when the request also presents ${PROXY_SECRET_HEADER} matching RATE_LIMIT_PROXY_SECRET, which your trusted proxy must inject (and strip from client requests). Without RATE_LIMIT_PROXY_SECRET configured, every caller falls back to one shared 'unknown' bucket. Prefer RATE_LIMIT_TRUSTED_PROXY='xforwarded', which reads the proxy-appended entry from the right and needs no secret.`
			);
		}
		// Fail closed unless the proxy-injected shared secret authenticates the
		// request: a forged CF-Connecting-IP / X-Real-IP from a caller hitting
		// *.convex.site directly cannot carry the secret, so it can never mint a
		// fresh per-IP bucket. Constant-time compare to avoid a timing side channel.
		const proxySecret = getOptional('RATE_LIMIT_PROXY_SECRET');
		const presented = request.headers.get(PROXY_SECRET_HEADER);
		if (!proxySecret || !presented || !safeCompare(presented, proxySecret)) {
			return 'unknown';
		}
		const header = mode === 'cloudflare' ? 'CF-Connecting-IP' : 'X-Real-IP';
		return request.headers.get(header)?.trim() || 'unknown';
	}

	if (mode === 'xforwarded' || mode.startsWith('xforwarded:')) {
		// `xforwarded:<hops>` — number of trusted proxies appending to XFF.
		const hops = Math.max(1, Number.parseInt(mode.split(':')[1] ?? '1', 10) || 1);
		const parts = (request.headers.get('X-Forwarded-For') ?? '')
			.split(',')
			.map((p) => p.trim())
			.filter(Boolean);
		// The real client is `hops` entries from the right; entries to its left are
		// caller-supplied and untrusted.
		const ip = parts[parts.length - hops];
		return ip || 'unknown';
	}

	return 'unknown';
}

/**
 * Internal mutation to check and consume a rate limit by IP
 */
export const checkPublicRateLimit = internalMutation({
	args: {
		limitType: publicRateLimitTypeValidator,
		key: v.string(),
	},
	handler: async (ctx, args) => {
		const { ok, retryAfter } = await rateLimiter.limit(ctx, args.limitType, {
			key: args.key,
		});

		return {
			ok,
			retryAfter: retryAfter ?? 0,
		};
	},
});

/**
 * Options for rate limited response
 */
interface RateLimitedResponseOptions {
	returnBodyOnRateLimit?: boolean;
	corsHeaders?: Record<string, string>;
}

/**
 * Create a 429 rate limited response
 */
export function rateLimitedResponse(
	retryAfter: number,
	options: RateLimitedResponseOptions = {}
): Response {
	const { returnBodyOnRateLimit = true, corsHeaders = {} } = options;

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'Retry-After': String(Math.ceil(retryAfter / 1000)),
		...corsHeaders,
	};

	const body = returnBodyOnRateLimit
		? JSON.stringify({
				error: {
					category: 'rate_limited',
					message: 'Rate limit exceeded. Please try again later.',
				},
			})
		: null;

	return new Response(body, {
		status: 429,
		headers,
	});
}
