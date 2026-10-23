/**
 * Marketing notifications: "Autumn launch finished · 98% delivered", "Bounce
 * spike: sending protection on", "Webinar sends in 15 min", "Welcome series: 12
 * runs stalled", "mail.example.com: DNS check failed".
 *
 * Producers (see `noticeEvents.ts`) schedule `fanOut` with one occurrence. The
 * fan-out re-reads the source (`noticeResolvers.ts`), drops an occurrence that
 * no longer holds or was already announced, and writes one `marketingNotices`
 * row per member whose role may act on it (`noticePolicy.ts`) and whose switch
 * is on. Each row then goes out by Web Push (`push/dispatch.ts`, which asks
 * `isNoticeDeliverable` again at send time) and to every open app, which reads
 * `listRecent` and shows new rows as a toast and, on the desktop app, a native
 * notification.
 *
 * Everything read here is re-checked against the person's CURRENT role and the
 * instance's CURRENT feature flags, so a member demoted or a feature switched
 * off since the notice was written sees nothing.
 */

import { v } from 'convex/values';
import { components } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { getStoredFlags, resolveStoredFeatureFlags } from '../lib/featureFlags';
import { getSingletonOrganizationId, type OrganizationRole } from '../lib/sessionOrganization';
import {
	marketingNoticeEventValidator,
	marketingNotificationPreferenceValidator,
	MARKETING_NOTIFICATION_PREFERENCES,
	type MarketingNotificationPreference,
} from '../lib/validators/marketingNotifications';
import { internalMutation } from '../lib/writeFence';
import { enqueuePush } from '../push/events';
import {
	MARKETING_NOTICE_POLICY,
	PREFERENCE_FIELD,
	applicablePreferences,
	isNoticeFeatureOn,
	isNoticeRoleAllowed,
	isPreferenceOn,
	type ResolvedFlags,
} from './noticePolicy';
import { draftNotice, noticeLiveness, type NoticeLiveness } from './noticeResolvers';
import { campaignCancelUrl } from './noticeUrls';

/** Most members one occurrence is written for. */
const MAX_RECIPIENTS = 200;
/** Notices the app reads back per person; the newest first. */
const RECENT_LIMIT = 20;
/** How long a notice is kept; older ones are pruned on the person's next notice. */
const NOTICE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Rows pruned per write, so one write never turns into an unbounded sweep. */
const PRUNE_BATCH = 20;

async function loadFlags(ctx: QueryCtx | MutationCtx): Promise<ResolvedFlags> {
	return resolveStoredFeatureFlags(await getStoredFlags(ctx));
}

async function loadSwitches(
	ctx: QueryCtx | MutationCtx,
	userId: string
): Promise<Doc<'marketingNotificationSettings'> | null> {
	return await ctx.db
		.query('marketingNotificationSettings')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.first();
}

/** Members of this instance's organization whose role may hear about `kind`. */
async function loadRecipients(
	ctx: MutationCtx,
	kind: Doc<'marketingNotices'>['kind']
): Promise<string[]> {
	const organizationId = await getSingletonOrganizationId(ctx);
	const result = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
		model: 'member',
		where: [{ field: 'organizationId', value: organizationId }],
		paginationOpts: { cursor: null, numItems: MAX_RECIPIENTS },
	})) as { page?: Array<{ userId?: string; role?: string }> } | null;
	const userIds = (result?.page ?? [])
		.filter((member) => isNoticeRoleAllowed(kind, member.role as OrganizationRole))
		.map((member) => member.userId)
		.filter((userId): userId is string => typeof userId === 'string' && userId.length > 0);
	return [...new Set(userIds)].sort();
}

async function pruneOldNotices(ctx: MutationCtx, userId: string, now: number): Promise<void> {
	const stale = await ctx.db
		.query('marketingNotices')
		.withIndex('by_user_created', (q) =>
			q.eq('userId', userId).lt('createdAt', now - NOTICE_RETENTION_MS)
		)
		.take(PRUNE_BATCH);
	for (const row of stale) await ctx.db.delete(row._id);
}

/**
 * Turn one occurrence into notices. Idempotent per occurrence: a retried job
 * or a producer that reports the same occurrence twice finds the first write
 * and stops.
 */
export const fanOut = internalMutation({
	args: { event: marketingNoticeEventValidator },
	handler: async (ctx, { event }): Promise<{ written: number }> => {
		const now = Date.now();
		const draft = await draftNotice(ctx, event, now);
		if (!draft) return { written: 0 };
		if (!isNoticeFeatureOn(draft.kind, await loadFlags(ctx))) return { written: 0 };

		const announced = await ctx.db
			.query('marketingNotices')
			.withIndex('by_event_user', (q) => q.eq('eventKey', draft.eventKey))
			.first();
		if (announced) return { written: 0 };
		const { cooldownMs, ...fields } = draft;
		if (cooldownMs !== undefined) {
			const recent = await ctx.db
				.query('marketingNotices')
				.withIndex('by_subject_created', (q) =>
					q.eq('subjectKey', draft.subjectKey).gte('createdAt', now - cooldownMs)
				)
				.first();
			if (recent) return { written: 0 };
		}

		const preference = MARKETING_NOTICE_POLICY[draft.kind].preference;
		let written = 0;
		for (const userId of await loadRecipients(ctx, draft.kind)) {
			if (!isPreferenceOn(await loadSwitches(ctx, userId), preference)) continue;
			const noticeId = await ctx.db.insert('marketingNotices', {
				...fields,
				userId,
				createdAt: now,
			});
			await pruneOldNotices(ctx, userId, now);
			await enqueuePush(ctx, userId, { kind: 'marketing', noticeId });
			written++;
		}
		return { written };
	},
});

type NoticeGate = (notice: Doc<'marketingNotices'>, now: number) => Promise<NoticeLiveness | null>;

/**
 * Whether a stored notice may still reach this person now (null when not): it
 * is theirs, their current role may act on it, its feature is on, their switch
 * is on, and the occurrence still holds. Flags and switches are read once per
 * gate, so a reader checking a page of notices pays for them once.
 */
async function noticeGate(
	ctx: QueryCtx | MutationCtx,
	userId: string,
	role: OrganizationRole | null
): Promise<NoticeGate> {
	const flags = await loadFlags(ctx);
	const switches = await loadSwitches(ctx, userId);
	return async (notice, now) =>
		notice.userId === userId &&
		isNoticeRoleAllowed(notice.kind, role) &&
		isNoticeFeatureOn(notice.kind, flags) &&
		isPreferenceOn(switches, MARKETING_NOTICE_POLICY[notice.kind].preference)
			? await noticeLiveness(ctx, notice, now)
			: null;
}

/** {@link noticeGate} for one notice: what the push sender asks at send time. */
export async function isNoticeDeliverable(
	ctx: QueryCtx | MutationCtx,
	notice: Doc<'marketingNotices'>,
	userId: string,
	role: OrganizationRole | null,
	now: number
): Promise<boolean> {
	return (await (await noticeGate(ctx, userId, role))(notice, now)) !== null;
}

/**
 * The caller's newest notices that still hold, for the app to show the ones it
 * has not seen yet. The app seeds its "seen" set from the first answer, so a
 * backlog never replays as a burst of toasts. `liveUntil` rides along for a
 * notice that expires by the clock alone: the answer is not re-evaluated as
 * time passes, so the app checks it before acting on an answer it kept.
 */
// all-members: self-scoped — returns only notices addressed to session.userId.
export const listRecent = authedQuery({
	args: {},
	handler: async (ctx, _args, session) => {
		const rows = await ctx.db
			.query('marketingNotices')
			.withIndex('by_user_created', (q) => q.eq('userId', session.userId))
			.order('desc')
			.take(RECENT_LIMIT);
		const now = Date.now();
		const deliverable = await noticeGate(ctx, session.userId, session.role);
		const visible = [];
		for (const row of rows) {
			const liveness = await deliverable(row, now);
			if (liveness === null) continue;
			visible.push({
				id: row._id,
				kind: row.kind,
				createdAt: row.createdAt,
				url: row.url,
				...(row.kind === 'campaign_reminder' && row.campaignId
					? { cancelUrl: campaignCancelUrl(row.campaignId) }
					: {}),
				...(row.name !== undefined ? { name: row.name } : {}),
				...(row.percent !== undefined ? { percent: row.percent } : {}),
				...(row.count !== undefined ? { count: row.count } : {}),
				...(row.detail !== undefined ? { detail: row.detail } : {}),
				...(row.scheduledAt !== undefined ? { scheduledAt: row.scheduledAt } : {}),
				...(liveness.liveUntil !== undefined ? { liveUntil: liveness.liveUntil } : {}),
			});
		}
		return visible;
	},
});

/**
 * The caller's switches, limited to the ones that can ever fire for their role
 * on this instance (an editor never sees the admin-only DNS switch, an instance
 * without automations never shows the automation one).
 */
// all-members: self-scoped — reads only session.userId's own switches.
export const getMyPreferences = authedQuery({
	args: {},
	handler: async (ctx, _args, session) => {
		const kinds = applicablePreferences(session.role, await loadFlags(ctx));
		const row = await loadSwitches(ctx, session.userId);
		const enabled = Object.fromEntries(
			MARKETING_NOTIFICATION_PREFERENCES.map((preference) => [
				preference,
				isPreferenceOn(row, preference),
			])
		) as Record<MarketingNotificationPreference, boolean>;
		return { kinds, enabled };
	},
});

/** Turn one of the caller's switches on or off. */
// all-members: self-scoped — writes only session.userId's own switches.
export const setMyPreference = authedMutation({
	args: { preference: marketingNotificationPreferenceValidator, enabled: v.boolean() },
	handler: async (ctx, { preference, enabled }, session) => {
		const now = Date.now();
		const row = await loadSwitches(ctx, session.userId);
		if (row) {
			await ctx.db.patch(row._id, { [PREFERENCE_FIELD[preference]]: enabled, updatedAt: now });
		} else {
			await ctx.db.insert('marketingNotificationSettings', {
				userId: session.userId,
				[PREFERENCE_FIELD[preference]]: enabled,
				updatedAt: now,
			});
		}
		return null;
	},
});
