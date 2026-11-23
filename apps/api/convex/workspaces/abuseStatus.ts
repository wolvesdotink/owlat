/**
 * Abuse status (module) — single writer of `instanceSettings.abuseStatus`
 * and its companion fields (`abuseStatusReason`, `abuseStatusChangedAt`,
 * `abuseStatusChangedBy`). Sibling of **Abuse gate (module)** (which owns
 * the read predicates).
 *
 * Two entry points:
 *   - transition({input})       — internal-writer path, enforces severity
 *                                 rules (no lateral moves, no demotes except
 *                                 to `clean`, no escape from `banned`).
 *   - adminOverride({input})    — admin-only path, bypasses severity rules.
 *
 * Audit-log effect fires on every transition (closes drift bug where
 * internal escalations wrote `abuseStatus` without an audit-log row).
 *
 * The status also records the reputation check's trigger while the check set
 * it (`abuseStatusTrigger`), which is what lets the check lift its own
 * suspension (`analytics/reputationResume.ts`), and the hold a platform
 * admin's lift puts on the check (`reputationCheckHold`). Sending stopping or
 * resuming notifies owners and admins.
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import type { Doc } from '../_generated/dataModel';
import { recordAuditLog } from '../lib/auditLog';
import { reputationTriggerValidator } from '../lib/validators/abuseStatus';
import { scheduleMarketingNotice } from '../marketing/noticeEvents';
import {
	suspendingTriggers,
	type ReputationCheckHold,
	type ReputationTrigger,
} from '../analytics/reputationEnforcement';
import { MANUAL_LIFT_HOLD_MS } from '../analytics/reputationResume';
import { readEnforcementEvidence } from '../analytics/reputationEvidence';

// ─── Types ──────────────────────────────────────────────────────────────────

export type AbuseStatus = 'clean' | 'warned' | 'suspended' | 'banned';

export const STATUS_SEVERITY: Record<AbuseStatus, number> = {
	clean: 0,
	warned: 1,
	suspended: 2,
	banned: 3,
};

export type TransitionInput = {
	to: AbuseStatus;
	at: number;
	reason: string;
	changedBy: string;
	/** The reputation check's trigger; stored only on `warned` / `suspended`. */
	trigger?: ReputationTrigger;
};

export type TransitionOutcome =
	| {
			ok: true;
			applied: 'transitioned' | 'recorded';
			from: AbuseStatus;
			to: AbuseStatus;
			/** A platform admin's lift: what the check will not suspend on, and until when. */
			hold?: ReputationCheckHold;
	  }
	| {
			ok: false;
			reason: 'no_settings_row' | 'illegal_edge' | 'terminal' | 'severity_downgrade';
			from?: AbuseStatus;
			to?: AbuseStatus;
	  };

/** Matches the MTA's 35-day campaign alert identity horizon. */
export const CAMPAIGN_ALERT_RECEIPT_RETENTION_MS = 35 * 24 * 60 * 60 * 1000;

/**
 * `skipped` is a durably recorded alert whose severity rules refused the
 * status change (already `suspended`/`banned`). It is a success: the alert is
 * audited and receipted, so the producer must not retry it. Only
 * `no_settings_row` (transient early-deployment state) and `event_id_conflict`
 * (an identity reused with different content) are failures.
 */
type CampaignAlertOutcome =
	| {
			ok: true;
			applied: 'transitioned' | 'recorded' | 'duplicate' | 'skipped';
	  }
	| {
			ok: false;
			reason: 'no_settings_row' | 'event_id_conflict';
	  };

// ─── Validators ─────────────────────────────────────────────────────────────

export const abuseStatusValidator = v.union(
	v.literal('clean'),
	v.literal('warned'),
	v.literal('suspended'),
	v.literal('banned')
);

const transitionInputValidator = v.object({
	to: abuseStatusValidator,
	at: v.number(),
	reason: v.string(),
	changedBy: v.string(),
	trigger: v.optional(reputationTriggerValidator),
});

// ─── Reducer ────────────────────────────────────────────────────────────────

type ReducerResult = {
	patch: Record<string, unknown>;
	applied: 'transitioned' | 'recorded';
};

/** Whether sending is allowed under a status (the **Abuse gate (module)**'s rule). */
function isSendingAllowed(status: AbuseStatus): boolean {
	return status !== 'suspended' && status !== 'banned';
}

function sameTrigger(a: ReputationTrigger | undefined, b: ReputationTrigger | undefined): boolean {
	return a?.code === b?.code && a?.domain === b?.domain;
}

function reduce(
	settings: Doc<'instanceSettings'>,
	input: TransitionInput,
	options: { adminOverride: boolean; hold: ReputationCheckHold | null | undefined }
): ReducerResult {
	const from = (settings.abuseStatus ?? 'clean') as AbuseStatus;
	const trigger = input.to === 'warned' || input.to === 'suspended' ? input.trigger : undefined;

	if (from === input.to) {
		// Same-state recorded — observability captures the attempt. A platform
		// admin who sets the status the check already set takes it over: the
		// trigger goes, so the check no longer lifts what the admin decided.
		if (options.adminOverride) {
			return {
				patch: {
					abuseStatusReason: input.reason,
					abuseStatusChangedBy: input.changedBy,
					abuseStatusTrigger: undefined,
				},
				applied: 'recorded',
			};
		}
		// A status the check set follows the check onto another trigger (the
		// check hands off only once the stored one has cleared). One without a
		// trigger (a platform admin's) never gains one.
		const isRetriggered =
			settings.abuseStatusTrigger !== undefined &&
			trigger !== undefined &&
			!sameTrigger(settings.abuseStatusTrigger, trigger);
		return {
			patch: isRetriggered ? { abuseStatusTrigger: trigger, abuseStatusReason: input.reason } : {},
			applied: 'recorded',
		};
	}

	return {
		patch: {
			abuseStatus: input.to,
			abuseStatusReason: input.reason,
			abuseStatusChangedAt: input.at,
			abuseStatusChangedBy: input.changedBy,
			abuseStatusTrigger: trigger,
			// Every lift replaces the hold (`null` clears it); otherwise it ends at
			// its deadline. A warning or a suspension on another metric leaves it,
			// or the held evidence would suspend again once that one clears.
			...(options.hold !== undefined ? { reputationCheckHold: options.hold ?? undefined } : {}),
		},
		applied: 'transitioned',
	};
}

/**
 * The hold a platform admin's lift puts on the reputation check: every
 * trigger over the suspension line right now stays paused for
 * `MANUAL_LIFT_HOLD_MS`, so the next hourly run does not suspend again on the
 * evidence the admin just reviewed. Evidence that crosses the line on another
 * trigger still suspends, and so does this evidence if it is still over the
 * line when the hold ends. A lift with nothing over the line returns `null`,
 * which ends an earlier lift's hold.
 */
async function liftHold(
	ctx: MutationCtx,
	from: AbuseStatus,
	input: TransitionInput
): Promise<ReputationCheckHold | null | undefined> {
	if (isSendingAllowed(from) || !isSendingAllowed(input.to)) return undefined;
	const triggers = suspendingTriggers(await readEnforcementEvidence(ctx.db, input.at));
	return triggers.length > 0 ? { until: input.at + MANUAL_LIFT_HOLD_MS, triggers } : null;
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

async function dispatch(
	ctx: MutationCtx,
	settings: Doc<'instanceSettings'>,
	input: TransitionInput,
	options: { adminOverride: boolean; eventId?: string; isRecheck?: boolean }
): Promise<TransitionOutcome> {
	const from = (settings.abuseStatus ?? 'clean') as AbuseStatus;

	if (!options.adminOverride) {
		// Severity rules:
		//   - `banned` is terminal for internal writers (only adminOverride escapes).
		//   - Downgrades are refused EXCEPT down to `clean` (the auto-recover path).
		if (from === 'banned') {
			return { ok: false, reason: 'terminal', from, to: input.to };
		}
		const fromSeverity = STATUS_SEVERITY[from];
		const toSeverity = STATUS_SEVERITY[input.to];
		if (toSeverity < fromSeverity && input.to !== 'clean') {
			return { ok: false, reason: 'severity_downgrade', from, to: input.to };
		}
	}

	const hold = options.adminOverride ? await liftHold(ctx, from, input) : undefined;
	const result = reduce(settings, input, { adminOverride: options.adminOverride, hold });

	if (Object.keys(result.patch).length > 0) {
		await ctx.db.patch(settings._id, result.patch as Partial<Doc<'instanceSettings'>>);
	}
	if (result.applied === 'transitioned' && isSendingAllowed(from) !== isSendingAllowed(input.to)) {
		await scheduleMarketingNotice(ctx, {
			kind: isSendingAllowed(input.to) ? 'sending_resumed' : 'sending_suspended',
			changedAt: input.at,
		});
	}

	// Audit log fires on every transition (including `recorded` no-ops) —
	// observability captures every attempt, even same-state ones
	// (e.g., "circuit breaker tripped again while already warned"). The hourly
	// reputation check is the exception: it re-reads the same 30-day evidence
	// every hour, so a same-state call that changes nothing is no new event and
	// would bury the real ones under a row an hour.
	const isUnchanged = result.applied === 'recorded' && Object.keys(result.patch).length === 0;
	if (options.isRecheck && isUnchanged) {
		return { ok: true, applied: result.applied, from, to: input.to };
	}
	await recordAuditLog(ctx, {
		userId: input.changedBy,
		action: 'abuse_status_changed',
		resource: 'instance_settings',
		resourceId: settings._id,
		details: {
			previousStatus: from,
			newStatus: input.to,
			reason: input.reason,
			applied: result.applied,
			adminOverride: options.adminOverride ? 'true' : 'false',
			...(options.eventId ? { eventId: options.eventId } : {}),
			...(input.trigger ? { trigger: input.trigger.code } : {}),
			...(input.trigger?.domain ? { triggerDomain: input.trigger.domain } : {}),
			...(hold ? { holdUntil: hold.until } : {}),
		},
	});

	return {
		ok: true,
		applied: result.applied,
		from,
		to: input.to,
		...(hold ? { hold } : {}),
	};
}

// ─── Public mutations ───────────────────────────────────────────────────────

/**
 * Apply an abuse-status transition with severity rules enforced.
 * Used by internal writers (MTA circuit breaker, reputation auto-enforcement).
 *
 * Severity rules:
 *   - `banned` is terminal — escape only via `adminOverride`.
 *   - Downgrades are refused except to `clean` (auto-recover).
 *   - Same-state is `applied: 'recorded'`, audit-logged but not patched
 *     (unless `isRecheck` and nothing changed: then not audited either).
 *
 * Returns `{ ok: false, reason: 'no_settings_row' }` when the singleton
 * `instanceSettings` row is missing (early-deployment edge case).
 */
export const transition = internalMutation({
	args: {
		input: transitionInputValidator,
		// Set by the hourly reputation check: a call that changes nothing writes no audit row.
		isRecheck: v.optional(v.boolean()),
	},
	handler: async (ctx, args): Promise<TransitionOutcome> => {
		const settings = await ctx.db.query('instanceSettings').first();
		if (!settings) return { ok: false, reason: 'no_settings_row' };
		return await dispatch(ctx, settings, args.input, {
			adminOverride: false,
			isRecheck: args.isRecheck === true,
		});
	},
});

/**
 * Persist one MTA campaign complaint alert exactly once.
 *
 * The receipt, status transition, and audit row share this mutation's Convex
 * transaction. A response-loss replay therefore observes the receipt and
 * returns success without creating a second same-state audit row. A reused
 * event id with different immutable content fails closed.
 */
export const recordCampaignComplaintAlert = internalMutation({
	args: {
		eventId: v.string(),
		campaignId: v.string(),
		message: v.string(),
		complaintRate: v.number(),
		eventTimestamp: v.number(),
	},
	handler: async (ctx, args): Promise<CampaignAlertOutcome> => {
		const existing = await ctx.db
			.query('mtaCampaignAlertReceipts')
			.withIndex('by_event_id', (q) => q.eq('eventId', args.eventId))
			.unique();
		if (existing) {
			const isSameAlert =
				existing.campaignId === args.campaignId &&
				existing.message === args.message &&
				existing.complaintRate === args.complaintRate &&
				existing.eventTimestamp === args.eventTimestamp;
			return isSameAlert
				? { ok: true, applied: 'duplicate' }
				: { ok: false, reason: 'event_id_conflict' };
		}

		const settings = await ctx.db.query('instanceSettings').first();
		if (!settings) return { ok: false, reason: 'no_settings_row' };
		const ratePercent = (args.complaintRate * 100).toFixed(2);
		const reason = `MTA campaign complaint rate: ${args.message} (${ratePercent}%) [campaign ${args.campaignId}]`;
		const outcome = await dispatch(
			ctx,
			settings,
			{
				to: 'warned',
				at: args.eventTimestamp,
				reason,
				changedBy: 'mta_campaign_complaint_rate',
			},
			{ adminOverride: false, eventId: args.eventId }
		);
		// This alert always targets `warned`, so an instance already `suspended`
		// or `banned` refuses it — and reputation auto-enforcement suspends on
		// exactly the complaint rates that raise these alerts. Retrying can never
		// succeed, so audit and receipt the alert and acknowledge the producer
		// instead of turning a correlated safety signal into DLQ toil.
		// `dispatch` is handed the settings row, so its only refusals here are the
		// permanent severity ones.
		if (!outcome.ok) {
			await recordAuditLog(ctx, {
				userId: 'mta_campaign_complaint_rate',
				action: 'abuse_status_changed',
				resource: 'instance_settings',
				resourceId: settings._id,
				details: {
					previousStatus: outcome.from ?? 'clean',
					newStatus: outcome.from ?? 'clean',
					reason,
					applied: 'skipped',
					refusedBecause: outcome.reason,
					adminOverride: 'false',
					eventId: args.eventId,
				},
			});
		}
		const applied = outcome.ok ? outcome.applied : ('skipped' as const);

		const processedAt = Date.now();
		await ctx.db.insert('mtaCampaignAlertReceipts', {
			eventId: args.eventId,
			campaignId: args.campaignId,
			message: args.message,
			complaintRate: args.complaintRate,
			eventTimestamp: args.eventTimestamp,
			processedAt,
			expiresAt: processedAt + CAMPAIGN_ALERT_RECEIPT_RETENTION_MS,
			transitionApplied: applied,
		});
		return { ok: true, applied };
	},
});

/**
 * Apply an abuse-status transition bypassing severity rules. Used by
 * the platform-admin path (auth-gated by `requirePlatformAdmin` at the
 * outer mutation in `platformAdmin/mutations.ts`). The admin can demote
 * a `banned` org back to `clean` for appeal resolution.
 */
export const adminOverride = internalMutation({
	args: { input: transitionInputValidator },
	handler: async (ctx, args): Promise<TransitionOutcome> => {
		const settings = await ctx.db.query('instanceSettings').first();
		if (!settings) return { ok: false, reason: 'no_settings_row' };
		return await dispatch(ctx, settings, args.input, { adminOverride: true });
	},
});
