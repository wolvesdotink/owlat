/**
 * Campaign lifecycle — the pure half.
 *
 * Everything here decides; nothing here writes. The status and transition
 * types, the transition validator, the legal-edges graph, the effect union
 * and the reducer that turns a transition into `{ patch, effects, applied }`.
 * `lifecycle.ts` owns the only code that applies that result to the database
 * (`dispatch`) and runs the effects.
 *
 * Kept free of `ctx` so the reducer reads without a database and the status
 * machine reads in one place.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { AuditAction } from '../lib/auditLog';
import { defineLifecycle } from '../lib/lifecycle';
import {
	sendTimeOptimizationValidator,
	type SendTimeOptimizationSettings,
} from '../lib/validators/sendTime';
import type { MarketingNoticeEvent } from '../lib/validators/marketingNotifications';
import { CAMPAIGN_FINISHED_SETTLE_MS, campaignReminderDelayMs } from '../marketing/noticeEvents';

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
			sendTimeOptimization?: SendTimeOptimizationSettings;
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

// ─── Validators ─────────────────────────────────────────────────────────────

export const transitionInputValidator = v.union(
	v.object({
		to: v.literal('scheduled'),
		at: v.number(),
		scheduledAt: v.number(),
		useRecipientTimezone: v.optional(v.boolean()),
		scheduledHour: v.optional(v.number()),
		scheduledMinute: v.optional(v.number()),
		sendTimeOptimization: v.optional(sendTimeOptimizationValidator),
	}),
	v.object({
		to: v.literal('draft'),
		at: v.number(),
		contentBlockReason: v.optional(v.string()),
	}),
	v.object({ to: v.literal('cancelled'), at: v.number() }),
	v.object({ to: v.literal('sending'), at: v.number() }),
	v.object({ to: v.literal('sent'), at: v.number() }),
	v.object({ to: v.literal('pending_review'), at: v.number() })
);

// ─── Legal-edges graph ──────────────────────────────────────────────────────
//
// Mirrors CONTEXT.md "Campaign status" exactly. Declares, per current status,
// the legal next statuses. Self-loops are handled by the reducer as
// `recorded` (idempotent same-state attempts log an audit row but write
// no patch and emit no scheduler hops).
//
// The graph and the dispatcher preamble that reads it live in the generic
// lifecycle core (`lib/lifecycle.ts`); the reducer below stays with the
// campaign, and `lifecycle.ts` runs its effects. `sent` and `cancelled` are
// terminal and this machine publishes the distinct `terminal` refusal, so
// `reportsTerminalRefusals` is on.

export const CAMPAIGN_LIFECYCLE = defineLifecycle<CampaignStatus>(
	{
		draft: ['scheduled', 'sending'],
		scheduled: ['draft', 'cancelled', 'sending'],
		sending: ['sent', 'draft', 'pending_review'],
		sent: [],
		cancelled: [],
		pending_review: ['sending', 'draft'],
	},
	{ reportsTerminalRefusals: true }
);

// ─── Effects ────────────────────────────────────────────────────────────────

type TrackEventName = 'campaign_scheduled' | 'campaign_sent' | 'campaign_cancelled';

export type Effect =
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
			// Marketing notifications: "finished" a few minutes after → sent, and
			// the "sends in 15 min" reminder on → scheduled.
			kind: 'notify_marketing';
			event: MarketingNoticeEvent;
			delayMs: number;
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

export function reduce(
	campaign: Doc<'campaigns'>,
	input: CampaignTransitionInput,
	userId: string
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
		const reminderDelayMs = campaignReminderDelayMs(input.scheduledAt, input.at);
		if (reminderDelayMs !== null) {
			effects.push({
				kind: 'notify_marketing',
				event: {
					kind: 'campaign_reminder',
					campaignId: campaign._id,
					scheduledAt: input.scheduledAt,
				},
				delayMs: reminderDelayMs,
			});
		}
	} else if (input.to === 'sent') {
		effects.push({
			kind: 'notify_marketing',
			event: { kind: 'campaign_finished', campaignId: campaign._id },
			delayMs: CAMPAIGN_FINISHED_SETTLE_MS,
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
			userId: isSystemUserId(userId) ? userId : `system:campaign_lifecycle`,
			at: input.at,
		});
	}

	return { patch, effects, applied: 'transitioned' };
}

function isSystemUserId(userId: string): boolean {
	return userId.startsWith('system:') || userId === 'system';
}

function auditActionFor(to: CampaignStatus, from: CampaignStatus): AuditAction {
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
	from: CampaignStatus
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
	from: CampaignStatus
): Record<string, unknown> {
	const updatedAt = input.at;
	switch (input.to) {
		case 'scheduled':
			return {
				status: 'scheduled',
				scheduledAt: input.scheduledAt,
				useRecipientTimezone: input.useRecipientTimezone ?? false,
				...(input.scheduledHour !== undefined ? { scheduledHour: input.scheduledHour } : {}),
				...(input.scheduledMinute !== undefined ? { scheduledMinute: input.scheduledMinute } : {}),
				// Written every time, like `useRecipientTimezone`, so scheduling
				// without it clears a choice left over from an earlier schedule.
				sendTimeOptimization: input.sendTimeOptimization,
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
				statsAutomatedOpened: 0,
				isAutomatedOpenFiltered: true,
				statsClicked: 0,
				statsAutomatedClicked: 0,
				isAutomatedClickFiltered: true,
				statsBounced: 0,
				statsHardBounced: 0,
				statsSoftBounced: 0,
				statsSendTimeOptimizedDelivered: 0,
				statsSendTimeOptimizedOpened: 0,
				statsSendTimeOptimizedClicked: 0,
				statsSendTimeHoldoutDelivered: 0,
				statsSendTimeHoldoutOpened: 0,
				statsSendTimeHoldoutClicked: 0,
				statsUnsubscribed: 0,
				// Clear any prior block reason on re-send.
				...(campaign.contentBlockReason ? { contentBlockReason: undefined } : {}),
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
