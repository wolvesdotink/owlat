/**
 * Automation lifecycle (module) — single writer of `automations.status` and
 * its companion fields (`activatedAt`, `pausedAt`, `updatedAt`).
 *
 * Three states: `draft | active | paused`. Four legal edges:
 *   draft   → active            (activate; validates trigger config + ≥1 step)
 *   active  → paused            (pause; in-flight automationRuns continue)
 *   paused  → active            (resume; re-validates trigger config + ≥1 step)
 *   paused  → draft             (revertToDraft)
 *
 * `active → draft` is refused as `illegal_edge` — admins must pause first.
 * Duplicate same-state attempts return `{ ok: true, applied: 'recorded' }`.
 *
 * Effects:
 *   audit_log    — fires on every transition (and on idempotent self-loops).
 *   track_event  — fires on every real transition (NOT on self-loops).
 *
 * Stats counters (`statsEntered`, `statsActive`, `statsCompleted`) are
 * lifetime; the reducer does not touch them on any edge. Stats writes stay
 * in the Trigger fanout (`triggers.ts`) and `stepExecutorQueries.ts`.
 *
 * See docs/adr/0024-automation-lifecycle-module.md.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditLog, type AuditAction } from '../lib/auditLog';
import { logWarn } from '../lib/runtimeLog';

// ─── Types ──────────────────────────────────────────────────────────────────

export type AutomationStatus = 'draft' | 'active' | 'paused';

export type AutomationTransitionInput =
	| { to: 'active'; at: number }
	| { to: 'paused'; at: number }
	| { to: 'draft'; at: number };

export type AutomationTransitionOutcome =
	| {
			ok: true;
			applied: 'transitioned' | 'recorded';
			from: AutomationStatus;
			to: AutomationStatus;
			automationId: Id<'automations'>;
	  }
	| {
			ok: false;
			reason:
				| 'automation_not_found'
				| 'illegal_edge'
				| 'no_steps'
				| 'invalid_trigger_config';
			from?: AutomationStatus;
			to?: AutomationStatus;
	  };

// ─── Validators ─────────────────────────────────────────────────────────────

const transitionInputValidator = v.union(
	v.object({ to: v.literal('active'), at: v.number() }),
	v.object({ to: v.literal('paused'), at: v.number() }),
	v.object({ to: v.literal('draft'), at: v.number() }),
);

// ─── Legal-edges graph ──────────────────────────────────────────────────────

export const LEGAL_EDGES: Record<AutomationStatus, ReadonlySet<AutomationStatus>> = {
	draft: new Set<AutomationStatus>(['active']),
	active: new Set<AutomationStatus>(['paused']),
	paused: new Set<AutomationStatus>(['active', 'draft']),
};

// ─── Effects ────────────────────────────────────────────────────────────────

type TrackEventName =
	| 'automation_activated'
	| 'automation_paused'
	| 'automation_resumed'
	| 'automation_reverted_to_draft';

type Effect =
	| {
			kind: 'audit_log';
			action: AuditAction;
			automationId: Id<'automations'>;
			userId: string;
			details: Record<string, string | number | boolean | null>;
	  }
	| {
			kind: 'track_event';
			event: TrackEventName;
			automationId: Id<'automations'>;
			userId: string;
	  };

type ReducerResult = {
	patch: Record<string, unknown>;
	effects: Effect[];
	applied: 'transitioned' | 'recorded';
};

// ─── Reducer ────────────────────────────────────────────────────────────────

export function reduce(
	automation: Doc<'automations'>,
	input: AutomationTransitionInput,
	userId: string,
): ReducerResult {
	const from = automation.status as AutomationStatus;
	const action = auditActionFor(input.to, from);

	if (from === input.to) {
		return {
			patch: {},
			effects: [
				{
					kind: 'audit_log',
					action,
					automationId: automation._id,
					userId,
					details: {
						previousStatus: from,
						newStatus: input.to,
						applied: 'recorded',
						no_op: true,
					},
				},
			],
			applied: 'recorded',
		};
	}

	const patch = buildPatch(input, from);
	const effects: Effect[] = [
		{
			kind: 'audit_log',
			action,
			automationId: automation._id,
			userId,
			details: {
				previousStatus: from,
				newStatus: input.to,
				applied: 'transitioned',
			},
		},
		{
			kind: 'track_event',
			event: trackEventFor(input.to, from),
			automationId: automation._id,
			userId,
		},
	];

	return { patch, effects, applied: 'transitioned' };
}

function auditActionFor(
	to: AutomationStatus,
	from: AutomationStatus,
): AuditAction {
	switch (to) {
		case 'active':
			// draft → active and paused → active both map to dedicated actions.
			return from === 'paused' ? 'automation.resumed' : 'automation.activated';
		case 'paused':
			return 'automation.paused';
		case 'draft':
			return 'automation.reverted_to_draft';
	}
}

function trackEventFor(
	to: AutomationStatus,
	from: AutomationStatus,
): TrackEventName {
	switch (to) {
		case 'active':
			return from === 'paused' ? 'automation_resumed' : 'automation_activated';
		case 'paused':
			return 'automation_paused';
		case 'draft':
			return 'automation_reverted_to_draft';
	}
}

function buildPatch(
	input: AutomationTransitionInput,
	from: AutomationStatus,
): Record<string, unknown> {
	const updatedAt = input.at;
	switch (input.to) {
		case 'active': {
			const patch: Record<string, unknown> = {
				status: 'active',
				pausedAt: undefined,
				updatedAt,
				// Clear the failure-breaker counter on (re)activation. Otherwise a
				// breaker-paused automation resumes still at the threshold, so the
				// very next failure trips it again immediately.
				consecutiveRunFailures: 0,
			};
			// Preserve first-activate timestamp on `paused → active` (resume);
			// only set `activatedAt` on the initial `draft → active`.
			if (from === 'draft') {
				patch['activatedAt'] = updatedAt;
			}
			return patch;
		}
		case 'paused':
			return {
				status: 'paused',
				pausedAt: updatedAt,
				updatedAt,
			};
		case 'draft':
			return {
				status: 'draft',
				activatedAt: undefined,
				pausedAt: undefined,
				updatedAt,
			};
	}
}

// ─── Preconditions ──────────────────────────────────────────────────────────

/**
 * Validate trigger config for the given trigger type. Returns `null` if the
 * config is valid; otherwise the typed `invalid_trigger_config` reason.
 *
 * Mirrors the three open-coded checks previously at
 * `automations.ts:360-368` — runs on `draft → active` AND `paused → active`,
 * closing the resume-skips-validation drift.
 */
export function validateTriggerConfig(
	automation: Doc<'automations'>,
): 'invalid_trigger_config' | null {
	if (automation.triggerType === 'contact_updated' && !automation.triggerConfig) {
		return 'invalid_trigger_config';
	}
	if (automation.triggerType === 'event_received' && !automation.triggerConfig) {
		return 'invalid_trigger_config';
	}
	if (automation.triggerType === 'topic_subscribed' && !automation.triggerConfig) {
		return 'invalid_trigger_config';
	}
	return null;
}

// ─── Effect runner ──────────────────────────────────────────────────────────

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
					resource: 'automation',
					resourceId: effect.automationId,
					details: effect.details,
				});
				break;
			}
			case 'track_event': {
				await ctx.scheduler.runAfter(0, internal.lib.posthog.capture, {
					distinctId: effect.userId,
					event: effect.event,
					properties: { automationId: String(effect.automationId) },
				});
				break;
			}
		}
	}
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

async function dispatch(
	ctx: MutationCtx,
	automation: Doc<'automations'>,
	input: AutomationTransitionInput,
	userId: string,
): Promise<AutomationTransitionOutcome> {
	const from = automation.status as AutomationStatus;
	const isLegal = LEGAL_EDGES[from].has(input.to);
	const isSelfLoop = from === input.to;

	if (!isLegal && !isSelfLoop) {
		return { ok: false, reason: 'illegal_edge', from, to: input.to };
	}

	// Preconditions for `→ active` (both `draft → active` and
	// `paused → active`). Skipped on self-loops (already `active`).
	if (input.to === 'active' && !isSelfLoop) {
		const stepCount = await ctx.db
			.query('automationSteps')
			.withIndex('by_automation', (q) => q.eq('automationId', automation._id))
			.collect()
			.then((steps) => steps.length);
		if (stepCount === 0) {
			return { ok: false, reason: 'no_steps', from, to: input.to };
		}
		const triggerCheck = validateTriggerConfig(automation);
		if (triggerCheck) {
			return { ok: false, reason: triggerCheck, from, to: input.to };
		}
	}

	const result = reduce(automation, input, userId);

	if (Object.keys(result.patch).length > 0) {
		await ctx.db.patch(
			automation._id,
			result.patch as Partial<Doc<'automations'>>,
		);
	}
	await applyEffects(ctx, result.effects);

	return {
		ok: true,
		applied: result.applied,
		from,
		to: input.to,
		automationId: automation._id,
	};
}

// ─── Public entry points ────────────────────────────────────────────────────

/**
 * Apply an automation-status transition. The only writer of
 * `automations.status` and its companion fields. Atomic with: row patch +
 * audit-log row + PostHog `track_event` (skipped on idempotent self-loops).
 *
 * Duplicate (`from === to`) returns `applied: 'recorded'` with an audit-log
 * row but no patch or track_event. Illegal transitions return
 * `{ ok: false, reason: 'illegal_edge' }` — never thrown.
 *
 * `→ active` preconditions:
 *   - `automationSteps` count > 0 → otherwise `reason: 'no_steps'`
 *   - Trigger config valid for trigger type → otherwise
 *     `reason: 'invalid_trigger_config'`
 *
 * Callers translate `reason` to user-facing error strings (see
 * `automations/automations.ts` for the shell mapping).
 */
export const transition = internalMutation({
	args: {
		automationId: v.id('automations'),
		input: transitionInputValidator,
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<AutomationTransitionOutcome> => {
		const automation = await ctx.db.get(args.automationId);
		if (!automation) return { ok: false, reason: 'automation_not_found' };
		return await dispatch(ctx, automation, args.input, args.userId);
	},
});

// ─── Circuit breaker ─────────────────────────────────────────────────────────

/**
 * Consecutive run failures (all retries exhausted) before an active automation
 * auto-pauses. Without this, a systematically-broken step — a deleted email
 * template, a down SMTP route — re-fails for every contact that enters, forever.
 */
export const AUTOMATION_FAILURE_BREAKER_THRESHOLD = 5;

/** Synthetic audit-log actor recorded when the breaker pauses an automation. */
const BREAKER_ACTOR = 'system:automation-breaker';

/**
 * Record one automation run that failed all its retries. Increments the
 * consecutive-failure counter and, at the threshold, trips the breaker by
 * pausing the automation through the lifecycle (so the pause is audit-logged,
 * attributed to BREAKER_ACTOR). The counter resets on any completed run
 * (`stepExecutorQueries.completeAutomationRun`).
 */
export const recordRunFailure = internalMutation({
	args: {
		automationId: v.id('automations'),
	},
	handler: async (ctx, args) => {
		const automation = await ctx.db.get(args.automationId);
		if (!automation) return;
		const failures = (automation.consecutiveRunFailures ?? 0) + 1;
		await ctx.db.patch(args.automationId, { consecutiveRunFailures: failures });
		if (failures >= AUTOMATION_FAILURE_BREAKER_THRESHOLD && automation.status === 'active') {
			logWarn('[automation breaker] pausing automation after consecutive run failures', {
				automationId: String(args.automationId),
				consecutiveRunFailures: failures,
			});
			// `automation.status` is still 'active' (the counter patch above doesn't
			// touch it), so dispatch sees the correct from-state.
			await dispatch(ctx, automation, { to: 'paused', at: Date.now() }, BREAKER_ACTOR);
		}
	},
});
