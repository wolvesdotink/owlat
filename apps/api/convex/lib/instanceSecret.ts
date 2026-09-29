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
 * a bearer token from the web server and check it themselves.
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
