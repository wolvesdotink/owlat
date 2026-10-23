/**
 * Web Push for marketing notices: the notice is re-checked at send time (still
 * this person's, their role and switch still allow it, the occurrence still
 * holds) and turned into copy. A reminder lives on the push service only until
 * its campaign starts: a phone that comes back online after that never shows
 * "sends in 15 min" for a campaign that is already out.
 *
 * Not a Convex function module; called by `push/dispatch.ts`.
 */

import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import type { OrganizationRole } from '../lib/sessionOrganization';
import { isNoticeDeliverable } from '../marketing/notifications';
import type { PushPayload } from './copy';
import { marketingPayload } from './marketingCopy';

/** How long a push service holds an undelivered marketing notice. */
const MARKETING_TTL_SECONDS = 12 * 3600;

export async function resolveMarketingPush(
	ctx: MutationCtx,
	userId: string,
	noticeId: Id<'marketingNotices'>,
	prefs: { locale: string | undefined; isPrivate: boolean },
	role: OrganizationRole,
	now: number
): Promise<{ payload: PushPayload; ttlSeconds: number } | null> {
	const notice = await ctx.db.get(noticeId);
	if (!notice || !(await isNoticeDeliverable(ctx, notice, userId, role, now))) return null;
	const ttlSeconds =
		notice.kind === 'campaign_reminder' && notice.scheduledAt !== undefined
			? Math.max(1, Math.floor((notice.scheduledAt - now) / 1000))
			: MARKETING_TTL_SECONDS;
	return { payload: marketingPayload(notice, prefs.locale, prefs.isPrivate, now), ttlSeconds };
}
