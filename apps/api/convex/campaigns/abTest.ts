import { v } from 'convex/values';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { internalAction, internalQuery } from '../_generated/server';
import type { QueryCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { getUserIdFromSession, requireOrgPermission } from '../lib/sessionOrganization';
import { requireDraftCampaign } from './guards';
import { throwNotFound, throwInvalidState, throwInvalidInput } from '../_utils/errors';

/**
 * Per-variant A/B stats from a variant's `emailSends` rows. opened/clicked are
 * counted from monotonic timestamps (an opened-then-bounced recipient still
 * counts as opened — counting by current `status` dropped them), and the rate
 * denominator is "ever delivered", consistent with the main campaign report.
 * `delivered` is guaranteed ≥ opened ≥ clicked, so the rates never exceed 100%.
 * Reduced shape behind the `getABTestStats` query that powers the report's A/B
 * fold-in.
 */
export function computeAbVariantStats(sends: ReadonlyArray<Doc<'emailSends'>>): {
	sent: number;
	delivered: number;
	opened: number;
	clicked: number;
	openRate: number;
	clickRate: number;
} {
	const sent = sends.length;
	let delivered = 0;
	let opened = 0;
	let clicked = 0;
	for (const s of sends) {
		if (s.deliveredAt || s.openedAt || s.clickedAt) delivered++;
		if (s.openedAt) opened++;
		if (s.clickedAt || (s.clickedLinks && s.clickedLinks.length > 0)) clicked++;
	}
	return {
		sent,
		delivered,
		opened,
		clicked,
		openRate: delivered > 0 ? (opened / delivered) * 100 : 0,
		clickRate: delivered > 0 ? (clicked / delivered) * 100 : 0,
	};
}

// bounded: per-variant `emailSends` is read via the `by_campaign_and_variant`
// index and capped at this ceiling, so a viral campaign can't blow the
// per-query document read limit. A variant with more than this many sends is
// well past statistical significance, so the truncated counts don't move the
// A/B decision.
const AB_VARIANT_SCAN_LIMIT = 10000;

/**
 * Load both A/B variants' `emailSends` for a campaign and reduce each to the
 * shared `computeAbVariantStats` shape. Single source of truth behind the
 * `getABTestStats` query so the load bound and stat math stay in one place.
 */
export async function loadAbTestStats(
	ctx: QueryCtx,
	campaignId: Id<'campaigns'>
): Promise<{
	variantA: ReturnType<typeof computeAbVariantStats>;
	variantB: ReturnType<typeof computeAbVariantStats>;
}> {
	const [variantASends, variantBSends] = await Promise.all([
		ctx.db
			.query('emailSends')
			.withIndex('by_campaign_and_variant', (q) =>
				q.eq('campaignId', campaignId).eq('abVariant', 'A')
			)
			.take(AB_VARIANT_SCAN_LIMIT),
		ctx.db
			.query('emailSends')
			.withIndex('by_campaign_and_variant', (q) =>
				q.eq('campaignId', campaignId).eq('abVariant', 'B')
			)
			.take(AB_VARIANT_SCAN_LIMIT),
	]);

	return {
		variantA: computeAbVariantStats(variantASends),
		variantB: computeAbVariantStats(variantBSends),
	};
}

// Mutation to enable A/B testing on a campaign. Auth + validation shell;
// the **AB test lifecycle (module)** owns the patch + audit-log effect.
export const enableABTest = authedMutation({
	args: {
		campaignId: v.id('campaigns'),
		testType: v.union(v.literal('subject'), v.literal('content')),
		variantBSubject: v.optional(v.string()),
		variantBTemplateId: v.optional(v.id('emailTemplates')),
		splitPercentage: v.number(), // 10-50
		winnerCriteria: v.union(v.literal('open_rate'), v.literal('click_rate'), v.literal('manual')),
		testDuration: v.optional(v.number()), // Hours
	},
	handler: async (ctx, args) => {
		// authz: requireDraftCampaign enforces campaigns:manage
		const { session } = await requireDraftCampaign(
			ctx,
			args.campaignId,
			'enable A/B testing',
			'A/B testing can only be enabled on draft campaigns'
		);

		// Validate split percentage
		if (args.splitPercentage < 10 || args.splitPercentage > 50) {
			throwInvalidInput('Split percentage must be between 10 and 50');
		}

		// Validate test type requirements
		if (args.testType === 'subject' && !args.variantBSubject) {
			throwInvalidInput('Variant B subject is required for subject tests');
		}

		if (args.testType === 'content' && !args.variantBTemplateId) {
			throwInvalidInput('Variant B template is required for content tests');
		}

		// If content test, verify template exists
		if (args.testType === 'content' && args.variantBTemplateId) {
			const template = await ctx.db.get(args.variantBTemplateId);
			if (!template) {
				throwNotFound('Variant B template');
			}
		}

		const abTestConfig: {
			testType: 'subject' | 'content';
			splitPercentage: number;
			winnerCriteria: 'open_rate' | 'click_rate' | 'manual';
			variantBSubject?: string;
			variantBTemplateId?: string;
			testDuration?: number;
		} = {
			testType: args.testType,
			splitPercentage: args.splitPercentage,
			winnerCriteria: args.winnerCriteria,
		};

		if (args.testType === 'subject') {
			abTestConfig.variantBSubject = args.variantBSubject;
		} else {
			abTestConfig.variantBTemplateId = args.variantBTemplateId as string;
		}

		if (args.winnerCriteria !== 'manual' && args.testDuration) {
			abTestConfig.testDuration = args.testDuration;
		}

		const outcome = await ctx.runMutation(internal.campaigns.abTestLifecycle.transition, {
			campaignId: args.campaignId,
			input: { to: 'pending', at: Date.now(), config: abTestConfig },
			userId: session.userId,
		});

		if (!outcome.ok) {
			throwInvalidState(`Cannot enable AB test: ${outcome.reason}`);
		}

		return args.campaignId;
	},
});

// Mutation to disable A/B testing on a campaign. Resets the full AB test
// state via the lifecycle's `→ none` transition.
export const disableABTest = authedMutation({
	args: {
		campaignId: v.id('campaigns'),
	},
	handler: async (ctx, args) => {
		// authz: requireDraftCampaign enforces campaigns:manage
		const { session } = await requireDraftCampaign(
			ctx,
			args.campaignId,
			'disable A/B testing',
			'A/B testing can only be disabled on draft campaigns'
		);

		const outcome = await ctx.runMutation(internal.campaigns.abTestLifecycle.transition, {
			campaignId: args.campaignId,
			input: { to: 'none', at: Date.now() },
			userId: session.userId,
		});

		if (!outcome.ok) {
			throwInvalidState(`Cannot disable AB test: ${outcome.reason}`);
		}

		return args.campaignId;
	},
});

// Mutation to declare A/B test winner (for manual selection or auto-triggered).
export const declareABTestWinner = authedMutation({
	args: {
		campaignId: v.id('campaigns'),
		winner: v.union(v.literal('A'), v.literal('B')),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'campaigns:manage',
			'Only owners and admins can declare A/B test winners'
		);

		const campaign = await ctx.db.get(args.campaignId);
		if (!campaign) {
			throwNotFound('Campaign');
		}

		if (!campaign.isABTest) {
			throwInvalidState('Campaign is not an A/B test');
		}

		if (campaign.abTestStatus !== 'testing') {
			throwInvalidState('A/B test is not in testing phase');
		}

		const outcome = await ctx.runMutation(internal.campaigns.abTestLifecycle.transition, {
			campaignId: args.campaignId,
			input: { to: 'winner_selected', at: Date.now(), winner: args.winner },
			userId: session.userId,
		});

		if (!outcome.ok) {
			throwInvalidState(`Cannot declare AB test winner: ${outcome.reason}`);
		}

		return args.campaignId;
	},
});

// Internal inputs for automatic winner selection: current AB status, the
// configured criterion, and both variants' timestamp-based stats.
export const getAbTestWinnerInputs = internalQuery({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args) => {
		const campaign = await ctx.db.get(args.campaignId);
		if (!campaign || !campaign.isABTest) return null;

		const variantASends = await ctx.db
			.query('emailSends')
			.withIndex('by_campaign_and_variant', (q) =>
				q.eq('campaignId', args.campaignId).eq('abVariant', 'A')
			)
			.take(10000);
		const variantBSends = await ctx.db
			.query('emailSends')
			.withIndex('by_campaign_and_variant', (q) =>
				q.eq('campaignId', args.campaignId).eq('abVariant', 'B')
			)
			.take(10000);

		return {
			abTestStatus: campaign.abTestStatus ?? null,
			winnerCriteria: campaign.abTestConfig?.winnerCriteria ?? 'manual',
			variantA: computeAbVariantStats(variantASends),
			variantB: computeAbVariantStats(variantBSends),
		};
	},
});

// Scheduled `testDuration` hours after the test cohort ships (enqueued by the
// AB-test lifecycle's `schedule_auto_winner` effect on `→ testing`). Picks the
// winning variant by the configured criterion and declares it, which fires the
// remainder send. THIS is what guarantees the held-back 40–60% of the audience
// actually receives the campaign for `open_rate`/`click_rate` tests — before it
// existed, those campaigns sat in `testing` forever.
export const autoDeclareWinner = internalAction({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args): Promise<{ skipped: boolean; winner?: 'A' | 'B' }> => {
		const data = await ctx.runQuery(internal.campaigns.abTest.getAbTestWinnerInputs, {
			campaignId: args.campaignId,
		});

		// Only act while still in `testing` — a manual winner or a disable may
		// have already resolved it. Idempotent and safe to re-run.
		if (!data || data.abTestStatus !== 'testing') return { skipped: true };

		// Pick by the configured criterion. On a tie — including the common
		// no-engagement-data case — default to variant A so the remainder
		// audience is ALWAYS sent rather than stranded in `testing`.
		const metric = data.winnerCriteria === 'click_rate' ? 'clickRate' : 'openRate';
		const winner: 'A' | 'B' = data.variantB[metric] > data.variantA[metric] ? 'B' : 'A';

		await ctx.runMutation(internal.campaigns.abTestLifecycle.transition, {
			campaignId: args.campaignId,
			input: { to: 'winner_selected', at: Date.now(), winner },
			userId: 'system:auto_winner',
		});

		return { skipped: false, winner };
	},
});

// Query to get A/B test stats for a campaign
export const getABTestStats = authedQuery({
	args: {
		campaignId: v.id('campaigns'),
	},
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);
		const campaign = await ctx.db.get(args.campaignId);
		if (!campaign) {
			throwNotFound('Campaign');
		}

		if (!campaign.isABTest) {
			return null;
		}

		// Load + reduce both variants (shared helper: bounded load,
		// timestamp-based counts, delivered denominator — consistent with the
		// main campaign report and the analytics HTTP surface).
		const { variantA, variantB } = await loadAbTestStats(ctx, args.campaignId);

		return {
			status: campaign.abTestStatus,
			winner: campaign.abWinner,
			winnerSelectedAt: campaign.abWinnerSelectedAt,
			config: campaign.abTestConfig ?? null,
			variantA,
			variantB,
		};
	},
});
