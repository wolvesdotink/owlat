/**
 * Campaign lifecycle (module) — single writer of `campaigns.status` and
 * its companion fields (`sentAt`, `cancelledAt`, `scheduledAt`,
 * `contentBlockReason`, stats-zero on send). Sibling of the
 * **AB test lifecycle (module)** which owns `campaigns.abTestStatus`.
 *
 * Ten legal edges — see CONTEXT.md "Campaign status" for the full graph.
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
 *
 * `userId` discriminates user-driven vs system-source:
 *   - user mutations pass session.userId.
 *   - internal callers pass 'system:scheduler_tick' / 'system:content_scan' /
 *     'system:admin_review' / etc. Audit log records the value verbatim;
 *     track_event fires only when the userId is NOT prefixed with 'system:'.
 *
 * See docs/adr/0017-campaign-lifecycle-modules.md.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalMutation, type MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditLog, type AuditAction } from '../lib/auditLog';
import { rollupCampaignStatsRow } from './statShards';
import { throwInvalidState } from '../_utils/errors';

// ─── Types ──────────────────────────────────────────────────────────────────

export type CampaignStatus =
	| 'draft'
	| 'scheduled'
	| 'sending'
	| 'sent'
	| 'cancelled'
	| 'pending_review';

export type CampaignTransitionInput =
	| {
			to: 'scheduled';
			at: number;
			scheduledAt: number;
			useRecipientTimezone?: boolean;
			scheduledHour?: number;
			scheduledMinute?: number;
	  }
	| {
			to: 'draft';
			at: number;
			/** Only set on `sending → draft` content-blocked path. */
			contentBlockReason?: string;
	  }
	| { to: 'cancelled'; at: number }
	| { to: 'sending'; at: number }
	| { to: 'sent'; at: number }
	| { to: 'pending_review'; at: number };

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
			reason:
				| 'campaign_not_found'
				| 'illegal_edge'
				| 'terminal';
			from?: CampaignStatus;
			to?: CampaignStatus;
	  };

/**
 * Translate a failed lifecycle transition outcome into the thrown
 * `invalid_state` error each campaign mutation surfaces to the caller. The
 * thin-shell mutations (ADR-0017) keep their own status pre-checks and auth
 * preamble — this only folds the shared `outcome → throw` tail.
 *
 * `verb` is the user-facing action ("send", "cancel", "schedule", …); the
 * message reads `Cannot <verb> campaign: <reason>`.
 */
export function assertTransitioned(
	outcome: CampaignTransitionOutcome,
	verb: string,
): asserts outcome is Extract<CampaignTransitionOutcome, { ok: true }> {
	if (!outcome.ok) {
		throwInvalidState(`Cannot ${verb} campaign: ${outcome.reason}`);
	}
}

// ─── Validators ─────────────────────────────────────────────────────────────

const transitionInputValidator = v.union(
	v.object({
		to: v.literal('scheduled'),
		at: v.number(),
		scheduledAt: v.number(),
		useRecipientTimezone: v.optional(v.boolean()),
		scheduledHour: v.optional(v.number()),
		scheduledMinute: v.optional(v.number()),
	}),
	v.object({
		to: v.literal('draft'),
		at: v.number(),
		contentBlockReason: v.optional(v.string()),
	}),
	v.object({ to: v.literal('cancelled'), at: v.number() }),
	v.object({ to: v.literal('sending'), at: v.number() }),
	v.object({ to: v.literal('sent'), at: v.number() }),
	v.object({ to: v.literal('pending_review'), at: v.number() }),
);

// ─── Legal-edges graph ──────────────────────────────────────────────────────
//
// Mirrors CONTEXT.md "Campaign status" exactly. Maps current status → set
// of legal next statuses. Self-loops are handled by the reducer as
// `recorded` (idempotent same-state attempts log an audit row but write
// no patch and emit no scheduler hops).

const LEGAL_EDGES: Record<CampaignStatus, ReadonlySet<CampaignStatus>> = {
	draft: new Set<CampaignStatus>(['scheduled', 'sending']),
	scheduled: new Set<CampaignStatus>(['draft', 'cancelled', 'sending']),
	sending: new Set<CampaignStatus>(['sent', 'draft', 'pending_review']),
	sent: new Set<CampaignStatus>(),
	cancelled: new Set<CampaignStatus>(),
	pending_review: new Set<CampaignStatus>(['sending', 'draft']),
};

// ─── Effects ────────────────────────────────────────────────────────────────

type TrackEventName =
	| 'campaign_scheduled'
	| 'campaign_sent'
	| 'campaign_cancelled';

type Effect =
	| {
			kind: 'audit_log';
			action: AuditAction;
			campaignId: Id<'campaigns'>;
			userId: string;
			details: Record<string, string | number | boolean | null>;
	  }
	| {
			kind: 'schedule_campaign_send_orchestrator';
			campaignId: Id<'campaigns'>;
			delayMs: number;
	  }
	| {
			kind: 'track_event';
			event: TrackEventName;
			campaignId: Id<'campaigns'>;
			userId: string;
	  }
	| {
			kind: 'start_ab_test_if_enabled';
			campaignId: Id<'campaigns'>;
			/** Sub-tag prefixed with `system:` — the AB test lifecycle records
			 *  this in the `ab_test.testing_started` audit row. */
			userId: string;
			at: number;
	  };

type ReducerResult = {
	patch: Record<string, unknown>;
	effects: Effect[];
	applied: 'transitioned' | 'recorded';
};

// ─── Reducer ────────────────────────────────────────────────────────────────
//
// Pure: takes the loaded campaign, the typed input, and the userId/source
// metadata; returns a ReducerResult. Does not touch the DB or the scheduler.

function reduce(
	campaign: Doc<'campaigns'>,
	input: CampaignTransitionInput,
	userId: string,
): ReducerResult {
	const from = (campaign.status ?? 'draft') as CampaignStatus;

	if (from === input.to) {
		// Idempotent — record the attempt via audit log, no patch / no
		// orchestrator schedule / no track_event / no AB test kickoff.
		return {
			patch: {},
			effects: [
				{
					kind: 'audit_log',
					action: auditActionFor(input.to, from),
					campaignId: campaign._id,
					userId,
					details: {
						previousStatus: from,
						newStatus: input.to,
						applied: 'recorded',
					},
				},
			],
			applied: 'recorded',
		};
	}

	const patch = buildPatch(campaign, input, from);
	const effects: Effect[] = [
		{
			kind: 'audit_log',
			action: auditActionFor(input.to, from),
			campaignId: campaign._id,
			userId,
			details: buildAuditDetails(input, from),
		},
	];

	// Scheduler hop: → scheduled (delayMs = scheduledAt - at) and → sending
	// (delayMs = 0). The Campaign send orchestrator (module)
	// (`emails.startCampaignSend`) is the consumer. `sending → sent` does
	// NOT fire the schedule — by then the orchestrator is already running
	// and calling us back.
	if (input.to === 'scheduled') {
		const delayMs = Math.max(0, input.scheduledAt - input.at);
		effects.push({
			kind: 'schedule_campaign_send_orchestrator',
			campaignId: campaign._id,
			delayMs,
		});
	} else if (input.to === 'sending') {
		effects.push({
			kind: 'schedule_campaign_send_orchestrator',
			campaignId: campaign._id,
			delayMs: 0,
		});
	}

	// User-facing PostHog event. Only fires for user-driven transitions
	// (userId not prefixed with `system:`) AND for the three user-facing
	// transition kinds. The `sending → sent` terminal fires only the
	// `campaign_sent` event from the `→ sending` edge, not from the
	// `→ sent` edge — the user-facing meaning of "campaign sent" is
	// "the send was kicked off."
	if (!isSystemUserId(userId)) {
		if (input.to === 'scheduled') {
			effects.push({
				kind: 'track_event',
				event: 'campaign_scheduled',
				campaignId: campaign._id,
				userId,
			});
		} else if (input.to === 'sending' && from !== 'pending_review') {
			// `pending_review → sending` is admin approval — separate audit
			// surface, no `campaign_sent` PostHog event.
			effects.push({
				kind: 'track_event',
				event: 'campaign_sent',
				campaignId: campaign._id,
				userId,
			});
		} else if (input.to === 'cancelled') {
			effects.push({
				kind: 'track_event',
				event: 'campaign_cancelled',
				campaignId: campaign._id,
				userId,
			});
		}
	}

	// Cross-machine: AB test lifecycle kickoff when the campaign begins
	// sending. Fires on both `draft|scheduled → sending` and the future
	// `pending_review → sending` (admin approve) path — both produce a
	// real send-start.
	if (input.to === 'sending' && campaign.isABTest) {
		effects.push({
			kind: 'start_ab_test_if_enabled',
			campaignId: campaign._id,
			userId: isSystemUserId(userId)
				? userId
				: `system:campaign_lifecycle`,
			at: input.at,
		});
	}

	return { patch, effects, applied: 'transitioned' };
}

function isSystemUserId(userId: string): boolean {
	return userId.startsWith('system:') || userId === 'system';
}

function auditActionFor(
	to: CampaignStatus,
	from: CampaignStatus,
): AuditAction {
	switch (to) {
		case 'scheduled':
			return 'campaign.scheduled';
		case 'draft':
			if (from === 'scheduled') return 'campaign.unscheduled';
			if (from === 'sending') return 'campaign.content_blocked';
			if (from === 'pending_review') return 'campaign.review_rejected';
			// (none) → draft on create is not a lifecycle transition; covered
			// here as a fallback for future paths.
			return 'campaign.updated';
		case 'cancelled':
			return 'campaign.cancelled';
		case 'sending':
			if (from === 'pending_review') return 'campaign.review_approved';
			return 'campaign.send_started';
		case 'sent':
			return 'campaign.sent';
		case 'pending_review':
			return 'campaign.flagged_for_review';
	}
}

function buildAuditDetails(
	input: CampaignTransitionInput,
	from: CampaignStatus,
): Record<string, string | number | boolean | null> {
	const base = {
		previousStatus: from,
		newStatus: input.to,
		applied: 'transitioned' as const,
	};
	if (input.to === 'scheduled') {
		return { ...base, scheduledAt: input.scheduledAt };
	}
	if (input.to === 'draft' && input.contentBlockReason !== undefined) {
		return { ...base, contentBlockReason: input.contentBlockReason };
	}
	return base;
}

function buildPatch(
	campaign: Doc<'campaigns'>,
	input: CampaignTransitionInput,
	from: CampaignStatus,
): Record<string, unknown> {
	const updatedAt = input.at;
	switch (input.to) {
		case 'scheduled':
			return {
				status: 'scheduled',
				scheduledAt: input.scheduledAt,
				useRecipientTimezone: input.useRecipientTimezone ?? false,
				...(input.scheduledHour !== undefined
					? { scheduledHour: input.scheduledHour }
					: {}),
				...(input.scheduledMinute !== undefined
					? { scheduledMinute: input.scheduledMinute }
					: {}),
				updatedAt,
			};
		case 'draft': {
			const patch: Record<string, unknown> = {
				status: 'draft',
				updatedAt,
			};
			if (from === 'scheduled') {
				patch['scheduledAt'] = undefined;
			}
			if (input.contentBlockReason !== undefined) {
				patch['contentBlockReason'] = input.contentBlockReason;
			}
			return patch;
		}
		case 'cancelled':
			return {
				status: 'cancelled',
				cancelledAt: input.at,
				scheduledAt: undefined,
				updatedAt,
			};
		case 'sending':
			return {
				status: 'sending',
				sentAt: input.at,
				scheduledAt: undefined,
				// Stats reset on each send — the Send lifecycle's
				// `campaign_stats_*` effects then bump them per recipient.
				statsSent: 0,
				statsFailed: 0,
				statsDelivered: 0,
				statsOpened: 0,
				statsClicked: 0,
				statsBounced: 0,
				statsHardBounced: 0,
				statsSoftBounced: 0,
				statsUnsubscribed: 0,
				// Clear any prior block reason on re-send.
				...(campaign.contentBlockReason
					? { contentBlockReason: undefined }
					: {}),
				updatedAt,
			};
		case 'sent':
			// Stats bumps live on Send lifecycle's effect list. This
			// transition just records the terminal.
			return { status: 'sent', updatedAt };
		case 'pending_review':
			return { status: 'pending_review', updatedAt };
	}
}

// ─── Runner ─────────────────────────────────────────────────────────────────

async function applyEffects(
	ctx: MutationCtx,
	effects: ReadonlyArray<Effect>,
): Promise<void> {
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
				await ctx.scheduler.runAfter(
					effect.delayMs,
					internal.campaigns.send.startCampaignSend,
					{ campaignId: effect.campaignId },
				);
				break;
			}
			case 'track_event': {
				await ctx.scheduler.runAfter(0, internal.lib.posthog.capture, {
					distinctId: effect.userId,
					event: effect.event,
					properties: { campaignId: String(effect.campaignId) },
				});
				break;
			}
			case 'start_ab_test_if_enabled': {
				// Cross-machine reach: load the campaign fresh, check isABTest,
				// delegate to the AB test lifecycle. The reducer that emitted
				// this effect already confirmed isABTest on the pre-patch
				// snapshot — we re-check for safety in case of races.
				const campaign = await ctx.db.get(effect.campaignId);
				if (!campaign?.isABTest) break;
				await ctx.runMutation(
					internal.campaigns.abTestLifecycle.transition,
					{
						campaignId: effect.campaignId,
						input: { to: 'testing', at: effect.at },
						userId: effect.userId,
					},
				);
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
	userId: string,
): Promise<CampaignTransitionOutcome> {
	const from = (campaign.status ?? 'draft') as CampaignStatus;
	const isLegalEdge = LEGAL_EDGES[from].has(input.to);
	const isSelfLoop = from === input.to;

	if (!isLegalEdge && !isSelfLoop) {
		if (LEGAL_EDGES[from].size === 0) {
			return { ok: false, reason: 'terminal', from, to: input.to };
		}
		return { ok: false, reason: 'illegal_edge', from, to: input.to };
	}

	const result = reduce(campaign, input, userId);

	if (Object.keys(result.patch).length > 0) {
		await ctx.db.patch(campaign._id, result.patch as Partial<Doc<'campaigns'>>);
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
	handler: async (ctx, args): Promise<CampaignTransitionOutcome> => {
		const campaign = await ctx.db.get(args.campaignId);
		if (!campaign) return { ok: false, reason: 'campaign_not_found' };
		return await dispatch(ctx, campaign, args.input, args.userId);
	},
});

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
			q.eq('campaignId', campaign._id).eq('status', 'queued'),
		)
		.first();
	if (stillQueued) return false;

	const outcome = await dispatch(ctx, campaign, { to: 'sent', at: Date.now() }, LIFECYCLE_USER_SEND_COMPLETION);
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
