/**
 * From a producer's occurrence to the notice people get, and back: does a
 * stored notice still hold?
 *
 * `draftNotice` re-reads the source rows when the fan-out runs, so an
 * occurrence that no longer holds (a campaign deleted, a reminder whose
 * campaign was rescheduled or cancelled, an alert already resolved) produces
 * nothing, and the copy carries current names. `isNoticeLive` asks the same
 * question of a stored notice before it is pushed or shown in the app.
 *
 * Not a Convex function module.
 */

import { DELIVERABILITY_CHECKLIST } from '@owlat/shared';
import { DESTINATION_PROVIDER_KEYS } from '@owlat/shared/deliverabilityRouting';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { loadStreamlessRouteState } from '../lib/deliverabilityRouteState';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { getLive } from '../lib/softDelete';
import type {
	MarketingNoticeEvent,
	MarketingNoticeKind,
} from '../lib/validators/marketingNotifications';
import { summarizeCampaignStats } from '../campaigns/statShards';
import {
	DELIVERABILITY_URL,
	automationUrl,
	campaignEditUrl,
	campaignReportUrl,
	sendingDomainUrl,
} from './noticeUrls';

/** Everything a notice row carries except who it is for and when it was written. */
export interface NoticeDraft {
	kind: MarketingNoticeKind;
	eventKey: string;
	subjectKey: string;
	campaignId?: Doc<'marketingNotices'>['campaignId'];
	automationId?: Doc<'marketingNotices'>['automationId'];
	domainId?: Doc<'marketingNotices'>['domainId'];
	alertId?: Doc<'marketingNotices'>['alertId'];
	name?: string;
	percent?: number;
	count?: number;
	detail?: string;
	scheduledAt?: number;
	url: string;
	/**
	 * No second notice about the same subject within this window, whatever the
	 * occurrence: a breaker that opens, recovers and opens again within the
	 * hour is one problem to the person, not three.
	 */
	cooldownMs?: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DELIVERY_HOLD_COOLDOWN_MS = 6 * HOUR_MS;

type Reader = QueryCtx | MutationCtx;

/**
 * Delivered share of the messages handed off, 0–100, rounded down so a
 * campaign with one bounce never reads as 100%. Undefined when nothing was
 * handed off, or when no receiver has reported back at all (a transport that
 * sends no delivery reports would otherwise read as 0% delivered).
 */
export function deliveredPercent(stats: {
	statsSent: number;
	statsDelivered: number;
	statsBounced: number;
}): number | undefined {
	if (stats.statsSent <= 0 || stats.statsDelivered + stats.statsBounced <= 0) return undefined;
	const percent = Math.floor((stats.statsDelivered * 100) / stats.statsSent);
	return Math.max(0, Math.min(100, percent));
}

async function draftCampaignFinished(
	ctx: MutationCtx,
	event: Extract<MarketingNoticeEvent, { kind: 'campaign_finished' }>
): Promise<NoticeDraft | null> {
	const campaign = await getLive(ctx, event.campaignId);
	if (campaign?.status !== 'sent') return null;
	const stats = await summarizeCampaignStats(ctx.db, campaign._id);
	const percent = deliveredPercent(stats);
	return {
		kind: 'campaign_finished',
		eventKey: `campaign_finished:${campaign._id}`,
		subjectKey: `campaign:${campaign._id}`,
		campaignId: campaign._id,
		name: campaign.name,
		...(percent !== undefined ? { percent } : {}),
		url: campaignReportUrl(campaign._id),
	};
}

async function draftCampaignReminder(
	ctx: MutationCtx,
	event: Extract<MarketingNoticeEvent, { kind: 'campaign_reminder' }>,
	now: number
): Promise<NoticeDraft | null> {
	const campaign = await getLive(ctx, event.campaignId);
	if (!isReminderCurrent(campaign, event.scheduledAt, now)) return null;
	return {
		kind: 'campaign_reminder',
		eventKey: `campaign_reminder:${event.campaignId}:${event.scheduledAt}`,
		subjectKey: `campaign:${event.campaignId}`,
		campaignId: event.campaignId,
		name: campaign.name,
		scheduledAt: event.scheduledAt,
		url: campaignEditUrl(event.campaignId),
	};
}

/** Still scheduled, for the start this reminder was queued for, and not started yet. */
function isReminderCurrent(
	campaign: Doc<'campaigns'> | null,
	scheduledAt: number | undefined,
	now: number
): campaign is Doc<'campaigns'> {
	return (
		campaign !== null &&
		campaign.status === 'scheduled' &&
		scheduledAt !== undefined &&
		campaign.scheduledAt === scheduledAt &&
		now < scheduledAt
	);
}

/** The provider slice still carries the breaker signal the hold notice is about. */
async function isBreakerStillOpen(ctx: Reader, provider: string): Promise<boolean> {
	const key = DESTINATION_PROVIDER_KEYS.find((candidate) => candidate === provider);
	if (!key) return false;
	const organizationId = await getSingletonOrganizationId(ctx);
	const state = await loadStreamlessRouteState(ctx, organizationId, key);
	return state?.signals.some((signal) => signal.source === 'breaker_open') === true;
}

async function draftDeliveryHold(
	ctx: MutationCtx,
	event: Extract<MarketingNoticeEvent, { kind: 'delivery_hold' }>
): Promise<NoticeDraft | null> {
	if (!(await isBreakerStillOpen(ctx, event.provider))) return null;
	return {
		kind: 'delivery_hold',
		eventKey: `delivery_hold:${event.provider}:${event.openedAt}`,
		subjectKey: `delivery_hold:${event.provider}`,
		name: event.provider,
		url: DELIVERABILITY_URL,
		cooldownMs: DELIVERY_HOLD_COOLDOWN_MS,
	};
}

async function draftAutomationStalled(
	ctx: MutationCtx,
	event: Extract<MarketingNoticeEvent, { kind: 'automation_stalled' }>
): Promise<NoticeDraft | null> {
	const automation = await getLive(ctx, event.automationId);
	if (!automation || event.count <= 0) return null;
	return {
		kind: 'automation_stalled',
		eventKey: `automation_stalled:${automation._id}:${event.sweepStartedAt}`,
		subjectKey: `automation_stalled:${automation._id}`,
		automationId: automation._id,
		name: automation.name,
		count: Math.floor(event.count),
		url: automationUrl(automation._id),
	};
}

async function draftAutomationPaused(
	ctx: MutationCtx,
	event: Extract<MarketingNoticeEvent, { kind: 'automation_paused' }>
): Promise<NoticeDraft | null> {
	const automation = await getLive(ctx, event.automationId);
	if (automation?.status !== 'paused') return null;
	return {
		kind: 'automation_paused',
		eventKey: `automation_paused:${automation._id}:${event.pausedAt}`,
		subjectKey: `automation_paused:${automation._id}`,
		automationId: automation._id,
		name: automation.name,
		url: automationUrl(automation._id),
	};
}

async function draftDomainDns(
	ctx: MutationCtx,
	event: Extract<MarketingNoticeEvent, { kind: 'domain_dns' }>
): Promise<NoticeDraft | null> {
	const alert = await ctx.db.get(event.alertId);
	if (!alert || alert.resolvedAt !== undefined || !alert.domainId) return null;
	const domain = await ctx.db.get(alert.domainId);
	if (!domain) return null;
	const check = DELIVERABILITY_CHECKLIST.find((item) => item.id === alert.itemId);
	return {
		kind: 'domain_dns',
		eventKey: `domain_dns:${alert.identity}`,
		subjectKey: `domain_dns:${alert.targetKey}|${alert.itemId}`,
		domainId: domain._id,
		alertId: alert._id,
		name: domain.domain,
		...(check ? { detail: check.protocol } : {}),
		url: sendingDomainUrl(domain.domain),
	};
}

/** The notice an occurrence becomes, or null when it no longer holds. */
export async function draftNotice(
	ctx: MutationCtx,
	event: MarketingNoticeEvent,
	now: number
): Promise<NoticeDraft | null> {
	switch (event.kind) {
		case 'campaign_finished':
			return draftCampaignFinished(ctx, event);
		case 'campaign_reminder':
			return draftCampaignReminder(ctx, event, now);
		case 'delivery_hold':
			return draftDeliveryHold(ctx, event);
		case 'automation_stalled':
			return draftAutomationStalled(ctx, event);
		case 'automation_paused':
			return draftAutomationPaused(ctx, event);
		case 'domain_dns':
			return draftDomainDns(ctx, event);
	}
}

/**
 * Whether a stored notice is still true enough to interrupt someone with. A
 * finished campaign stays finished, but one deleted since is gone; a reminder
 * is stale the moment its campaign is rescheduled, cancelled, deleted or
 * started; a hold, a pause or a DNS failure that has already cleared is no
 * longer news.
 */
export async function isNoticeLive(
	ctx: Reader,
	notice: Doc<'marketingNotices'>,
	now: number
): Promise<boolean> {
	switch (notice.kind) {
		case 'campaign_finished':
			return notice.campaignId !== undefined && (await getLive(ctx, notice.campaignId)) !== null;
		case 'campaign_reminder': {
			if (notice.campaignId === undefined) return false;
			const campaign = await getLive(ctx, notice.campaignId);
			return isReminderCurrent(campaign, notice.scheduledAt, now);
		}
		case 'delivery_hold':
			return notice.name !== undefined && (await isBreakerStillOpen(ctx, notice.name));
		case 'automation_stalled':
			return (
				notice.automationId !== undefined && (await getLive(ctx, notice.automationId)) !== null
			);
		case 'automation_paused': {
			if (notice.automationId === undefined) return false;
			const automation = await getLive(ctx, notice.automationId);
			return automation?.status === 'paused';
		}
		case 'domain_dns': {
			if (notice.alertId === undefined) return false;
			const alert = await ctx.db.get(notice.alertId);
			return alert !== null && alert.resolvedAt === undefined;
		}
	}
}
