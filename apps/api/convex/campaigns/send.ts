'use node';

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { CampaignRecipient } from './audienceResolution';
import type { Id } from '../_generated/dataModel';
import { getOptional } from '../lib/env';
import { resolveNextSendTime, isValidTimeZone } from '../lib/emailHelpers';
import { composeForSend, personalizeSubject } from '../delivery/sendComposition';
import { getListIdHeader } from '../delivery/sendComposition/listId';
import { nanoid } from 'nanoid';
// Campaign send orchestrator (module) — the single live action that takes a
// campaign from `draft|scheduled|sending` through content scan, archive,
// audience resolution, A/B variant fanout (test cohort), and workpool
// enqueue. See CONTEXT.md "Campaign send orchestrator (module)".
// Backoff before re-trying a send hop that found no configured delivery
// provider (removed between schedule and send). Long enough not to hot-loop
// while an admin re-configures the provider; the stuck-send watchdog backstops
// a lost reschedule.
const NO_PROVIDER_RETRY_MS = 5 * 60 * 1000; // 5 minutes
const LIFECYCLE_USER_SCHEDULER_TICK = 'system:scheduler_tick';
const LIFECYCLE_USER_CONTENT_SCAN = 'system:content_scan';
const LIFECYCLE_USER_ORCHESTRATOR = 'system:orchestrator';
import { scanContent, levelForScore } from '@owlat/email-scanner';
import {
	checkUrlReputation,
	urlReputationToFlags,
	type ContentFlag,
	type UrlReputationCache,
} from '@owlat/email-scanner';
import {
	resolveAbFanout,
	hashFraction,
	testFractionForSplit,
	variantForHash,
} from './sendVariantSplit';
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

// Internal action invoked by the daily scheduler tick to start sending any
// due scheduled campaigns. Delegates to the orchestrator for each due
// campaign — the `scheduled → sending` transition is owned by the
// **Campaign send orchestrator (module)** via the lifecycle.
export const processScheduledCampaigns = internalAction({
	args: {},
	handler: async (ctx): Promise<{ processedCount: number }> => {
		const campaigns = await ctx.runQuery(internal.campaigns.sendQueries.getDueScheduledCampaigns);

		for (const campaign of campaigns) {
			await ctx.runAction(internal.campaigns.send.startCampaignSend, {
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
		// Get campaign details
		const campaign = await ctx.runQuery(internal.campaigns.sendQueries.getCampaignForSending, {
			campaignId: args.campaignId,
		});

		if (!campaign) {
			throw new Error('Campaign not found');
		}

		// Status-race guards: the scheduler-tick may fire after the campaign
		// has been cancelled / unscheduled / already sent. Race protection
		// against double-orchestrator-firing is owned by the Campaign
		// lifecycle (`scheduled → sending` is single-write; same-state
		// `sending → sending` is recorded but does NOT refire the
		// `schedule_campaign_send_orchestrator` effect) — so we don't skip
		// on `sending` here. The sendNow path arrives with status already
		// flipped to `sending` (lifecycle ran first, then scheduled this
		// orchestrator), and the cron-tick path arrives with `scheduled`.
		if (campaign.status === 'cancelled' || campaign.status === 'draft') {
			return {
				totalRecipients: 0,
				totalBatches: 0,
				skipped: true,
				reason:
					campaign.status === 'cancelled' ? 'Campaign was cancelled' : 'Campaign was unscheduled',
			};
		}
		if (campaign.status === 'sent') {
			return {
				totalRecipients: 0,
				totalBatches: 0,
				skipped: true,
				reason: 'Campaign was already sent',
			};
		}

		// Fire-time guard for a still-`scheduled` campaign: `reschedule` patches
		// scheduledAt + schedules a fresh hop but does NOT cancel the original one,
		// so without this an early-firing stale hop would transition the campaign to
		// `sending` and send at the OLD time. If scheduledAt is still in the future,
		// skip — the correct hop (or the per-minute `process scheduled campaigns`
		// cron, which only picks up scheduledAt <= now) sends it on time. The
		// sendNow path arrives as `sending` and is unaffected.
		if (
			campaign.status === 'scheduled' &&
			campaign.scheduledAt !== undefined &&
			campaign.scheduledAt > Date.now()
		) {
			return {
				totalRecipients: 0,
				totalBatches: 0,
				skipped: true,
				reason: 'Not yet due (rescheduled)',
			};
		}

		// Pre-flight re-validation at fire time — catches state that drifted
		// between the original schedule and now (org suspended, template
		// deleted, domain verification expired). Collapses the prior
		// defense-in-depth `isSendingAllowed` re-check into one consolidated
		// gate.
		const preflight = await ctx.runQuery(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId: args.campaignId,
		});
		if (!preflight.ok) {
			return {
				totalRecipients: 0,
				totalBatches: 0,
				skipped: true,
				reason: `Pre-flight failed: ${preflight.message}`,
			};
		}

		// If campaign is scheduled, transition it to sending via the lifecycle.
		if (campaign.status === 'scheduled') {
			await ctx.runMutation(internal.campaigns.lifecycle.transition, {
				campaignId: args.campaignId,
				input: { to: 'sending', at: Date.now() },
				userId: LIFECYCLE_USER_SCHEDULER_TICK,
			});
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

		// Per ADR-0023, log (do not gate) when sending against stale HTML —
		// a saved-block edit propagated to the consumer's content JSON but the
		// rerender pool has not yet caught up. Cached `htmlContent` is used.
		if (template.htmlRenderState?.stale) {
			logWarn(`htmlRenderState.stale at send time for ${template._id}; using cached htmlContent`);
		}

		// Content scanning: check for spam, phishing, and prohibited content
		const scanSubject = campaign.subject ?? template.subject;
		const scanResultBase = scanContent(scanSubject, template.htmlContent);

		// URL reputation checking via Google Safe Browsing (blocking for campaigns)
		const safeBrowsingApiKey = getOptional('GOOGLE_SAFE_BROWSING_API_KEY');
		const allFlags: ContentFlag[] = [...scanResultBase.flags];
		let urlReputationScore = 0;

		if (safeBrowsingApiKey) {
			try {
				const urlResults = await checkUrlReputation(template.htmlContent, {
					apiKey: safeBrowsingApiKey,
					cache: makeUrlReputationCache(ctx),
				});
				const urlFlags = urlReputationToFlags(urlResults);
				allFlags.push(...urlFlags);
				for (const flag of urlFlags) {
					urlReputationScore += flag.severity === 'high' ? 20 : flag.severity === 'medium' ? 10 : 3;
				}
			} catch {
				// URL reputation check failure should not block campaign sending
			}
		}

		const combinedScore = Math.min(100, scanResultBase.score + urlReputationScore);
		const combinedLevel = levelForScore(combinedScore);

		if (combinedLevel !== 'clean') {
			await ctx.runMutation(internal.campaigns.sendQueries.storeContentScanResult, {
				resourceType: 'campaign',
				resourceId: args.campaignId,
				score: combinedScore,
				level: combinedLevel,
				flags: allFlags,
				scannedAt: Date.now(),
			});

			if (combinedLevel === 'blocked') {
				// Revert campaign to draft via the lifecycle (writes
				// contentBlockReason atomically with the status patch).
				await ctx.runMutation(internal.campaigns.lifecycle.transition, {
					campaignId: args.campaignId,
					input: {
						to: 'draft',
						at: Date.now(),
						contentBlockReason: `Content blocked: ${allFlags.map((f) => f.description).join('; ')}`,
					},
					userId: LIFECYCLE_USER_CONTENT_SCAN,
				});
				return {
					totalRecipients: 0,
					totalBatches: 0,
					skipped: true,
					reason: `Content blocked by scanner (score: ${combinedScore}/100)`,
				};
			}

			if (combinedLevel === 'suspicious') {
				// Flag for platform admin review via the lifecycle.
				await ctx.runMutation(internal.campaigns.lifecycle.transition, {
					campaignId: args.campaignId,
					input: { to: 'pending_review', at: Date.now() },
					userId: LIFECYCLE_USER_CONTENT_SCAN,
				});
				return {
					totalRecipients: 0,
					totalBatches: 0,
					skipped: true,
					reason: `Content flagged for review (score: ${combinedScore}/100)`,
				};
			}
		}

		// Archive snapshot: generate public archive if enabled. The "view in
		// browser" URL is re-derived per page by the walker from the stored
		// `archiveToken`, so PREP only writes the snapshot here.
		const siteUrl = getOptional('SITE_URL');

		const resolvedFlags = await ctx.runQuery(internal.workspaces.featureFlags.getResolvedFlags, {});
		const orgArchiveDefault = resolvedFlags['campaigns.archive'] ?? false;
		const archiveEnabled = campaign.archiveEnabled ?? orgArchiveDefault;

		if (archiveEnabled && siteUrl) {
			const archiveToken = nanoid(24);
			const archiveSubject = campaign.subject ?? template.subject;
			const archiveComposed = composeForSend({
				kind: 'archive_snapshot',
				template: { subject: archiveSubject, htmlContent: template.htmlContent },
			});

			await ctx.runMutation(internal.campaigns.archiveQueries.setArchiveSnapshot, {
				campaignId: args.campaignId,
				archiveToken,
				archiveHtmlContent: archiveComposed.html,
				archiveSubject,
			});
		}

		if (!campaign.audience) {
			throw new Error('Campaign has no audience');
		}

		// Freeze the segment snapshot at send time (ADR-0033) so this Campaign
		// reproduces the exact Segment it targeted even if the Segment is later
		// edited; topic Audiences and already-frozen segments pass through.
		const audience = await ctx.runMutation(internal.campaigns.sendQueries.freezeCampaignAudience, {
			campaignId: args.campaignId,
		});
		if (!audience) {
			throw new Error('Campaign has no audience');
		}

		// A/B test fanout: only fires when isABTest is set AND the AB test
		// lifecycle is in `testing` (the cross-machine effect from the
		// Campaign lifecycle transitions abTestStatus there on `→ sending`).
		// `splitPercentage` means "% per variant of the test cohort" — so
		// the cohort is `2 × splitPercentage %` of the audience (e.g., 20 →
		// 40% cohort, 60% remainder). Remainder is held back; it gets the
		// winner's content via `sendCampaignWinnerToRemainder` after
		// `declareABTestWinner`.
		const abFanout = resolveAbFanout(campaign);

		// ── PREP→DRIVE handoff: the checkpointed send walker. ──
		// Rather than resolving the WHOLE audience in one query (which a very
		// large topic/segment can push past the Convex per-query document-read
		// cap), open a `campaignSendJobs` checkpoint and hand off to
		// `resolveCampaignPage`, which streams the audience one bounded page at
		// a time, enqueuing as it goes and self-rescheduling until exhausted.
		// The completion guard in `campaigns/lifecycle.ts` holds the campaign in
		// `sending` until the walker flips the job to `done`.
		//
		// A/B test sends stream through the SAME walker (`variantMode:
		// 'ab_test'`): each page buckets contacts by `hashFraction(campaignId,
		// contactId)` — `h < testFraction` is the test cohort (variant A/B
		// sub-bucketed by hash), the rest is held back for the winner phase.
		// No global shuffle, no materialize, no read-cap ceiling.
		if (abFanout) {
			await ctx.runMutation(internal.campaigns.sendJob.createSendJob, {
				campaignId: args.campaignId,
				audience,
				variantMode: 'ab_test',
				testFraction: testFractionForSplit(abFanout.config.splitPercentage),
				splitPercentage: abFanout.config.splitPercentage,
			});
		} else {
			await ctx.runMutation(internal.campaigns.sendJob.createSendJob, {
				campaignId: args.campaignId,
				audience,
				variantMode: 'plain',
			});
		}
		await ctx.scheduler.runAfter(0, internal.campaigns.send.resolveCampaignPage, {
			campaignId: args.campaignId,
		});
		return {
			totalRecipients: 0,
			totalBatches: 0,
		};
	},
});

// ─── Per-variant batch enqueue ─────────────────────────────────────────

type EnqueueVariantArgs = {
	campaignId: Id<'campaigns'>;
	recipients: ReadonlyArray<CampaignRecipient>;
	abVariant: 'A' | 'B' | undefined;
	subject: string;
	htmlContent: string;
	from: string;
	replyTo?: string;
	audienceType?: 'topic' | 'segment';
	viewInBrowserUrl?: string;
	providerType?: string;
	trackingBaseUrl?: string;
	convexSiteUrl?: string;
	siteUrl?: string;
	// Singleton org id — anchors the Gmail FBL Feedback-ID SenderId.
	organizationId?: string;
	// RFC 2919 List-Id header value for a TOPIC campaign (omitted for segments).
	listId?: string;
	useTimezone: boolean;
	scheduledHour?: number;
	scheduledMinute?: number;
	// Org-level fallback zone (General settings) for recipients without a
	// valid IANA timezone; bucket to UTC only when the org setting is unset.
	defaultTimezone?: string;
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
		created.map((c) => [String(c.contactId), c.emailSendId])
	);

	type EmailEnqueueData = {
		emailSendId: Id<'emailSends'>;
		contactId: Id<'contacts'>;
		email: string;
		firstName?: string;
		lastName?: string;
		timezone?: string;
	};

	const emailsToEnqueue: EmailEnqueueData[] = [];
	for (const r of args.recipients) {
		const emailSendId = sendIdByContact.get(String(r._id));
		if (!emailSendId) continue; // duplicate skipped by createBatch — already enqueued
		emailsToEnqueue.push({
			emailSendId,
			contactId: r._id,
			email: r.email,
			firstName: r.firstName,
			lastName: r.lastName,
			timezone: r.timezone,
		});
	}

	let totalEnqueued = 0;

	if (args.useTimezone) {
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
			await ctx.scheduler.runAfter(delayMs, internal.delivery.enqueue.enqueueCampaignEmails, {
				campaignId: args.campaignId,
				emails: recipientsForZone.map((r) => ({
					emailSendId: r.emailSendId,
					contactId: r.contactId,
					email: r.email,
					firstName: r.firstName,
					lastName: r.lastName,
				})),
				from: args.from,
				replyTo: args.replyTo,
				subject: args.subject,
				htmlContent: args.htmlContent,
				convexSiteUrl: args.convexSiteUrl,
				siteUrl: args.siteUrl,
				audienceType: args.audienceType,
				viewInBrowserUrl: args.viewInBrowserUrl,
				providerType: args.providerType,
				trackingBaseUrl: args.trackingBaseUrl,
				organizationId: args.organizationId,
				listId: args.listId,
			});
			totalEnqueued += recipientsForZone.length;
		}
	} else {
		const CHUNK_SIZE = 50;
		for (let i = 0; i < emailsToEnqueue.length; i += CHUNK_SIZE) {
			const chunk = emailsToEnqueue.slice(i, i + CHUNK_SIZE);
			await ctx.scheduler.runAfter(0, internal.delivery.enqueue.enqueueCampaignEmails, {
				campaignId: args.campaignId,
				emails: chunk.map((r) => ({
					emailSendId: r.emailSendId,
					contactId: r.contactId,
					email: r.email,
					firstName: r.firstName,
					lastName: r.lastName,
				})),
				from: args.from,
				replyTo: args.replyTo,
				subject: args.subject,
				htmlContent: args.htmlContent,
				convexSiteUrl: args.convexSiteUrl,
				siteUrl: args.siteUrl,
				audienceType: args.audienceType,
				viewInBrowserUrl: args.viewInBrowserUrl,
				providerType: args.providerType,
				trackingBaseUrl: args.trackingBaseUrl,
				organizationId: args.organizationId,
				listId: args.listId,
			});
		}
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
export const resolveCampaignPage = internalAction({
	args: {
		campaignId: v.id('campaigns'),
	},
	handler: async (ctx, args): Promise<{ done: boolean; pageEnqueued: number }> => {
		const job = await ctx.runQuery(internal.campaigns.sendJob.getSendJob, {
			campaignId: args.campaignId,
		});
		// Stale/cancelled walk: another hop finished it, or the row is gone.
		if (!job || job.phase !== 'resolving') {
			return { done: true, pageEnqueued: 0 };
		}

		const campaign = await ctx.runQuery(internal.campaigns.sendQueries.getCampaignForSending, {
			campaignId: args.campaignId,
		});
		// Status-race guard: the campaign was cancelled / reverted to draft
		// between hops. Leave the job as-is (it will be wiped on the next send)
		// and stop — do NOT enqueue against a no-longer-sending campaign.
		if (!campaign || campaign.status !== 'sending') {
			return { done: true, pageEnqueued: 0 };
		}
		if (!campaign.emailTemplateId || !campaign.fromEmail) {
			// Should not happen (PREF validated), but never enqueue without them.
			return { done: true, pageEnqueued: 0 };
		}

		// Resolve ONE page at the job cursor — the bounded read that replaces the
		// whole-audience resolve.
		const page = await ctx.runQuery(internal.campaigns.audienceResolution.resolveRecipientPage, {
			audience: job.audience,
			cursor: job.cursor,
		});

		const audienceType = job.audience.kind;
		const from = campaign.fromName
			? `${campaign.fromName} <${campaign.fromEmail}>`
			: campaign.fromEmail;

		// Re-derive the per-hop send context (cheap reads). Archive URL is read
		// from the campaign snapshot PREP wrote (archiveToken), so each page's
		// emails carry the same "view in browser" link.
		const siteUrl = getOptional('SITE_URL');
		const convexSiteUrl = getOptional('CONVEX_SITE_URL');
		const viewInBrowserUrl =
			campaign.archiveToken && siteUrl
				? `${siteUrl}/archive?token=${campaign.archiveToken}`
				: undefined;

		const resolvedRoute = await ctx.runQuery(internal.lib.sendProviders.route.resolveSendRoute, {
			messageType: 'campaign',
		});
		if (!resolvedRoute) {
			// Fail-closed: the campaign pre-flight already requires a configured
			// delivery provider, so a null route here means one was removed between
			// schedule and this send hop. Do NOT dispatch to a phantom MTA — but do
			// NOT throw either: a bare throw would strand the walk forever (it stays
			// `resolving`, the cursor never advances, and every remaining recipient
			// is silently dropped). Instead reschedule this SAME hop after a backoff
			// so the walk resumes once a provider is (re)configured. The cursor is
			// left untouched, so the page re-resolves from the checkpoint.
			//
			// Touch `updatedAt` so this backoff reschedule — not the watchdog — owns
			// the retry loop while the provider stays unconfigured. Without the touch
			// the row's `updatedAt` would stay frozen at the last real progress and go
			// ever staler, so the `reconcile stuck campaign sends` watchdog would match
			// it on EVERY 5-min tick and schedule a fresh redundant hop on top of this
			// self-reschedule chain, unbounded. With the touch the watchdog stays the
			// true backstop: it only re-drives once the row goes stale again, i.e. once
			// this self-reschedule chain has actually died.
			logWarn(
				`Campaign send hop deferred for ${args.campaignId}: no delivery provider configured; retrying in ${NO_PROVIDER_RETRY_MS}ms`
			);
			await ctx.runMutation(internal.campaigns.sendJob.touchSendJob, {
				campaignId: args.campaignId,
			});
			await ctx.scheduler.runAfter(
				NO_PROVIDER_RETRY_MS,
				internal.campaigns.send.resolveCampaignPage,
				{ campaignId: args.campaignId }
			);
			return { done: false, pageEnqueued: 0 };
		}

		const activeTrackingDomain = await ctx.runQuery(
			internal.domains.trackingDomains.getActiveTrackingDomain,
			{}
		);
		const trackingBaseUrl = activeTrackingDomain?.domain
			? `https://${activeTrackingDomain.domain}`
			: undefined;

		// Gmail FBL: the deployment's singleton org id anchors a stable
		// Feedback-ID SenderId across the campaign mail stream. Resolved once per
		// hop in this system (no-session) context.
		const organizationId =
			(await ctx.runQuery(internal.campaigns.sendQueries.getSingletonOrganizationId, {})) ??
			undefined;

		// RFC 2919 List-Id — a stable mailing-list handle for TOPIC campaigns,
		// derived from the topic id/name + the sending domain (host of the From
		// address). Segment campaigns get none (a computed audience has no single
		// list identity). Built once per hop (it is identical for every recipient
		// in this campaign) and threaded through the enqueue into the composer.
		let listId: string | undefined;
		if (job.audience.kind === 'topic') {
			const topic = await ctx.runQuery(internal.topics.topics.getInternal, {
				topicId: job.audience.topicId,
			});
			// Sending domain = host part of the From address (`local@host`).
			const sendingDomain = campaign.fromEmail.split('@')[1] ?? '';
			if (topic && sendingDomain) {
				listId =
					getListIdHeader({
						domain: sendingDomain,
						topic: { id: String(topic._id), name: topic.name },
					}) ?? undefined;
			}
		}

		// `ab_winner` deliberately ignores timezone-aware scheduling: by the
		// time the winner is declared, the original scheduled hour/minute is no
		// longer the user's intent (they just want the rest delivered). `plain`
		// and `ab_test` honor it.
		const variantMode = job.variantMode ?? 'plain';
		const useTimezone =
			variantMode !== 'ab_winner' &&
			campaign.useRecipientTimezone === true &&
			campaign.scheduledHour !== undefined &&
			campaign.scheduledMinute !== undefined;

		// Org-level timezone (General settings) — the fallback zone for
		// timezone-aware scheduling when a recipient has no valid zone of their
		// own. Only loaded on the timezone-aware path.
		const defaultTimezone =
			(useTimezone
				? await ctx.runQuery(internal.campaigns.sendQueries.getOrgTimezone, {})
				: undefined) ?? undefined;

		// Classify THIS page's recipients into variant buckets per the job's
		// variantMode + the deterministic per-contact hash, then group each
		// bucket by language and enqueue. `null` from `bucketFor` means the
		// contact belongs to the OTHER phase (held-back remainder in `ab_test`,
		// already-tested cohort in `ab_winner`) and is skipped — the hash
		// guarantees the two phases partition the audience disjointly.
		const testFraction = job.testFraction ?? 0;
		const bucketFor = (contactId: string): 'A' | 'B' | undefined | null => {
			if (variantMode === 'plain') return undefined; // no tag, always enqueue
			const h = hashFraction(String(args.campaignId), contactId);
			if (variantMode === 'ab_test') {
				// h < testFraction ⇒ test cohort (A/B by sub-bucket); else remainder.
				return variantForHash(h, testFraction);
			}
			// ab_winner: h >= testFraction ⇒ remainder gets the winning variant;
			// the test cohort (h < testFraction) is skipped (already sent).
			return h >= testFraction ? (job.winningVariant ?? 'A') : null;
		};

		// content-test variant-B template id (subject tests reuse A's html).
		const variantBTemplateId =
			campaign.abTestConfig?.testType === 'content' && campaign.abTestConfig.variantBTemplateId
				? (campaign.abTestConfig.variantBTemplateId as Id<'emailTemplates'>)
				: undefined;
		const variantBSubject =
			campaign.abTestConfig?.testType === 'subject'
				? campaign.abTestConfig.variantBSubject
				: undefined;

		let pageEnqueued = 0;
		if (page.recipients.length > 0) {
			const template = await ctx.runQuery(internal.campaigns.sendQueries.getEmailTemplate, {
				templateId: campaign.emailTemplateId,
			});
			const tmplDefaultLanguage = template?.defaultLanguage ?? 'en';
			const campaignSubjectOverride = campaign.subject;

			// Group by (language, variant) so each combination enqueues with the
			// right per-language content + variant tag in one batch.
			type Bucket = { language: string; variant: 'A' | 'B' | undefined };
			const byBucket = new Map<string, { bucket: Bucket; recipients: typeof page.recipients }>();
			for (const recipient of page.recipients) {
				const variant = bucketFor(String(recipient._id));
				if (variant === null) continue; // belongs to the other phase — skip
				const language = recipient.language ?? tmplDefaultLanguage;
				const key = `${language} ${variant ?? '-'}`;
				if (!byBucket.has(key))
					byBucket.set(key, { bucket: { language, variant }, recipients: [] });
				byBucket.get(key)!.recipients.push(recipient);
			}

			for (const { bucket, recipients } of byBucket.values()) {
				if (recipients.length === 0) continue;

				// Resolve the content for this (language, variant). Variant A and
				// the no-tag plain bucket use the primary template; variant B uses
				// variantBSubject (subject test) or variantBTemplateId (content test).
				let subject: string;
				let htmlContent: string;
				if (bucket.variant === 'B') {
					if (variantBTemplateId) {
						const bContent = await ctx.runQuery(
							internal.campaigns.sendQueries.getEmailTemplateForLanguage,
							{ templateId: variantBTemplateId, language: bucket.language }
						);
						if (!bContent) continue;
						subject = bContent.subject;
						htmlContent = bContent.htmlContent;
					} else {
						// Subject test — variant B reuses A's html with the alt subject.
						const aContent = await ctx.runQuery(
							internal.campaigns.sendQueries.getEmailTemplateForLanguage,
							{ templateId: campaign.emailTemplateId, language: bucket.language }
						);
						if (!aContent) continue;
						subject = variantBSubject ?? campaignSubjectOverride ?? aContent.subject;
						htmlContent = aContent.htmlContent;
					}
				} else {
					const aContent = await ctx.runQuery(
						internal.campaigns.sendQueries.getEmailTemplateForLanguage,
						{ templateId: campaign.emailTemplateId, language: bucket.language }
					);
					if (!aContent) continue;
					subject = campaignSubjectOverride ?? aContent.subject;
					htmlContent = aContent.htmlContent;
				}

				pageEnqueued += await enqueueVariantBatch(ctx, {
					campaignId: args.campaignId,
					recipients,
					abVariant: bucket.variant,
					subject,
					htmlContent,
					from,
					replyTo: campaign.replyTo,
					audienceType,
					viewInBrowserUrl,
					providerType: resolvedRoute.providerType,
					trackingBaseUrl,
					convexSiteUrl,
					siteUrl,
					organizationId,
					listId,
					useTimezone: useTimezone === true,
					scheduledHour: campaign.scheduledHour,
					scheduledMinute: campaign.scheduledMinute,
					defaultTimezone,
				});
			}
		}

		// Bump the daily send count for THIS page (the in-line path bumped once
		// for the whole send; the walker bumps per page so the counter stays
		// accurate even if a later hop is delayed).
		if (pageEnqueued > 0) {
			await ctx.runMutation(internal.campaigns.sendQueries.incrementDailySendCountInternal, {
				count: pageEnqueued,
			});
		}

		// Advance the checkpoint: patch cursor + counters, flip to `done` on the
		// last page. Committing the cursor AFTER the enqueue means a crash before
		// this point re-runs the SAME page on resume — and createBatch's
		// idempotent guard makes that re-run write zero duplicate rows.
		const advanced = await ctx.runMutation(internal.campaigns.sendJob.advanceSendJob, {
			campaignId: args.campaignId,
			nextCursor: page.nextCursor,
			pageEnqueued,
			pageCandidates: page.pageCandidates,
		});

		if (page.nextCursor !== null) {
			// More pages — self-reschedule the next hop.
			await ctx.scheduler.runAfter(0, internal.campaigns.send.resolveCampaignPage, {
				campaignId: args.campaignId,
			});
			return { done: false, pageEnqueued };
		}

		// Last page. Decide whether the campaign can complete NOW (empty-audience
		// fast-path), preserving the prior behaviour without a full-table scan:
		//   - plain:     enqueued nobody ⇒ empty audience ⇒ mark sent.
		//   - ab_test:   the audience itself is empty (`totalCandidates === 0`) ⇒
		//                no test cohort AND no remainder ⇒ mark sent. A non-empty
		//                audience that simply put nobody in the test cohort is NOT
		//                complete — the winner phase still sends the remainder, so
		//                we leave the campaign in `sending`/`testing`.
		//   - ab_winner: enqueued nobody ⇒ the remainder was empty ⇒ the whole
		//                campaign (test cohort sent in phase 1 + empty remainder)
		//                is done ⇒ mark sent.
		// In every other case the per-send completion callback / reconcile cron
		// completes it once the last queued send clears (the guard no longer
		// blocks now that phase === 'done').
		const emptyAudienceComplete =
			advanced &&
			(variantMode === 'ab_test' ? advanced.totalCandidates === 0 : advanced.enqueuedCount === 0);
		if (emptyAudienceComplete) {
			await ctx.runMutation(internal.campaigns.lifecycle.transition, {
				campaignId: args.campaignId,
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
		// phase used (ADR-0033). The `testFraction` is re-derived from the
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
