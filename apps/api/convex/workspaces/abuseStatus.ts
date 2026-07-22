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
 * See docs/adr/0011-abuse-status-modules.md.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { recordAuditLog } from '../lib/auditLog';

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
};

export type TransitionOutcome =
	| {
			ok: true;
			applied: 'transitioned' | 'recorded';
			from: AbuseStatus;
			to: AbuseStatus;
	  }
	| {
			ok: false;
			reason: 'no_settings_row' | 'illegal_edge' | 'terminal' | 'severity_downgrade';
			from?: AbuseStatus;
			to?: AbuseStatus;
	  };

/** Longer than the MTA's 30-day campaign alert identity horizon. */
export const CAMPAIGN_ALERT_RECEIPT_RETENTION_MS = 35 * 24 * 60 * 60 * 1000;

export type CampaignAlertOutcome =
	| {
			ok: true;
			applied: 'transitioned' | 'recorded' | 'duplicate';
	  }
	| {
			ok: false;
			reason:
				| 'no_settings_row'
				| 'illegal_edge'
				| 'terminal'
				| 'severity_downgrade'
				| 'event_id_conflict';
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
});

// ─── Reducer ────────────────────────────────────────────────────────────────

type ReducerResult = {
	patch: Record<string, unknown>;
	applied: 'transitioned' | 'recorded';
};

function reduce(settings: Doc<'instanceSettings'>, input: TransitionInput): ReducerResult {
	const from = (settings.abuseStatus ?? 'clean') as AbuseStatus;

	if (from === input.to) {
		// Same-state recorded — observability captures the attempt.
		return { patch: {}, applied: 'recorded' };
	}

	return {
		patch: {
			abuseStatus: input.to,
			abuseStatusReason: input.reason,
			abuseStatusChangedAt: input.at,
			abuseStatusChangedBy: input.changedBy,
		},
		applied: 'transitioned',
	};
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

async function dispatch(
	ctx: MutationCtx,
	settings: Doc<'instanceSettings'>,
	input: TransitionInput,
	options: { adminOverride: boolean; eventId?: string }
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

	const result = reduce(settings, input);

	if (Object.keys(result.patch).length > 0) {
		await ctx.db.patch(settings._id, result.patch as Partial<Doc<'instanceSettings'>>);
	}

	// Audit log fires on every transition (including `recorded` no-ops) per
	// ADR-0011 — observability captures every attempt, even same-state ones
	// (e.g., "circuit breaker tripped again while already warned").
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
		},
	});

	return {
		ok: true,
		applied: result.applied,
		from,
		to: input.to,
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
 *   - Same-state is `applied: 'recorded'`, audit-logged but not patched.
 *
 * Returns `{ ok: false, reason: 'no_settings_row' }` when the singleton
 * `instanceSettings` row is missing (early-deployment edge case).
 */
export const transition = internalMutation({
	args: { input: transitionInputValidator },
	handler: async (ctx, args): Promise<TransitionOutcome> => {
		const settings = await ctx.db.query('instanceSettings').first();
		if (!settings) return { ok: false, reason: 'no_settings_row' };
		return await dispatch(ctx, settings, args.input, { adminOverride: false });
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
		const outcome = await dispatch(
			ctx,
			settings,
			{
				to: 'warned',
				at: args.eventTimestamp,
				reason: `MTA campaign complaint rate: ${args.message} (${ratePercent}%) [campaign ${args.campaignId}]`,
				changedBy: 'mta_campaign_complaint_rate',
			},
			{ adminOverride: false, eventId: args.eventId }
		);
		if (!outcome.ok) return outcome;

		const processedAt = Date.now();
		await ctx.db.insert('mtaCampaignAlertReceipts', {
			eventId: args.eventId,
			campaignId: args.campaignId,
			message: args.message,
			complaintRate: args.complaintRate,
			eventTimestamp: args.eventTimestamp,
			processedAt,
			expiresAt: processedAt + CAMPAIGN_ALERT_RECEIPT_RETENTION_MS,
			transitionApplied: outcome.applied,
		});
		return { ok: true, applied: outcome.applied };
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
