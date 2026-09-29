import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { getOptional } from './env';
import { secretMatches } from './crypto';
import { errorResponse } from './httpResponse';
import { getClientIp, rateLimitedResponse, type PublicRateLimitType } from './publicRateLimit';

/** Header operator tooling sends the on-box `INSTANCE_SECRET` in. */
const INSTANCE_SECRET_HEADER = 'X-Instance-Secret';

/** The limiter buckets an `X-Instance-Secret` route may charge. */
type InstanceSecretLimitType = Extract<PublicRateLimitType, 'adminSeed' | 'instanceSecret'>;

/**
 * Gate an HTTP route on the `X-Instance-Secret` header.
 *
 * Charges the caller's per-IP bucket first (the client IP comes from the shared
 * `lib/clientIp.ts` policy), then compares the header with `INSTANCE_SECRET` in
 * constant time. Charging before the comparison bounds how fast one address can
 * try values, whether or not its guess is right. The same secret also derives
 * the at-rest sealing keys, so every route that reads it from this header goes
 * through here. The upload service routes (`storage/uploadsHttp.ts`) take it as
 * a bearer token from the web server and go through `requireInstanceSecretBearer`
 * below, which charges only failures. The web app's own
 * `X-Instance-Secret` routes (self-update, configure-ip, the aggregated health
 * check) compare it in `apps/web/server/utils/updater.ts` without a throttle;
 * that file records why.
 *
 * Returns the 429 or 401 response to send, or `null` when the caller may proceed.
 */
export async function requireInstanceSecret(
	ctx: Pick<ActionCtx, 'runMutation'>,
	request: Request,
	{ limitType }: { limitType: InstanceSecretLimitType }
): Promise<Response | null> {
	const { ok, retryAfter } = await ctx.runMutation(
		internal.lib.publicRateLimit.checkPublicRateLimit,
		{ limitType, key: getClientIp(request) }
	);
	if (!ok) return rateLimitedResponse(retryAfter);

	const presented = request.headers.get(INSTANCE_SECRET_HEADER);
	if (!secretMatches(presented, getOptional('INSTANCE_SECRET'))) {
		return errorResponse('unauthenticated', 'Unauthorized');
	}
	return null;
}

/** True when the `Authorization: Bearer` token matches the current or previous secret. */
function bearerMatchesInstanceSecret(request: Request): boolean {
	const current = getOptional('INSTANCE_SECRET');
	if (!current) return false;
	const header = request.headers.get('authorization') ?? '';
	if (!header.startsWith('Bearer ')) return false;
	const token = header.slice(7);
	return (
		secretMatches(token, current) || secretMatches(token, getOptional('INSTANCE_SECRET_PREVIOUS'))
	);
}

/**
 * Gate a route on the instance secret sent as a bearer token by the web server
 * (the upload service routes). `INSTANCE_SECRET_PREVIOUS` is accepted during a
 * rotation.
 *
 * Unlike `requireInstanceSecret`, the comparison runs first and only a FAILED
 * compare charges the caller's per-IP `instanceSecret` bucket. The web server
 * reaches these routes in bursts, often from the shared `'unknown'` bucket, so a
 * throttle checked before the compare would let failing callers stall uploads.
 * A matching secret never reads or spends the bucket. A caller that keeps
 * failing gets 429 with `Retry-After` instead of 401 once its bucket is empty.
 *
 * Returns the 429 or 401 response to send, or `null` when the caller may proceed.
 */
export async function requireInstanceSecretBearer(
	ctx: Pick<ActionCtx, 'runMutation'>,
	request: Request
): Promise<Response | null> {
	if (bearerMatchesInstanceSecret(request)) return null;
	const { ok, retryAfter } = await ctx.runMutation(
		internal.lib.publicRateLimit.checkPublicRateLimit,
		{ limitType: 'instanceSecret', key: getClientIp(request) }
	);
	return ok ? errorResponse('unauthenticated', 'Unauthorized') : rateLimitedResponse(retryAfter);
}
