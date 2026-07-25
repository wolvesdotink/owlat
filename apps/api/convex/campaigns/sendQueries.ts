import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import { components } from '../_generated/api';
import { contentScanFlagValidator } from '../lib/convexValidators';
import type { StoredAudience } from './audience';
import { logError } from '../lib/runtimeLog';
import { nextDailySendCount } from '../lib/sendingLimits';
import { requireOrgMember } from '../lib/sessionOrganization';
import { rateLimiter } from '../rateLimiter';

/**
 * The set of email addresses a test/preview send may target: the org's own
 * member inboxes. Test sends emit real, unscanned, attacker-controllable HTML
 * from the org's VERIFIED (DKIM/SPF/DMARC-aligned) sending domain, so without a
 * recipient allowlist the lowest-privilege member could use the action as an
 * open relay to spray high-credibility phishing at arbitrary external victims.
 * On a single-org deployment the `userProfiles` table IS the member roster, so
 * its emails are exactly the legitimate preview targets. Inherits the caller's
 * identity through `ctx.runQuery` (and re-asserts org membership).
 */
export const getTestSendAllowedRecipients = internalQuery({
	args: {},
	handler: async (
		ctx
	): Promise<{ allowed: string[]; callerUserId: string; organizationId: string }> => {
		const session = await requireOrgMember(ctx);
		// 1-per-user on a single-org instance — the member roster, bounded.
		const profiles = await ctx.db.query('userProfiles').collect(); // bounded: org member roster (single-org deployment: tiny)
		const allowed = profiles
			.map((p) => p.email?.toLowerCase())
			.filter((e): e is string => typeof e === 'string' && e.length > 0);
		return {
			allowed,
			callerUserId: session.userId,
			organizationId: session.activeOrganizationId,
		};
	},
});

/**
 * Per-user rate limit for the test/preview send actions, so the per-call
 * 5-recipient cap can't be looped into a high-volume send that burns the
 * sending domain's reputation. Keyed on the caller's user id.
 */
export const checkTestSendRateLimit = internalMutation({
	args: { userId: v.string() },
	handler: async (ctx, args): Promise<{ ok: boolean; retryAfter?: number }> => {
		const { ok, retryAfter } = await rateLimiter.limit(ctx, 'testEmailSend', {
			key: args.userId,
		});
		return { ok, retryAfter };
	},
});

// Campaign send/fail counter bumps live on sendLifecycle's effect list
// (`campaign_stats_sent` on the `sent` reducer, `campaign_stats_failed` on
// the `failed` reducer) per ADR-0006. The historical
// `recordEmailSendResult` mutation has been removed — its only caller was
// the deleted `onEmailComplete`, and its handler silently ignored the
// `failed` arg, so the effect-based replacement also fixes a previously
// undercounted statsFailed counter.
//
// Campaign status transitions (markCampaignSent, updateCampaignToSending,
// setCampaignPendingReview, revertCampaignToDraft) lived here pre-ADR-0017.
// They were deleted — the **Campaign lifecycle (module)** at
// `convex/campaigns/lifecycle.ts` is now the only writer of `campaigns.status`.
// Callers (the campaign-send orchestrator) call
// `internal.campaigns.lifecycle.transition` directly.

// Internal query to get campaign for sending (with minimal data)
export const getCampaignForSending = internalQuery({
	args: {
		campaignId: v.id('campaigns'),
	},
	handler: async (ctx, args) => {
		return await ctx.db.get(args.campaignId);
	},
});

// The org-level timezone configured in General settings (instanceSettings).
// Used as the fallback zone for timezone-aware campaign scheduling when a
// recipient has no valid IANA timezone of their own — so the org setting
// actually influences send timing instead of every unknown-zone recipient
// silently bucketing to UTC. Returns undefined when unset.
export const getOrgTimezone = internalQuery({
	args: {},
	handler: async (ctx) => {
		const settings = await ctx.db.query('instanceSettings').first();
		return settings?.timezone ?? undefined;
	},
});

/**
 * The deployment's singleton BetterAuth organization id, for system-context
 * (no session) callers — the campaign send walker uses it to anchor the
 * Gmail FBL `Feedback-ID` SenderId across the whole mail stream. Owlat is
 * single-org-per-deployment, so the first organization row is the org. Returns
 * `undefined` if no org is configured yet (the header is then omitted).
 */
export const getSingletonOrganizationId = internalQuery({
	args: {},
	handler: async (ctx): Promise<string | undefined> => {
		// Best-effort: the Feedback-ID is a deliverability nicety, never a
		// send-blocking dependency. If the BetterAuth component is unavailable
		// (e.g. not registered in the test harness, or a transient component
		// error), fall back to no anchor → the composer simply omits the header.
		try {
			const result = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
				model: 'organization',
				where: [],
				paginationOpts: { cursor: null, numItems: 1 },
			})) as { page?: Array<{ id?: string; _id?: string }> } | null;
			const org = result?.page?.[0];
			return org?.id ?? org?._id ?? undefined;
		} catch {
			return undefined;
		}
	},
});

// Internal query to get email template
export const getEmailTemplate = internalQuery({
	args: {
		templateId: v.id('emailTemplates'),
	},
	handler: async (ctx, args) => {
		return await ctx.db.get(args.templateId);
	},
});

// Type for HTML translation stored in htmlTranslations field
interface HtmlTranslation {
	htmlContent: string;
	subject: string;
}

// Internal query to get email template HTML for a specific language
// Returns htmlContent and subject for the requested language with fallback
export const getEmailTemplateForLanguage = internalQuery({
	args: {
		templateId: v.id('emailTemplates'),
		language: v.optional(v.string()),
	},
	handler: async (
		ctx,
		args
	): Promise<{
		htmlContent: string;
		subject: string;
		resolvedLanguage: string;
	} | null> => {
		const template = await ctx.db.get(args.templateId);
		if (!template) {
			return null;
		}

		if (!template.htmlContent) {
			return null;
		}

		const defaultLanguage = template.defaultLanguage ?? 'en';
		const requestedLanguage = args.language ?? defaultLanguage;

		// If requesting default language or no specific language, return main content
		if (requestedLanguage === defaultLanguage) {
			return {
				htmlContent: template.htmlContent,
				subject: template.subject,
				resolvedLanguage: defaultLanguage,
			};
		}

		// Check if HTML translation exists for requested language
		if (template.htmlTranslations) {
			try {
				const htmlTranslations: Record<string, HtmlTranslation> = JSON.parse(
					template.htmlTranslations
				);
				const translation = htmlTranslations[requestedLanguage];
				if (translation?.htmlContent) {
					return {
						htmlContent: translation.htmlContent,
						subject: translation.subject,
						resolvedLanguage: requestedLanguage,
					};
				}
			} catch (e) {
				logError(`Failed to parse htmlTranslations for template ${template._id}:`, e);
				// Fall through to default language
			}
		}

		// Fall back to default language
		return {
			htmlContent: template.htmlContent,
			subject: template.subject,
			resolvedLanguage: defaultLanguage,
		};
	},
});

// Campaign recipient resolution moved to the Audience resolution (module) at
// `campaigns/audienceResolution.ts` (ADR-0033) — it owns the single
// eligibility predicate (`selectRecipient`) and the `CampaignRecipient` type,
// shared by the checkpointed send walker (`resolveRecipientPage`) and the wizard
// count (`countRecipients`).

/**
 * Freeze a segment Audience's filters at send time (ADR-0033). This is the
 * orchestrator-owned write the resolver only ever *reads*: it copies the live
 * Segment's `filters` into `audience.frozenFilters` so an already-sent
 * Campaign reproduces the exact Segment definition it targeted even after the
 * Segment is later edited — and so an A/B winner-remainder send resolves
 * against the same cohort the test phase did.
 *
 * Idempotent and total: a topic Audience, a segment that already carries
 * `frozenFilters`, or a segment whose live Segment is gone (nothing to
 * snapshot) all pass through unchanged. Returns the Audience the orchestrator
 * should resolve against (`null` only if the Campaign has no audience).
 */
export const freezeCampaignAudience = internalMutation({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args): Promise<StoredAudience | null> => {
		const campaign = await ctx.db.get(args.campaignId);
		if (!campaign?.audience) return null;
		const audience = campaign.audience;

		// Only an un-frozen segment Audience needs a snapshot.
		if (audience.kind !== 'segment' || audience.frozenFilters) {
			return audience;
		}

		const segment = await ctx.db.get(audience.segmentId);
		// Segment deleted before send and no prior snapshot — nothing to freeze.
		// Resolution will yield zero recipients (and log) rather than guess.
		if (!segment) return audience;

		const frozen: StoredAudience = {
			kind: 'segment',
			segmentId: audience.segmentId,
			frozenFilters: segment.filters,
		};
		await ctx.db.patch(args.campaignId, { audience: frozen });
		return frozen;
	},
});

// Internal query to get due scheduled campaigns
export const getDueScheduledCampaigns = internalQuery({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const campaigns = await ctx.db
			.query('campaigns')
			.withIndex('by_status_and_scheduled_at', (q) =>
				q.eq('status', 'scheduled').lte('scheduledAt', now)
			)
			.collect(); // bounded: scheduled campaigns due this tick (drained each cron run)

		return campaigns;
	},
});

// `setCampaignPendingReview` and `revertCampaignToDraft` were deleted per
// ADR-0017. The orchestrator now calls
// `lifecycle.transition({ to: 'pending_review' })` and
// `lifecycle.transition({ to: 'draft', contentBlockReason })` respectively.

// Internal mutation to store content scan results
export const storeContentScanResult = internalMutation({
	args: {
		resourceType: v.union(
			v.literal('campaign'),
			v.literal('transactional'),
			v.literal('attachment'),
			v.literal('media_upload')
		),
		resourceId: v.string(),
		score: v.number(),
		level: v.union(v.literal('clean'), v.literal('suspicious'), v.literal('blocked')),
		flags: v.array(contentScanFlagValidator),
		scannedAt: v.number(),
	},
	handler: async (ctx, args) => {
		await ctx.db.insert('contentScanResults', {
			resourceType: args.resourceType,
			resourceId: args.resourceId,
			score: args.score,
			level: args.level,
			flags: args.flags,
			scannedAt: args.scannedAt,
		});
	},
});

// URL reputation cache (Google Safe Browsing) — read/write of the
// `urlReputationCache` table. Backs the Convex `UrlReputationCache` adapter the
// campaign-send orchestrator hands to `checkUrlReputation`, so repeated links
// across campaigns are served from cache instead of re-hitting the Safe
// Browsing API. Rows are keyed on the SHA-256 of the normalized URL; a row is
// only returned while it is still within its TTL (24h clean / 1h flagged).
export const getUrlReputationVerdict = internalQuery({
	args: { urlHash: v.string() },
	handler: async (
		ctx,
		args
	): Promise<{
		verdict: 'safe' | 'malicious' | 'suspicious';
		source: string;
		threats?: string[];
		checkedAt: number;
		expiresAt: number;
	} | null> => {
		const row = await ctx.db
			.query('urlReputationCache')
			.withIndex('by_url_hash', (q) => q.eq('urlHash', args.urlHash))
			.first();
		if (!row) return null;
		// Honor the stored TTL — an expired row is treated as a miss so the
		// caller re-checks (and re-caches) rather than serving a stale verdict.
		if (Date.now() > row.expiresAt) return null;
		return {
			verdict: row.verdict,
			source: row.source,
			threats: row.threats,
			checkedAt: row.checkedAt,
			expiresAt: row.expiresAt,
		};
	},
});

// Internal mutation to upsert a cached URL reputation verdict. Replaces any
// existing row for the same hash (refreshing the TTL) so the table cannot
// accumulate duplicate verdicts for the same normalized URL.
export const upsertUrlReputationVerdict = internalMutation({
	args: {
		urlHash: v.string(),
		verdict: v.union(v.literal('safe'), v.literal('malicious'), v.literal('suspicious')),
		source: v.string(),
		threats: v.optional(v.array(v.string())),
		checkedAt: v.number(),
		expiresAt: v.number(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('urlReputationCache')
			.withIndex('by_url_hash', (q) => q.eq('urlHash', args.urlHash))
			.first();
		const row = {
			urlHash: args.urlHash,
			verdict: args.verdict,
			source: args.source,
			threats: args.threats,
			checkedAt: args.checkedAt,
			expiresAt: args.expiresAt,
		};
		if (existing) {
			await ctx.db.patch(existing._id, row);
		} else {
			await ctx.db.insert('urlReputationCache', row);
		}
	},
});

// Internal mutation to increment the daily send count after queuing a campaign
// send page. Shares the pure nextDailySendCount reset logic with the
// transactional dispatch path.
export const incrementDailySendCountInternal = internalMutation({
	args: { count: v.number() },
	handler: async (ctx, args) => {
		const settings = await ctx.db.query('instanceSettings').first();
		if (!settings) return;
		await ctx.db.patch(settings._id, nextDailySendCount(settings, args.count, Date.now()));
	},
});

// `updateCampaignToSending` was deleted per ADR-0017. The orchestrator
// now calls `lifecycle.transition({ to: 'sending' })`.

// `listSentContactIdsForCampaign` was removed: the A/B winner-remainder send
// now streams through the checkpointed walker (`emails.resolveCampaignPage`,
// `variantMode: 'ab_winner'`). Remainder membership is recomputable from the
// deterministic per-contact hash (`h >= testFraction`), so the second phase no
// longer needs a full-table scan of already-sent contact ids to exclude the
// test cohort.
