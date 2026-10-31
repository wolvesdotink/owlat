/**
 * Campaign lifecycle (module) — single writer of `campaigns.status` and
 * its companion fields (`sentAt`, `cancelledAt`, `scheduledAt`,
 * `contentBlockReason`, stats-zero on send). Sibling of the
 * **AB test lifecycle (module)** which owns `campaigns.abTestStatus`.
 *
 * Ten legal edges — see CONTEXT.md "Campaign status" for the full graph.
 * The pure half (status and transition types, validator, graph, reducer)
 * lives in `lifecycleReducer.ts`; this module applies its result and runs
 * the effects.
 *
 * Effects:
 *   audit_log                            — fires on every transition.
 *   schedule_campaign_send_orchestrator  — fires on → scheduled / → sending.
 *   track_event                          — fires on user-driven
 *                                          → scheduled / → sending /
 *                                          → cancelled (skipped for
 *                                          system-source transitions).
 *   start_ab_test_if_enabled             — cross-machine; fires on
 *                                          → sending when isABTest.
 *   notify_marketing                     — fires on → scheduled (the
 *                                          15-minute reminder) and → sent
 *                                          (the "finished" notice).
 *
 * `userId` discriminates user-driven vs system-source:
 *   - user mutations pass session.userId.
 *   - internal callers pass 'system:scheduler_tick' / 'system:content_scan' /
 *     'system:admin_review' / etc. Audit log records the value verbatim;
 *     track_event fires only when the userId is NOT prefixed with 'system:'.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditLog } from '../lib/auditLog';
import { refuse, type LifecycleReason } from '../lib/lifecycle';
import { rollupCampaignStatsRow } from './statShards';
import { trackEvent } from '../lib/posthogHelpers';
import { recordListingCounter } from '../lib/listingCounters';
import { throwInvalidState } from '../_utils/errors';
import { getLive } from '../lib/softDelete';
import { scheduleMarketingNotice } from '../marketing/noticeEvents';
import {
	CAMPAIGN_LIFECYCLE,
	reduce,
	transitionInputValidator,
	type CampaignStatus,
	type CampaignTransitionInput,
	type Effect,
} from './lifecycleReducer';

export type { CampaignStatus, CampaignTransitionInput } from './lifecycleReducer';

// ─── Types ──────────────────────────────────────────────────────────────────

export type CampaignTransitionOutcome =
	| {
			ok: true;
			applied: 'transitioned' | 'recorded';
			from: CampaignStatus;
			to: CampaignStatus;
			campaignId: Id<'campaigns'>;
	  }
	| {
			ok: false;
			// `illegal_edge` / `terminal` come from the generic lifecycle core;
			// `campaign_not_found` is this module's own.
			reason: LifecycleReason<'campaign_not_found'>;
			from?: CampaignStatus;
			to?: CampaignStatus;
	  };

/**
 * Translate a failed lifecycle transition outcome into the thrown
 * `invalid_state` error each campaign mutation surfaces to the caller. The
 * thin-shell mutations keep their own status pre-checks and auth
 * preamble — this only folds the shared `outcome → throw` tail.
 *
 * `verb` is the user-facing action ("send", "cancel", "schedule", …); the
 * message reads `Cannot <verb> campaign: <reason>`.
 */
export function assertTransitioned(
	outcome: CampaignTransitionOutcome,
	verb: string
): asserts outcome is Extract<CampaignTransitionOutcome, { ok: true }> {
	if (!outcome.ok) {
		throwInvalidState(`Cannot ${verb} campaign: ${outcome.reason}`);
	}
}

// ─── Runner ─────────────────────────────────────────────────────────────────

async function applyEffects(ctx: MutationCtx, effects: ReadonlyArray<Effect>): Promise<void> {
	for (const effect of effects) {
		switch (effect.kind) {
			case 'audit_log': {
				await recordAuditLog(ctx, {
					userId: effect.userId,
					action: effect.action,
					resource: 'campaign',
					resourceId: effect.campaignId,
					details: effect.details,
				});
				break;
			}
			case 'schedule_campaign_send_orchestrator': {
				await ctx.scheduler.runAfter(effect.delayMs, internal.campaigns.send.startCampaignSend, {
					campaignId: effect.campaignId,
				});
				break;
			}
			case 'track_event': {
				// Through the shared helper, not a direct schedule: that is where
				// `analytics.posthog` is enforced.
				await trackEvent(ctx, { userId: effect.userId }, effect.event, {
					campaignId: effect.campaignId,
				});
				break;
			}
			case 'notify_marketing': {
				await scheduleMarketingNotice(ctx, effect.event, effect.delayMs);
				break;
			}
			case 'start_ab_test_if_enabled': {
				// Cross-machine reach: load the campaign fresh, check isABTest,
				// delegate to the AB test lifecycle. The reducer that emitted
				// this effect already confirmed isABTest on the pre-patch
				// snapshot — we re-check for safety in case of races.
				const campaign = await ctx.db.get(effect.campaignId);
				if (!campaign?.isABTest) break;
				await ctx.runMutation(internal.campaigns.abTestLifecycle.transition, {
					campaignId: effect.campaignId,
					input: { to: 'testing', at: effect.at },
					userId: effect.userId,
				});
				break;
			}
		}
	}
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

async function dispatch(
	ctx: MutationCtx,
	campaign: Doc<'campaigns'>,
	input: CampaignTransitionInput,
	userId: string
): Promise<CampaignTransitionOutcome> {
	const from = (campaign.status ?? 'draft') as CampaignStatus;
	const verdict = CAMPAIGN_LIFECYCLE.classify(from, input.to);

	if (verdict.kind === 'refused') {
		return refuse(verdict);
	}

	const result = reduce(campaign, input, userId);

	if (Object.keys(result.patch).length > 0) {
		await ctx.db.patch(campaign._id, result.patch as Partial<Doc<'campaigns'>>);
		await recordListingCounter(ctx, 'campaignStatus', campaign, { ...campaign, ...result.patch });
	}
	await applyEffects(ctx, result.effects);

	return {
		ok: true,
		applied: result.applied,
		from,
		to: input.to,
		campaignId: campaign._id,
	};
}

// ─── Public mutations ───────────────────────────────────────────────────────

/**
 * Apply a Campaign-status transition. The only writer of
 * `campaigns.status` and its companion fields. Atomic with: row patch,
 * audit-log row, scheduler hop (for → scheduled / → sending), PostHog
 * track-event (for user-driven transitions), and cross-machine AB test
 * lifecycle kickoff (for → sending on AB-test campaigns).
 *
 * `userId` is the caller identity:
 *   - User-facing mutations pass `session.userId`.
 *   - Internal callers (orchestrator, content scan, scheduler tick) pass
 *     a `'system:<source>'` tag — recorded in the audit log, suppresses
 *     the `track_event` effect.
 *
 * Duplicate (`from === to`) returns `applied: 'recorded'` with an
 * audit-log row but no patch or scheduler hop. Illegal transitions
 * return `{ ok: false, reason: 'illegal_edge' | 'terminal' }` — never
 * thrown. Callers translate the outcome to the appropriate user response.
 */
export const transition = internalMutation({
	args: {
		campaignId: v.id('campaigns'),
		input: transitionInputValidator,
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<CampaignTransitionOutcome> =>
		await transitionCampaign(ctx, args.campaignId, args.input, args.userId),
});

/**
 * `transition` inside the caller's own transaction, for a mutation that
 * commits a status change together with the rows it belongs to (the send
 * preparation commit). Same guards, patch and effects as the mutation.
 */
export async function transitionCampaign(
	ctx: MutationCtx,
	campaignId: Id<'campaigns'>,
	input: CampaignTransitionInput,
	userId: string
): Promise<CampaignTransitionOutcome> {
	// A campaign in Recently deleted keeps its status (a scheduled one was
	// unscheduled on the way in), so nothing can send it until it is restored.
	const campaign = await getLive(ctx, campaignId);
	if (!campaign) return { ok: false, reason: 'campaign_not_found' };
	return await dispatch(ctx, campaign, input, userId);
}

// ─── Batch-completion (sending → sent) ──────────────────────────────────────
//
// The per-send workpool callback (delivery/sendCompletion.ts) advances each
// individual Send and bumps campaign stats, but nothing advanced the CAMPAIGN
// itself — so every campaign with ≥1 recipient was stuck in 'sending' forever
// (KPI undercount, "Sending" spinner that never stops, public archive — gated
// on 'sent' — never reachable). This closes that gap: when a campaign's last
// queued send leaves the queue, the campaign transitions to 'sent'.

const LIFECYCLE_USER_SEND_COMPLETION = 'system:send_completion';

/**
 * Complete a campaign if (and only if) it is genuinely done sending. Shared by
 * the per-send callback and the safety-net cron. Guards, in order:
 *   - must currently be 'sending' (idempotent — re-runs after 'sent' no-op);
 *   - an A/B test must have sent its winner phase (`winner_selected`) — the
 *     test phase enqueues a second wave later, so completing on the first wave
 *     would flip the campaign to 'sent' prematurely;
 *   - the checkpointed send walker must be done streaming (no
 *     `campaignSendJobs` row still `'resolving'`) — the walker enqueues the
 *     audience page-by-page, so completing while it is mid-walk would flip the
 *     campaign to 'sent' after only the first page's sends cleared, dropping
 *     every not-yet-enqueued recipient from the campaign's lifetime;
 *   - at least one emailSends row must exist (else the orchestrator hasn't
 *     inserted the sends yet — don't complete an empty in-flight campaign);
 *   - NO emailSends may remain 'queued' (the sole non-terminal send status).
 */
async function tryCompleteCampaign(ctx: MutationCtx, campaign: Doc<'campaigns'>): Promise<boolean> {
	if (campaign.status !== 'sending') return false;
	if (campaign.isABTest && campaign.abTestStatus !== 'winner_selected') return false;

	// Checkpointed-walker guard: a `'resolving'` job means the non-A/B send is
	// still streaming pages of the audience into emailSends. One indexed
	// point-read; the walker flips the job to `'done'` when it has enqueued the
	// last page, after which the next reconcile completes the campaign.
	const resolvingJob = await ctx.db
		.query('campaignSendJobs')
		.withIndex('by_campaign', (q) => q.eq('campaignId', campaign._id))
		.first();
	if (resolvingJob && resolvingJob.phase === 'resolving') return false;

	const anySend = await ctx.db
		.query('emailSends')
		.withIndex('by_campaign', (q) => q.eq('campaignId', campaign._id))
		.first();
	if (!anySend) return false;

	const stillQueued = await ctx.db
		.query('emailSends')
		.withIndex('by_campaign_and_status', (q) =>
			q.eq('campaignId', campaign._id).eq('status', 'queued')
		)
		.first();
	if (stillQueued) return false;

	const outcome = await dispatch(
		ctx,
		campaign,
		{ to: 'sent', at: Date.now() },
		LIFECYCLE_USER_SEND_COMPLETION
	);
	return outcome.ok === true;
}

/**
 * Per-send entry point — called from the workpool completion callback after a
 * campaign send reaches its terminal status. Cheap no-op when the campaign is
 * not yet done.
 */
export const reconcileCampaignCompletion = internalMutation({
	args: { campaignId: v.id('campaigns') },
	returns: v.boolean(),
	handler: async (ctx, args): Promise<boolean> => {
		const campaign = await ctx.db.get(args.campaignId);
		if (!campaign) return false;
		return await tryCompleteCampaign(ctx, campaign);
	},
});

/**
 * Safety-net sweep (cron) — reconcile every campaign still in 'sending'. Catches
 * campaigns the per-send callback missed (a callback that errored, or whose
 * final Send was transitioned by a provider webhook rather than the workpool).
 */
export const reconcileSendingCampaigns = internalMutation({
	args: {},
	returns: v.object({ checked: v.number(), completed: v.number() }),
	handler: async (ctx): Promise<{ checked: number; completed: number }> => {
		const sending = await ctx.db
			.query('campaigns')
			.withIndex('by_status', (q) => q.eq('status', 'sending'))
			.collect(); // bounded: in-flight campaigns only
		let completed = 0;
		for (const campaign of sending) {
			// Roll the sharded send counters into campaigns.stats* each minute while
			// the campaign is in flight (the read cache; `sent` campaigns are kept
			// fresh by rollupSentCampaignStats).
			await rollupCampaignStatsRow(ctx, campaign);
			if (await tryCompleteCampaign(ctx, campaign)) completed++;
		}
		return { checked: sending.length, completed };
	},
});
