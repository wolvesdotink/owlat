/**
 * The decisions of ONE hop of the checkpointed campaign-send walker
 * (`send.ts:resolveCampaignPage`), without the database: whether the hop walks
 * at all, whether today's slice is spent (park) or which page to read, the
 * send context every recipient of the page shares, the content each
 * (language, variant) bucket goes out with, and what the hop writes once the
 * page is enqueued. The hop reads, enqueues and writes in the order these
 * describe; the multi-day plan, the variant split and send-time optimization
 * keep their own owners (`sendPlanning.ts`, `multiDaySendPlan.ts`,
 * `sendVariantSplit.ts`, `sendTimeOptimization.ts`), which this composes.
 *
 * PURE: `now` is a parameter and nothing here reads a clock, a database or the
 * environment (scripts/purity-roots.txt).
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { SendTimeHistogram } from '../analytics/sendTimeProfile';
import { getListIdHeader } from '../delivery/sendComposition/listId';
import { nextUtcDayStart } from '../lib/clock';
import type { CampaignRecipient } from './audienceCandidates';
import { planTodaysSlice, remainingRecipients } from './multiDaySendPlan';
import {
	buildPlanCheckpoint,
	buildSendPlanState,
	isPlannedTotalCounted,
	isTimezoneScheduled,
	pageSizeForSlice,
	resolveParkInstant,
	resolveVariantBSource,
	type SendPlanCapacity,
	type SendPlanCheckpoint,
	type SendVariantMode,
} from './sendPlanning';
import {
	makeSendTimePlanner,
	resolveSendTimeWindow,
	sendTimeOptimizationFor,
	type PlannedSendTime,
} from './sendTimeOptimization';

/**
 * Backoff before re-trying a hop that found no configured delivery provider
 * (removed between schedule and send).
 *
 * The hop fails CLOSED but does not throw: the pre-flight already required a
 * provider, so a null route means one was removed, and the hop must not
 * dispatch to a phantom MTA. A throw would strand the walk (it stays
 * `resolving`, the cursor never advances, every remaining recipient is
 * dropped), so the hop reschedules ITSELF after this backoff with the cursor
 * untouched, and the page re-resolves from the checkpoint once a provider is
 * back. It also touches the job's `updatedAt`, so this self-reschedule chain —
 * not the stuck-send watchdog — owns the retry: without the touch the row
 * would go ever staler and the watchdog would stack a redundant hop on every
 * tick; with it, the watchdog re-drives only once this chain has died.
 *
 * Long enough not to hot-loop while an admin re-configures the provider.
 */
export const NO_PROVIDER_RETRY_MS = 5 * 60 * 1000;

type Job = Doc<'campaignSendJobs'>;
type Campaign = Doc<'campaigns'>;

/** A campaign the hop may enqueue against. */
export type WalkingCampaign = Campaign & {
	readonly emailTemplateId: Id<'emailTemplates'>;
	readonly fromEmail: string;
};

/**
 * Does this hop walk? A stale or cancelled walk (another hop finished it, or
 * the row is gone) stops; so does a campaign that left `sending` between hops,
 * whose job is left as it is (the next send wipes it). A campaign without a
 * template or From never enqueues, although the pre-flight validated both.
 */
export function decideHopStart(
	job: Job | null,
	campaign: Campaign | null
):
	| { readonly kind: 'stop' }
	| { readonly kind: 'walk'; readonly job: Job; readonly campaign: WalkingCampaign } {
	if (!job || job.phase !== 'resolving') return { kind: 'stop' };
	if (!campaign || campaign.status !== 'sending') return { kind: 'stop' };
	if (!campaign.emailTemplateId || !campaign.fromEmail) return { kind: 'stop' };
	return { kind: 'walk', job, campaign: campaign as WalkingCampaign };
}

/**
 * Count the audience on this hop? ONCE PER WALK: `plannedTotal === undefined`
 * alone would re-run the count on every hop of a walk whose count came back
 * counted-but-unusable, because that verdict writes no total by design.
 */
export function shouldCountAudience(job: Job): boolean {
	return job.plannedTotal === undefined && job.isPlannedTotalCountAttempted !== true;
}

type SendPlanSlice = ReturnType<typeof planTodaysSlice>;

/** The day checkpoint `sendJob.recordSendPlanDay` stores. */
export type SendPlanDay = SendPlanCheckpoint & { readonly enqueuedToday: number };

/**
 * Today's capacity slice: PARK the walk until the next cap window, or the page
 * to read. A warming deployment with no relay cannot deliver a large campaign
 * in one day, and enqueueing it all anyway only makes the tail expire after
 * churning the MTA's queue, so the walker takes today's slice and resumes.
 * Unmeasured capacity imposes no budget: the slice's `remainingToday` is
 * `undefined` and the hop reads a full page.
 *
 * A park's checkpoint carries `resumeAt`, which records the day's counters and
 * takes the row out of the stuck-walk watchdog's reach (a 24h park is far past
 * its staleness threshold, and a re-drive would schedule a second resume hop).
 */
export function decideHopPlan(input: {
	readonly job: Job;
	readonly capacity: SendPlanCapacity & { readonly capacityByDay: readonly number[] };
	readonly fullPageSize: number;
	readonly now: number;
}):
	| { readonly kind: 'park'; readonly resumeAt: number; readonly planDay: SendPlanDay }
	| {
			readonly kind: 'page';
			/** `undefined` reads a full page. Never 0: a spent budget parks. */
			readonly pageSize: number | undefined;
			readonly slice: SendPlanSlice;
			readonly planCheckpoint: SendPlanCheckpoint;
	  } {
	const { job, capacity, now } = input;
	const state = buildSendPlanState(job, capacity);
	const slice = planTodaysSlice({
		state,
		remaining: remainingRecipients(state, job.enqueuedCount),
		capacityByDay: capacity.capacityByDay,
		now,
	});
	const planCheckpoint = buildPlanCheckpoint(state, slice, isPlannedTotalCounted(job, capacity));
	const resumeAt = resolveParkInstant(slice, now);
	if (resumeAt !== undefined) {
		return {
			kind: 'park',
			resumeAt,
			planDay: { ...planCheckpoint, enqueuedToday: slice.enqueuedToday },
		};
	}
	return {
		kind: 'page',
		pageSize: pageSizeForSlice(slice, input.fullPageSize),
		slice,
		planCheckpoint,
	};
}

/** What the hop has to load before it can build the page's send context. */
export interface HopSendSettings {
	readonly variantMode: SendVariantMode;
	readonly from: string;
	/** Timezone-aware scheduling; the org's fallback zone is loaded only then. */
	readonly isTimezoneAware: boolean;
	/** The topic to name in the List-Id header, for a topic audience. */
	readonly topicId: Id<'topics'> | undefined;
}

export function hopSendSettings(job: Job, campaign: WalkingCampaign): HopSendSettings {
	const variantMode = job.variantMode ?? 'plain';
	return {
		variantMode,
		from: campaign.fromName ? `${campaign.fromName} <${campaign.fromEmail}>` : campaign.fromEmail,
		isTimezoneAware: isTimezoneScheduled(campaign, variantMode),
		topicId: job.audience.kind === 'topic' ? job.audience.topicId : undefined,
	};
}

/** The enqueue fields every bucket of one page shares. */
export interface HopSendContext {
	readonly from: string;
	readonly replyTo?: string;
	readonly audienceType?: 'topic' | 'segment';
	readonly viewInBrowserUrl?: string;
	/**
	 * Advisory snapshot only: the worker re-resolves current state for each
	 * recipient immediately before dispatch.
	 */
	readonly providerType?: string;
	readonly ipPool?: string;
	readonly trackingBaseUrl?: string;
	readonly convexSiteUrl?: string;
	readonly siteUrl?: string;
	/** Singleton org id — anchors the Gmail FBL Feedback-ID SenderId. */
	readonly organizationId?: string;
	/** RFC 2919 List-Id header value for a TOPIC campaign. */
	readonly listId?: string;
	readonly useTimezone: boolean;
	readonly scheduledHour?: number;
	readonly scheduledMinute?: number;
	/** The org's fallback zone for recipients without a valid IANA zone. */
	readonly defaultTimezone?: string;
}

export function hopSendContext(input: {
	readonly job: Job;
	readonly campaign: WalkingCampaign;
	readonly settings: HopSendSettings;
	readonly route: { readonly providerType: string; readonly ipPool?: string };
	readonly siteUrl: string | undefined;
	readonly convexSiteUrl: string | undefined;
	readonly trackingDomain: string | undefined;
	readonly organizationId: string | undefined;
	readonly topic: { readonly _id: string; readonly name: string } | null;
	readonly defaultTimezone: string | undefined;
}): HopSendContext {
	const { campaign, siteUrl } = input;
	// The sending domain is the host of the From address. A segment campaign has
	// no single list identity, so it gets no List-Id.
	const sendingDomain = campaign.fromEmail.split('@')[1] ?? '';
	const listId =
		input.topic && sendingDomain
			? (getListIdHeader({
					domain: sendingDomain,
					topic: { id: input.topic._id, name: input.topic.name },
				}) ?? undefined)
			: undefined;
	return {
		from: input.settings.from,
		replyTo: campaign.replyTo,
		audienceType: input.job.audience.kind,
		// The archive token PREP wrote, so every page carries the same link.
		viewInBrowserUrl:
			campaign.archiveToken && siteUrl
				? `${siteUrl}/archive?token=${campaign.archiveToken}`
				: undefined,
		providerType: input.route.providerType,
		ipPool: input.route.ipPool,
		trackingBaseUrl: input.trackingDomain ? `https://${input.trackingDomain}` : undefined,
		convexSiteUrl: input.convexSiteUrl,
		siteUrl,
		organizationId: input.organizationId,
		listId,
		useTimezone: input.settings.isTimezoneAware,
		scheduledHour: campaign.scheduledHour,
		scheduledMinute: campaign.scheduledMinute,
		defaultTimezone: input.defaultTimezone,
	};
}

/**
 * Send-time optimization for the page: each contact's instant inside the
 * window, or `undefined` when the campaign is not optimized. With a day budget
 * the window ends with the budget's UTC day, so today's slice never lands in
 * tomorrow's cap window.
 */
export function planSendTimes(input: {
	readonly campaignId: Id<'campaigns'>;
	readonly campaign: Campaign;
	readonly variantMode: SendVariantMode;
	readonly slice: SendPlanSlice;
	readonly recipients: readonly CampaignRecipient[];
	readonly planning: {
		readonly organization: SendTimeHistogram | null;
		readonly defaultTimezone: string | undefined;
	} | null;
	readonly now: number;
}): Map<string, PlannedSendTime> | undefined {
	const settings = sendTimeOptimizationFor(input.campaign, input.variantMode);
	if (!settings || !input.planning || input.recipients.length === 0) return undefined;
	const { campaign, now } = input;
	const plan = makeSendTimePlanner({
		campaignId: input.campaignId,
		settings,
		window: resolveSendTimeWindow({
			sentAt: campaign.sentAt,
			windowHours: settings.windowHours,
			now,
			dayBudgetEndsAt: input.slice.remainingToday === undefined ? undefined : nextUtcDayStart(now),
		}),
		organization: input.planning.organization,
		defaultTimezone: input.planning.defaultTimezone,
		startWallClock:
			campaign.scheduledHour !== undefined && campaign.scheduledMinute !== undefined
				? { hour: campaign.scheduledHour, minute: campaign.scheduledMinute }
				: undefined,
		now,
	});
	return new Map(input.recipients.map((r) => [r._id, plan(r)]));
}

/** Does the page need send-time planning? Its context is loaded only then. */
export function needsSendTimePlanning(
	campaign: Campaign,
	variantMode: SendVariantMode,
	recipientCount: number
): boolean {
	return sendTimeOptimizationFor(campaign, variantMode) !== undefined && recipientCount > 0;
}

/**
 * The template a bucket's content comes from: variant B of a content test
 * uses its own template; variant A, the plain bucket and a subject test use
 * the campaign's.
 */
export function bucketTemplateId(
	variant: 'A' | 'B' | undefined,
	campaign: WalkingCampaign
): Id<'emailTemplates'> {
	const variantB = resolveVariantBSource(campaign);
	return variant === 'B' && variantB.templateId
		? (variantB.templateId as Id<'emailTemplates'>)
		: campaign.emailTemplateId;
}

/** A template's content in one language, as `getEmailTemplateForLanguage` returns it. */
export interface LanguageContent {
	readonly subject: string;
	readonly htmlContent: string;
	/** The text/plain body; the per-language query returns it for the default language only. */
	readonly plainTextContent?: string;
}

/**
 * The subject and body a bucket is enqueued with, or `null` to skip a bucket
 * whose template has no content in its language. A content test's variant B
 * keeps its own template's subject; a subject test's variant B uses the
 * alternate subject over the campaign's override over the template's; every
 * other bucket uses the campaign's override over the template's.
 */
export function bucketContent(
	variant: 'A' | 'B' | undefined,
	campaign: WalkingCampaign,
	content: LanguageContent | null
): LanguageContent | null {
	if (!content) return null;
	const variantB = resolveVariantBSource(campaign);
	const subject =
		variant === 'B'
			? variantB.templateId
				? content.subject
				: (variantB.subject ?? campaign.subject ?? content.subject)
			: (campaign.subject ?? content.subject);
	return {
		subject,
		htmlContent: content.htmlContent,
		plainTextContent: content.plainTextContent,
	};
}

/**
 * What the page commit (`walkerCommit.ts:commitCampaignPage`) writes once it
 * has inserted the page's send rows, in this order, in the same transaction:
 *
 *   1. the daily send count, bumped per page so it stays accurate even if a
 *      later hop is delayed (only when the page enqueued anyone);
 *   2. the checkpoint advance — cursor and counters, `done` on the last page;
 *   3. the day's plan checkpoint, after the advance so the two never disagree
 *      about a page, on every hop (the day-of-N line must exist from the first
 *      moment) and without `resumeAt`, so a previous park is cleared;
 *   4. the next hop, unless this was the last page.
 *
 * `pageEnqueued` is what the insert actually created, never the candidates,
 * which is why this is a second stage the commit calls after its inserts.
 */
export function decidePageEnd(input: {
	readonly page: { readonly nextCursor: string | null; readonly pageCandidates: number };
	readonly pageEnqueued: number;
	readonly slice: Pick<SendPlanSlice, 'enqueuedToday'>;
	readonly planCheckpoint: SendPlanCheckpoint;
}): {
	readonly dailySendCount: number | undefined;
	readonly advance: {
		readonly nextCursor: string | null;
		readonly pageEnqueued: number;
		readonly pageCandidates: number;
	};
	readonly planDay: SendPlanDay;
	readonly isLastPage: boolean;
} {
	const { page, pageEnqueued } = input;
	return {
		dailySendCount: pageEnqueued > 0 ? pageEnqueued : undefined,
		advance: { nextCursor: page.nextCursor, pageEnqueued, pageCandidates: page.pageCandidates },
		planDay: { ...input.planCheckpoint, enqueuedToday: input.slice.enqueuedToday + pageEnqueued },
		isLastPage: page.nextCursor === null,
	};
}
