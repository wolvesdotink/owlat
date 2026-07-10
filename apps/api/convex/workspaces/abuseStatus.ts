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
	options: { adminOverride: boolean }
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
