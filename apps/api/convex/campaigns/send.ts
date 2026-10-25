'use node';

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { SEND_PAGE_SIZE, type CampaignRecipient } from './audienceCandidates';
import type { Doc, Id } from '../_generated/dataModel';
import { getOptional } from '../lib/env';
import { resolveNextSendTime, isValidTimeZone } from '../lib/emailHelpers';
import type { CampaignEnqueueEmail } from '../delivery/enqueue';
import { composeForSend, personalizeSubject } from '../delivery/sendComposition';
import {
	bucketPageRecipients,
	classifyContentScan,
	classifyStartSendSkip,
	combineContentScan,
	isEmptyAudienceComplete,
	isSendPrepared,
	makeVariantBucketer,
} from './sendPlanning';
import type { PlannedSendTime } from './sendTimeOptimization';
import {
	NO_PROVIDER_RETRY_MS,
	bucketContent,
	bucketTemplateId,
	decideHopPlan,
	decideHopStart,
	decidePageEnd,
	hopSendContext,
	hopSendSettings,
	needsSendTimePlanning,
	planSendTimes,
	shouldCountAudience,
	type HopSendContext,
} from './pageDecision';
import { nanoid } from 'nanoid';
// Campaign send orchestrator (module) — the single live action that takes a
// campaign from `draft|scheduled|sending` through content scan, archive,
// audience resolution, A/B variant fanout (test cohort), and workpool
// enqueue. See CONTEXT.md "Campaign send orchestrator (module)".
/**
 * Recipients handed to ONE `enqueueCampaignEmails` mutation.
 *
 * Both enqueue branches page through this same size. That mutation writes at
 * least one workpool document AND one `sendAssignments` row per recipient in a
 * single transaction, so an unchunked batch walks toward Convex's
 * per-transaction write ceiling. The timezone branch used to hand an entire
 * IANA-zone group over unchunked, which for a single-zone audience is the
 * whole campaign in one mutation.
 */
const CAMPAIGN_ENQUEUE_CHUNK_SIZE = 50;
const LIFECYCLE_USER_ORCHESTRATOR = 'system:orchestrator';
import { scanContent, levelForScore } from '@owlat/email-scanner';
import {
	checkUrlReputation,
	urlReputationToFlags,
	type ContentFlag,
	type UrlReputationCache,
} from '@owlat/email-scanner';
import { testFractionForSplit } from './sendVariantSplit';
import { scannedContentDigest, scannedSubject } from './sendCommit';
import type { ArchiveSnapshot } from './archiveQueries';
import { logWarn } from '../lib/runtimeLog';

// Convex-backed implementation of the email-scanner's `UrlReputationCache`,
// persisting Safe Browsing verdicts in the `urlReputationCache` table so
// repeated links across campaign content scans are served from cache rather
// than re-querying Google. `get` honors the stored TTL (a miss past expiry);
// `set` upserts by url hash. Caching is best-effort — a cache read/write
// failure must not abort the scan, so both paths swallow errors and degrade to
// an uncached check.
function makeUrlReputationCache(ctx: ActionCtx): UrlReputationCache {
	return {
		async get(urlHash) {
			try {
				return await ctx.runQuery(internal.campaigns.sendQueries.getUrlReputationVerdict, {
					urlHash,
				});
			} catch {
				return null;
			}
		},
		async set(urlHash, verdict) {
			try {
				// checkpoint: a best-effort verdict cache, not campaign state; a write
				// that stands after the send fails costs nothing but a cache hit.
				await ctx.runMutation(internal.campaigns.sendQueries.upsertUrlReputationVerdict, {
					urlHash,
					verdict: verdict.verdict,
					source: verdict.source,
					threats: verdict.threats,
					checkedAt: verdict.checkedAt,
					expiresAt: verdict.expiresAt,
				});
			} catch {
				// Best-effort cache write — ignore.
			}
		},
	};
}

// Internal action invoked by the per-minute scheduler tick to start sending
// any due scheduled campaigns. Delegates to the orchestrator for each due
// campaign — the `scheduled → sending` transition is owned by the
// **Campaign send orchestrator (module)** via the lifecycle. Each start is its
// own scheduled action, so due campaigns start side by side, a slow content
// scan does not hold up the next campaign, and one start that throws does not
// stop the rest.
export const processScheduledCampaigns = internalAction({
	args: {},
	handler: async (ctx): Promise<{ processedCount: number }> => {
		const campaigns = await ctx.runQuery(internal.campaigns.sendQueries.getDueScheduledCampaigns);

		for (const campaign of campaigns) {
			await ctx.scheduler.runAfter(0, internal.campaigns.send.startCampaignSend, {
				campaignId: campaign._id,
			});
		}

		return {
			processedCount: campaigns.length,
		};
	},
});

// Return type for the campaign-send orchestrator. `skipped` carries the
// reason a scheduled-fire was no-oped at the entry-guards or content-scan
// gate; `timezoneScheduled` is set when timezone-aware delayed enqueue
// fired. `abTestCohort` and `abTestRemainder` describe the split when the
// campaign is in the A/B testing phase (`isABTest` + `abTestStatus ===
// 'testing'`) — the remainder waits for `declareABTestWinner` to schedule
// `sendCampaignWinnerToRemainder`.
interface CampaignSendResult {
	totalRecipients: number;
	totalBatches: number;
	skipped?: boolean;
	reason?: string;
	timezoneScheduled?: boolean;
	abTestCohort?: number;
	abTestRemainder?: number;
}

// ─── Campaign send orchestrator (module) ───────────────────────────────
// The single live action that takes a campaign from `scheduled|sending`
// through the prep pipeline (content scan → archive → audience resolution
// → A/B variant fanout for the test cohort → workpool enqueue). See
// CONTEXT.md "Campaign send orchestrator (module)".
//
// Producers of `startCampaignSend` calls:
//   - `processScheduledCampaigns` cron (this file) — scheduler tick
//   - Campaign lifecycle's `schedule_campaign_send_orchestrator` effect
//     (campaigns/lifecycle.ts) — fired on `→ scheduled` (delayed) and
//     `→ sending` (immediate)
//   - `campaigns/scheduling.ts:reschedule` — direct reschedule
//   - `campaigns/sendCommit.ts:commitPreparation` — a rescan, when the
//     content changed while it was being scanned
//
// Reads and the content scan happen here; every write of the preparation is
// one `commitPreparation` mutation, so a failure part-way leaves nothing
// behind and a second hop cannot reset a prepared send.
//
// The orchestrator is the only writer of `emailSends.abVariant` and the
// only caller of `enqueueCampaignEmails` for the first-phase send. The
// sibling action `sendCampaignWinnerToRemainder` (below) owns the
// second-phase send after winner declaration.
export const startCampaignSend = internalAction({
	args: {
		campaignId: v.id('campaigns'),
	},
	handler: async (ctx, args): Promise<CampaignSendResult> => {
		const skip = (reason: string): CampaignSendResult => ({
			totalRecipients: 0,
			totalBatches: 0,
			skipped: true,
			reason,
		});

		// READ. Everything below until the commit is reads and external I/O;
		// `campaigns/sendCommit.ts:commitPreparation` re-checks what matters.
		const campaign = await ctx.runQuery(internal.campaigns.sendQueries.getCampaignForSending, {
			campaignId: args.campaignId,
		});

		if (!campaign) {
			throw new Error('Campaign not found');
		}

		// Fire-time race guards — cancelled, unscheduled, already sent, held for
		// review, or a stale early-firing hop for a rescheduled campaign.
		// `sending` is deliberately NOT skipped; see `classifyStartSendSkip`.
		const guardSkip = classifyStartSendSkip(campaign, Date.now());
		if (guardSkip !== undefined) return skip(guardSkip);
		if (campaign.status !== 'scheduled' && campaign.status !== 'sending') {
			return skip(`Campaign is ${campaign.status}`);
		}

		// Pre-flight re-validation at fire time — catches state that drifted
		// between the original schedule and now (org suspended, template
		// deleted, domain verification expired).
		const preflight = await ctx.runQuery(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId: args.campaignId,
		});
		if (!preflight.ok) return skip(`Pre-flight failed: ${preflight.message}`);

		// The lifecycle schedules a hop on `→ sending`, so the hop after a
		// scheduler-tick start finds its send prepared. Skip before scanning.
		if (campaign.status === 'sending') {
			const job = await ctx.runQuery(internal.campaigns.sendJob.getSendJob, {
				campaignId: args.campaignId,
			});
			if (isSendPrepared(campaign, job)) return skip('Campaign send is already prepared');
		}

		if (!campaign.emailTemplateId) {
			throw new Error('Campaign has no email template');
		}

		if (!campaign.fromEmail) {
			throw new Error('Campaign has no from email');
		}

		// Get email template (for default language content and supported languages)
		const template = await ctx.runQuery(internal.campaigns.sendQueries.getEmailTemplate, {
			templateId: campaign.emailTemplateId,
		});

		if (!template) {
			throw new Error('Email template not found');
		}

		if (!template.htmlContent) {
			throw new Error('Email template has no HTML content');
		}

		// Log (do not gate) when sending against stale HTML —
		// a saved-block edit propagated to the consumer's content JSON but the
		// rerender pool has not yet caught up. Cached `htmlContent` is used.
		if (template.htmlRenderState?.stale) {
			logWarn(`htmlRenderState.stale at send time for ${template._id}; using cached htmlContent`);
		}

		// EXTERNAL I/O. Content scanning: spam, phishing and prohibited content,
		// plus URL reputation via Google Safe Browsing (blocking for campaigns).
		const subject = scannedSubject(campaign, template);
		const scanResultBase = scanContent(subject, template.htmlContent);

		const safeBrowsingApiKey = getOptional('GOOGLE_SAFE_BROWSING_API_KEY');
		let urlFlags: ContentFlag[] = [];
		if (safeBrowsingApiKey) {
			try {
				const urlResults = await checkUrlReputation(template.htmlContent, {
					apiKey: safeBrowsingApiKey,
					cache: makeUrlReputationCache(ctx),
				});
				urlFlags = urlReputationToFlags(urlResults);
			} catch {
				// URL reputation check failure should not block campaign sending
			}
		}

		const verdict = combineContentScan(scanResultBase, urlFlags);
		const combinedLevel = levelForScore(verdict.score);
		const scanOutcome = classifyContentScan(combinedLevel, verdict);
		const scan = { score: verdict.score, level: combinedLevel, flags: verdict.flags };

		const commitVerdict =
			scanOutcome.kind === 'blocked'
				? { kind: 'blocked' as const, contentBlockReason: scanOutcome.contentBlockReason, scan }
				: scanOutcome.kind === 'held'
					? { kind: 'held' as const, scan }
					: {
							kind: 'proceed' as const,
							archive: await composeArchiveSnapshot(ctx, campaign, subject, template.htmlContent),
						};

		// COMMIT. One mutation writes the outcome, or nothing.
		const committed = await ctx.runMutation(internal.campaigns.sendCommit.commitPreparation, {
			campaignId: args.campaignId,
			read: {
				status: campaign.status,
				templateId: campaign.emailTemplateId,
				contentDigest: await scannedContentDigest(subject, template.htmlContent),
			},
			verdict: commitVerdict,
		});
		if (committed.kind !== 'committed') return skip(committed.reason);
		if (scanOutcome.kind !== 'proceed') return skip(scanOutcome.reason);

		// ── PREP→DRIVE handoff: the checkpointed send walker. ──
		// The commit opened a `campaignSendJobs` checkpoint and scheduled
		// `resolveCampaignPage`, which streams the audience one bounded page at
		// a time (A/B sends bucket each page by `hashFraction(campaignId,
		// contactId)`), enqueuing as it goes and self-rescheduling until
		// exhausted. The completion guard in `campaigns/lifecycle.ts` holds the
		// campaign in `sending` until the walker flips the job to `done`.
		return {
			totalRecipients: 0,
			totalBatches: 0,
		};
	},
});

/**
 * The public archive copy, when the campaign archives (its own setting, else
 * the org's `campaigns.archive` default) and SITE_URL is set. The "view in
 * browser" URL is re-derived per page by the walker from the stored
 * `archiveToken`, so only the snapshot is composed here.
 */
async function composeArchiveSnapshot(
	ctx: ActionCtx,
	campaign: Doc<'campaigns'>,
	subject: string,
	htmlContent: string
): Promise<ArchiveSnapshot | undefined> {
	const siteUrl = getOptional('SITE_URL');
	if (!siteUrl) return undefined;
	const resolvedFlags = await ctx.runQuery(internal.workspaces.featureFlags.getResolvedFlags, {});
	const archiveEnabled = campaign.archiveEnabled ?? resolvedFlags['campaigns.archive'] ?? false;
	if (!archiveEnabled) return undefined;
	const composed = composeForSend({
		kind: 'archive_snapshot',
		template: { subject, htmlContent },
	});
	return { archiveToken: nanoid(24), archiveHtmlContent: composed.html, archiveSubject: subject };
}

// ─── Per-variant batch enqueue ─────────────────────────────────────────

type EnqueueVariantArgs = HopSendContext & {
	campaignId: Id<'campaigns'>;
	recipients: ReadonlyArray<CampaignRecipient>;
	abVariant: 'A' | 'B' | undefined;
	subject: string;
	htmlContent: string;
	/** Pre-generated (or author-overridden) text/plain body; default language only. */
	plainTextContent?: string;
	// Send-time optimization: the instant and arm the planner chose per
	// contact id. Set only for an optimized campaign; replaces both the
	// timezone grouping and the immediate chunking.
	plannedSendTimes?: ReadonlyMap<string, PlannedSendTime>;
};

// Create emailSends rows for a batch (one variant, one language) and
// schedule enqueueCampaignEmails. Handles both the timezone-grouped and
// the standard chunk-of-50 paths. The orchestrator's only enqueue site.
async function enqueueVariantBatch(ctx: ActionCtx, args: EnqueueVariantArgs): Promise<number> {
	if (args.recipients.length === 0) return 0;

	const sendsToCreate = args.recipients.map((r) => ({
		campaignId: args.campaignId,
		contactId: r._id,
		contactEmail: r.email,
		contactFirstName: r.firstName,
		contactLastName: r.lastName,
		personalizedSubject: personalizeSubject({
			kind: 'campaign',
			template: { subject: args.subject, htmlContent: '' },
			contactInfo: {
				email: r.email,
				firstName: r.firstName,
				lastName: r.lastName,
			},
		}),
		...(args.abVariant !== undefined ? { abVariant: args.abVariant } : {}),
		...(args.plannedSendTimes?.has(r._id)
			? { sendTimeGroup: args.plannedSendTimes.get(r._id)!.group }
			: {}),
	}));

	// createBatch is idempotent: it inserts a row only for a contact that does
	// not already have one for this campaign, and returns the (contactId →
	// emailSendId) join for exactly the rows it inserted THIS call. We enqueue
	// only those — a recipient skipped as a duplicate (re-run / resumed page)
	// already has a row in flight and must NOT be enqueued again.
	const created = await ctx.runMutation(internal.delivery.sends.createBatch, {
		sends: sendsToCreate,
	});
	const sendIdByContact = new Map<string, Id<'emailSends'>>(
		created.map((c) => [c.contactId, c.emailSendId])
	);

	// The enqueue payload shape is owned by `delivery/enqueue.ts`'s validator —
	// `timezone` is the one local-only field (it picks the send instant here and
	// is not part of the envelope).
	type EmailEnqueueData = CampaignEnqueueEmail & { timezone?: string };

	const emailsToEnqueue: EmailEnqueueData[] = [];
	for (const r of args.recipients) {
		const emailSendId = sendIdByContact.get(r._id);
		if (!emailSendId) continue; // duplicate skipped by createBatch — already enqueued
		emailsToEnqueue.push({
			emailSendId,
			contactId: r._id,
			email: r.email,
			firstName: r.firstName,
			lastName: r.lastName,
			timezone: r.timezone,
			// Projected by audience resolution from the already-loaded contact:
			// the engagement score rides the envelope to the MTA's priority
			// bands. Undefined for an unscored contact and simply omitted.
			engagementScore: r.engagementScore,
		});
	}

	let totalEnqueued = 0;

	// ONE enqueue payload, two call sites (timezone-grouped and chunked). The
	// two branches differ only in the recipient slice and the delay, so the
	// payload — and every future envelope field on it — lives here once.
	// Every call site chunks: one scheduled `enqueueCampaignEmails` per
	// `CAMPAIGN_ENQUEUE_CHUNK_SIZE` recipients keeps each transaction (and its
	// per-recipient assignment writes) bounded.
	const scheduleChunks = async (recipients: EmailEnqueueData[], delayMs: number) => {
		for (let i = 0; i < recipients.length; i += CAMPAIGN_ENQUEUE_CHUNK_SIZE) {
			const chunk = recipients.slice(i, i + CAMPAIGN_ENQUEUE_CHUNK_SIZE);
			await ctx.scheduler.runAfter(delayMs, internal.delivery.enqueue.enqueueCampaignEmails, {
				campaignId: args.campaignId,
				emails: chunk.map(
					({ emailSendId, contactId, email, firstName, lastName, engagementScore }) => ({
						emailSendId,
						contactId,
						email,
						firstName,
						lastName,
						engagementScore,
					})
				),
				from: args.from,
				replyTo: args.replyTo,
				subject: args.subject,
				htmlContent: args.htmlContent,
				plainTextContent: args.plainTextContent,
				convexSiteUrl: args.convexSiteUrl,
				siteUrl: args.siteUrl,
				audienceType: args.audienceType,
				viewInBrowserUrl: args.viewInBrowserUrl,
				providerType: args.providerType,
				ipPool: args.ipPool,
				trackingBaseUrl: args.trackingBaseUrl,
				organizationId: args.organizationId,
				listId: args.listId,
				// Keys the deliverability seed-probe set: the two A/B arms are
				// different messages and each gets its own placement reading.
				abVariant: args.abVariant,
			});
		}
	};

	if (args.plannedSendTimes) {
		// One scheduled enqueue per proposed instant. The enqueue at that instant
		// goes through the same governed path as any other, so the MTA's pacing,
		// the ramp ceilings and the deliverability gates still own throughput.
		const now = Date.now();
		const recipientsByInstant = new Map<number, EmailEnqueueData[]>();
		for (const recipient of emailsToEnqueue) {
			const at = args.plannedSendTimes.get(recipient.contactId)?.at ?? now;
			const bucket = recipientsByInstant.get(at);
			if (bucket) bucket.push(recipient);
			else recipientsByInstant.set(at, [recipient]);
		}
		for (const [at, recipientsAtInstant] of recipientsByInstant) {
			await scheduleChunks(recipientsAtInstant, Math.max(0, at - now));
			totalEnqueued += recipientsAtInstant.length;
		}
	} else if (args.useTimezone) {
		// Group by the recipient's IANA zone, then resolve the next
		// `scheduledHour:scheduledMinute` local instant per zone — DST-correct,
		// unlike a static UTC-offset table. Recipients without a valid zone fall
		// back to the org-level timezone (General settings) when it is a valid
		// zone, otherwise to UTC.
		const now = Date.now();
		const fallbackZone = isValidTimeZone(args.defaultTimezone) ? args.defaultTimezone : 'UTC';
		const recipientsByZone = new Map<string, EmailEnqueueData[]>();
		for (const recipient of emailsToEnqueue) {
			const zone = isValidTimeZone(recipient.timezone) ? recipient.timezone : fallbackZone;
			const bucket = recipientsByZone.get(zone);
			if (bucket) bucket.push(recipient);
			else recipientsByZone.set(zone, [recipient]);
		}

		for (const [zone, recipientsForZone] of recipientsByZone) {
			const target = resolveNextSendTime(zone, args.scheduledHour!, args.scheduledMinute!, now);
			const delayMs = Math.max(0, target - now);
			await scheduleChunks(recipientsForZone, delayMs);
			totalEnqueued += recipientsForZone.length;
		}
	} else {
		await scheduleChunks(emailsToEnqueue, 0);
		totalEnqueued += emailsToEnqueue.length;
	}

	return totalEnqueued;
}

// ─── Checkpointed send walker (NON-A/B) ────────────────────────────────
//
// One self-rescheduling hop of the **checkpointed campaign-send walker** —
// mirrors `integrationImports.walker.processIntegrationPage`. Each invocation:
//   1. Loads the `campaignSendJobs` checkpoint; bails if the walk is done or
//      cancelled (status drifted off `sending`).
//   2. Resolves ONE bounded page of the frozen Audience at the job's cursor
//      via `resolveRecipientPage` (the same eligibility walk the count and the
//      A/B path use).
//   3. Enqueues that page through the existing `enqueueVariantBatch`
//      (abVariant undefined), grouped by language, idempotently
//      (createBatch skips contacts that already have a row).
//   4. Advances the checkpoint (cursor + counters) and bumps the daily send
//      count for the page.
//   5. Reschedules itself if more pages remain; otherwise flips the job to
//      `done` (and, when the whole walk enqueued nobody, completes the
//      campaign as sent — preserving the empty-audience behaviour the in-line
//      resolve used to have).
//
// PREP (`startCampaignSend`, non-A/B branch) already ran the content scan,
// archive snapshot, freeze, and the `→ sending` transition once; this hop only
// does per-page send work, so it re-derives the lighter send context (route,
// tracking domain, timezone) but never re-scans or re-archives.
//
// What the hop decides between its reads and writes (stop, park, the page,
// the send context, each bucket's content, the page end) is in
// `pageDecision.ts`, pure; this action loads, enqueues and writes.
export const resolveCampaignPage = internalAction({
	args: {
		campaignId: v.id('campaigns'),
	},
	handler: async (ctx, args): Promise<{ done: boolean; pageEnqueued: number }> => {
		const { campaignId } = args;
		const start = decideHopStart(
			await ctx.runQuery(internal.campaigns.sendJob.getSendJob, { campaignId }),
			await ctx.runQuery(internal.campaigns.sendQueries.getCampaignForSending, { campaignId })
		);
		if (start.kind === 'stop') return { done: true, pageEnqueued: 0 };
		const { job, campaign } = start;

		// THE MULTI-DAY SEND PLAN: today's capacity slice, or a park until the
		// next cap window (see `decideHopPlan`).
		const hop = decideHopPlan({
			job,
			capacity: await ctx.runQuery(internal.campaigns.sendPlanQueries.getSendPlanCapacity, {
				audience: job.audience,
				countAudienceSize: shouldCountAudience(job),
			}),
			fullPageSize: SEND_PAGE_SIZE,
			now: Date.now(),
		});
		if (hop.kind === 'park') {
			// `recordSendPlanDay` owns the `updatedAt` touch, so there is no
			// separate `touchSendJob` here.
			const parked = await ctx.runMutation(internal.campaigns.sendJob.recordSendPlanDay, {
				campaignId,
				plan: hop.planDay,
				resumeAt: hop.resumeAt,
			});
			// IDEMPOTENT RESUME. The row was already parked for exactly this window,
			// so a hop is already pending and a second one would apply this page's
			// counters twice.
			if (!parked.isResumeAlreadyScheduled) {
				await ctx.scheduler.runAt(hop.resumeAt, internal.campaigns.send.resolveCampaignPage, {
					campaignId,
				});
			}
			return { done: false, pageEnqueued: 0 };
		}

		// ONE bounded page at the job cursor, narrowed to what is left of
		// today's slice.
		const page = await ctx.runQuery(internal.campaigns.audienceResolution.resolveRecipientPage, {
			audience: job.audience,
			cursor: job.cursor,
			...(hop.pageSize === undefined ? {} : { numItems: hop.pageSize }),
		});
		const settings = hopSendSettings(job, campaign);

		const resolvedRoute = await ctx.runQuery(internal.lib.sendProviders.route.resolveSendRoute, {
			messageType: 'campaign',
			to: page.recipients[0]?.email,
			from: settings.from,
		});
		if (!resolvedRoute) {
			// Fail closed and retry this same hop later; see `NO_PROVIDER_RETRY_MS`.
			logWarn(
				`Campaign send hop deferred for ${campaignId}: no delivery provider configured; retrying in ${NO_PROVIDER_RETRY_MS}ms`
			);
			await ctx.runMutation(internal.campaigns.sendJob.touchSendJob, { campaignId });
			await ctx.scheduler.runAfter(
				NO_PROVIDER_RETRY_MS,
				internal.campaigns.send.resolveCampaignPage,
				{ campaignId }
			);
			return { done: false, pageEnqueued: 0 };
		}

		// The per-hop send context (cheap reads). PREP already scanned, archived
		// and froze the campaign; this hop only re-derives what each page needs.
		const context = hopSendContext({
			job,
			campaign,
			settings,
			route: resolvedRoute,
			siteUrl: getOptional('SITE_URL'),
			convexSiteUrl: getOptional('CONVEX_SITE_URL'),
			trackingDomain: (
				await ctx.runQuery(internal.domains.trackingDomains.getActiveTrackingDomain, {})
			)?.domain,
			organizationId:
				(await ctx.runQuery(internal.campaigns.sendQueries.getSingletonOrganizationId, {})) ??
				undefined,
			topic: settings.topicId
				? await ctx.runQuery(internal.topics.topics.getInternal, { topicId: settings.topicId })
				: null,
			defaultTimezone:
				(settings.isTimezoneAware
					? await ctx.runQuery(internal.campaigns.sendQueries.getOrgTimezone, {})
					: undefined) ?? undefined,
		});
		const plannedSendTimes = planSendTimes({
			campaignId,
			campaign,
			variantMode: settings.variantMode,
			slice: hop.slice,
			recipients: page.recipients,
			planning: needsSendTimePlanning(campaign, settings.variantMode, page.recipients.length)
				? await ctx.runQuery(internal.campaigns.sendTimeQueries.getPlanningContext, {})
				: null,
			now: Date.now(),
		});

		// Each recipient's variant bucket, from the job's variant mode and the
		// deterministic per-contact hash.
		const bucketFor = makeVariantBucketer({
			variantMode: settings.variantMode,
			campaignId,
			testFraction: job.testFraction ?? 0,
			winningVariant: job.winningVariant,
		});

		let pageEnqueued = 0;
		if (page.recipients.length > 0) {
			const template = await ctx.runQuery(internal.campaigns.sendQueries.getEmailTemplate, {
				templateId: campaign.emailTemplateId,
			});
			const defaultLanguage = template?.defaultLanguage ?? 'en';
			for (const bucket of bucketPageRecipients(page.recipients, bucketFor, defaultLanguage)) {
				if (bucket.recipients.length === 0) continue;
				const content = bucketContent(
					bucket.variant,
					campaign,
					await ctx.runQuery(internal.campaigns.sendQueries.getEmailTemplateForLanguage, {
						templateId: bucketTemplateId(bucket.variant, campaign),
						language: bucket.language,
					})
				);
				if (!content) continue;
				pageEnqueued += await enqueueVariantBatch(ctx, {
					...context,
					...content,
					campaignId,
					recipients: bucket.recipients,
					abVariant: bucket.variant,
					plannedSendTimes,
				});
			}
		}

		const end = decidePageEnd({
			page,
			pageEnqueued,
			slice: hop.slice,
			planCheckpoint: hop.planCheckpoint,
		});
		if (end.dailySendCount !== undefined) {
			await ctx.runMutation(internal.campaigns.sendQueries.incrementDailySendCountInternal, {
				count: end.dailySendCount,
			});
		}
		const advanced = await ctx.runMutation(internal.campaigns.sendJob.advanceSendJob, {
			campaignId,
			...end.advance,
		});
		await ctx.runMutation(internal.campaigns.sendJob.recordSendPlanDay, {
			campaignId,
			plan: end.planDay,
		});

		if (!end.isLastPage) {
			await ctx.scheduler.runAfter(0, internal.campaigns.send.resolveCampaignPage, { campaignId });
			return { done: false, pageEnqueued };
		}

		// Last page: complete NOW only on the empty-audience fast path; otherwise
		// the per-send completion callback / reconcile cron completes it once the
		// last queued send clears (the guard no longer blocks once phase is done).
		if (isEmptyAudienceComplete(settings.variantMode, advanced)) {
			await ctx.runMutation(internal.campaigns.lifecycle.transition, {
				campaignId,
				input: { to: 'sent', at: Date.now() },
				userId: LIFECYCLE_USER_ORCHESTRATOR,
			});
		}

		return { done: true, pageEnqueued };
	},
});

// ─── Winner-cohort send (second phase) ─────────────────────────────────

interface WinnerRemainderResult {
	scheduled: boolean;
	skipped?: boolean;
	reason?: string;
}

// Second-phase orchestrator: after `declareABTestWinner` transitions the
// AB test lifecycle to `winner_selected`, this action sends the winner's
// content to the audience members who were held back from the test cohort.
//
// Streams through the SAME checkpointed walker as phase 1: it RESETS the
// campaign's `campaignSendJobs` row to a fresh `ab_winner` walk (the
// declared `winningVariant`, the same `testFraction` derived from the
// immutable `splitPercentage`) and schedules `resolveCampaignPage`. Each hop
// then re-buckets the page by `hashFraction` and enqueues ONLY the remainder
// (`h >= testFraction`) with the winning variant. No who-got-the-test scan —
// remainder membership is recomputable from the hash — and the `createBatch`
// idempotency guard makes a re-invocation (or resumed page) add zero
// duplicate rows.
//
// Skips (with reason) if: campaign missing, not an A/B test, winner not
// declared, or required fields missing.
export const sendCampaignWinnerToRemainder = internalAction({
	args: {
		campaignId: v.id('campaigns'),
	},
	handler: async (ctx, args): Promise<WinnerRemainderResult> => {
		const campaign = await ctx.runQuery(internal.campaigns.sendQueries.getCampaignForSending, {
			campaignId: args.campaignId,
		});

		if (!campaign) {
			return { scheduled: false, skipped: true, reason: 'Campaign not found' };
		}
		if (!campaign.isABTest || !campaign.abWinner) {
			return {
				scheduled: false,
				skipped: true,
				reason: 'Campaign is not an A/B test or winner not declared',
			};
		}
		if (!campaign.emailTemplateId || !campaign.fromEmail || !campaign.audience) {
			return {
				scheduled: false,
				skipped: true,
				reason: 'Campaign is missing required fields',
			};
		}
		if (!campaign.abTestConfig) {
			return { scheduled: false, skipped: true, reason: 'Campaign has no A/B config' };
		}

		// Freeze the audience (idempotent — phase 1 already snapshotted any
		// segment) so the remainder resolves against the SAME selection the test
		// phase used. The `testFraction` is re-derived from the
		// immutable `splitPercentage`, so the `h >= testFraction` remainder
		// partition is IDENTICAL to the `h < testFraction` cohort phase 1 sent —
		// the two phases are provably disjoint and exhaustive.
		const audience = await ctx.runMutation(internal.campaigns.sendQueries.freezeCampaignAudience, {
			campaignId: args.campaignId,
		});
		if (!audience) {
			return { scheduled: false, skipped: true, reason: 'Campaign has no audience' };
		}

		await ctx.runMutation(internal.campaigns.sendJob.createSendJob, {
			campaignId: args.campaignId,
			audience,
			variantMode: 'ab_winner',
			testFraction: testFractionForSplit(campaign.abTestConfig.splitPercentage),
			splitPercentage: campaign.abTestConfig.splitPercentage,
			winningVariant: campaign.abWinner,
		});
		await ctx.scheduler.runAfter(0, internal.campaigns.send.resolveCampaignPage, {
			campaignId: args.campaignId,
		});

		return { scheduled: true };
	},
});
