import { v, type Infer } from 'convex/values';
import { internalMutation } from './writeFence';
import { rateLimiter } from './rateLimiter';
import {
	getTrustedProxyMode,
	isSecretGatedMode,
	PROXY_SECRET_HEADER,
	resolveClientIp,
	SECRET_GATED_IP_HEADER,
} from './clientIp';
import { logWarn } from './runtimeLog';

/**
 * Rate limit types for public endpoints. The validator is the single source —
 * the TS type is derived from it and the mutation arg reuses it.
 */
const publicRateLimitTypeValidator = v.union(
	v.literal('formSubmission'),
	v.literal('emailTracking'),
	v.literal('subscriptionManagement'),
	v.literal('doiConfirmation'),
	v.literal('webhookIngestion'),
	v.literal('adminSeed'),
	v.literal('instanceSecret'),
	v.literal('uploadServiceSecret'),
	v.literal('bookingPage'),
	v.literal('bookingCreate')
);
export type PublicRateLimitType = Infer<typeof publicRateLimitTypeValidator>;

/**
 * Resolve the client IP used as the per-IP rate-limit key for public endpoints.
 *
 * The trust decision is `lib/clientIp.ts`'s, shared with BetterAuth's sign-in
 * limiter (`auth/ipAddress.ts`): which forwarded header `RATE_LIMIT_TRUSTED_PROXY`
 * selects, the right-anchored `X-Forwarded-For` read, and the rule that
 * `CF-Connecting-IP` / `X-Real-IP` count only when `X-Owlat-Proxy-Secret`
 * verifies against `RATE_LIMIT_PROXY_SECRET`. Anything untrusted maps to the
 * shared `'unknown'` bucket: coarser, but a spoofed header can never multiply
 * the allowed volume.
 *
 * This wrapper adds the once-per-warm-instance config warnings: one when the
 * mode is unset (per-IP form limits collapse to one shared window), one when a
 * secret-gated mode is selected (it needs the proxy to inject the secret).
 */
// Emit each advisory at most once per warm instance so a busy endpoint doesn't
// flood the logs.
let warnedMissingTrustedProxy = false;
let warnedSpoofableProxyMode = false;

export function getClientIp(request: Request): string {
	const mode = getTrustedProxyMode();
	if (mode.kind === 'unset' && !warnedMissingTrustedProxy) {
		warnedMissingTrustedProxy = true;
		logWarn(
			"[publicRateLimit] RATE_LIMIT_TRUSTED_PROXY is not set — every caller shares one rate-limit bucket ('unknown'), so per-IP form-submission limits cannot isolate clients. Set RATE_LIMIT_TRUSTED_PROXY (cloudflare | xforwarded[:hops] | xrealip) to match your reverse proxy to restore per-IP limiting."
		);
	}
	if (isSecretGatedMode(mode) && !warnedSpoofableProxyMode) {
		warnedSpoofableProxyMode = true;
		logWarn(
			`[publicRateLimit] RATE_LIMIT_TRUSTED_PROXY='${mode.kind}' reads a client-settable header (${SECRET_GATED_IP_HEADER[mode.kind]}). A Convex deployment is directly reachable at its *.convex.site URL, so this header is trusted ONLY when the request also presents ${PROXY_SECRET_HEADER} matching RATE_LIMIT_PROXY_SECRET, which your trusted proxy must inject (and strip from client requests). Without RATE_LIMIT_PROXY_SECRET configured, every caller falls back to one shared 'unknown' bucket, for public endpoints and for sign-in / password reset alike. Prefer RATE_LIMIT_TRUSTED_PROXY='xforwarded', which reads the proxy-appended entry from the right and needs no secret.`
		);
	}
	return resolveClientIp(request, mode);
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
