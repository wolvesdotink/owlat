/**
 * Web Push for marketing notices: the notice is re-checked at send time (still
 * this person's, their role and switch still allow it, the occurrence still
 * holds) and turned into copy. A notice that expires by the clock lives on the
 * push service only until then: a phone that comes back online later never
 * shows "sends in 15 min" for a campaign that is already out, or "sending
 * protection on" from a breaker snapshot the router no longer trusts.
 *
 * Not a Convex function module; called by `push/dispatch.ts`.
 */

import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import type { OrganizationRole } from '../lib/sessionOrganization';
import { noticeDeliverability } from '../marketing/notifications';
import type { PushPayload } from './copy';
import { marketingPayload } from './marketingCopy';

/** How long a push service holds an undelivered marketing notice. */
const MARKETING_TTL_SECONDS = 12 * 3600;

/**
 * Whole seconds left until `liveUntil` (the last instant the notice holds),
 * rounded down so the push never outlives it. Under a second left gives 0,
 * which a push service reads as "deliver now or drop".
 */
function remainingTtlSeconds(liveUntil: number, now: number): number {
	return Math.max(0, Math.floor((liveUntil + 1 - now) / 1000));
}

export async function resolveMarketingPush(
	ctx: MutationCtx,
	userId: string,
	noticeId: Id<'marketingNotices'>,
	prefs: { locale: string | undefined; isPrivate: boolean },
	role: OrganizationRole,
	now: number
): Promise<{ payload: PushPayload; ttlSeconds: number } | null> {
	const notice = await ctx.db.get(noticeId);
	if (!notice) return null;
	const liveness = await noticeDeliverability(ctx, notice, userId, role, now);
	if (liveness === null) return null;
	const ttlSeconds =
		liveness.liveUntil === undefined
			? MARKETING_TTL_SECONDS
			: remainingTtlSeconds(liveness.liveUntil, now);
	return { payload: marketingPayload(notice, prefs.locale, prefs.isPrivate, now), ttlSeconds };
}
