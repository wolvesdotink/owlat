/**
 * THE RAMP CONTROLLER'S CRON SHELL (plan D13, D15).
 *
 * Convex owns the decision — it has the reputation and the outcome data, and it
 * reads MTA state through the EXISTING `/ip-reputation` sync rather than
 * running a second controller on the MTA side. One owner of the decision, no
 * split brain.
 *
 * This module is deliberately THIN: load inputs, call the pure `nextShare`,
 * write the result and the audit row. Every rule lives in `controller.ts`; a
 * conditional here that changes an outcome is a defect, because it would be a
 * rule with no fixture.
 *
 * BOUNDED PER TICK. The cell grid is stream x destinationProvider (15 cells).
 * Each tick takes a slice, writes it, and self-schedules for the next slice, so
 * one mutation's read and write set stays small however the grid grows.
 *
 * WHY THIS LIVES IN `delivery/` AND NOT IN `delivery/ramp/`: everything under
 * `ramp/` is the PURE decision core, and `ramp/__tests__/gates.purity.test.ts`
 * enumerates that directory and forbids a clock, a database handle or a Convex
 * function wrapper in any file it finds. The shell needs all three. Keeping it
 * outside means the guard stays at full strength and "is delivery/ramp/ pure?"
 * stays a question with a yes/no answer.
 *
 * ABSENCE IS A SUPPORTED CONFIGURATION (plan D2). No organization, no warming
 * state, no reference transport, no seed mailboxes: every one of those makes
 * the controller measure less and move slower. None of them makes it throw,
 * and none of them blocks a send.
 */

import { v } from 'convex/values';
import {
	allDeliverabilityCells,
	deliverabilityCellKey,
	isFallbackActiveForShare,
	resolveOwnShare,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import type { Doc } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { isSendingAllowed } from '../workspaces/abuseGate';
import { loadRouteStateCell } from '../lib/deliverabilityRouteState';
import { summarizeTransportOutcomeArms } from '../analytics/transportOutcomes';
import { recordAuditLog } from '../lib/auditLog';
import { nextPhaseCeiling, RAMP_INITIAL_PHASE_CEILING } from './ramp/controllerConfig';
import { nextShare } from './ramp/controller';
import { RAMP_STREAM_CONFIGS } from './ramp/gateConfig';
import { referenceArmGateEvaluator } from './ramp/gateEvaluation';
import { evaluateEngagementGate } from './ramp/engagementGate';
import { loadRampCapacity } from './rampCapacity';
import { recordMixDecision } from './rampMixDecisions';
import type { RampControllerInput, RampDecision, RampMixState } from './ramp/controllerTypes';

/** Cells evaluated per tick. The grid is 15; three ticks cover it. */
export const RAMP_CELLS_PER_TICK = 5;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** The gate evaluation window: one day of outcomes. */
const RAMP_WINDOW_MS = DAY_MS;
/** Route-state rows are refreshed on every tick; the TTL matches the snapshot's. */
const ROUTE_STATE_TTL_MS = DAY_MS;
/** The engagement floor's recent window and the prior baseline it is compared to. */
const ENGAGEMENT_RECENT_MS = 7 * DAY_MS;
const ENGAGEMENT_BASELINE_MS = 30 * DAY_MS;

/**
 * The deployment's tenant, read off the route-state table. Owlat is
 * single-organization-per-deployment, so any route-state row names it; `null`
 * means routing state has never been written and there is nothing to ramp.
 * The table holds at most a couple of dozen rows, so the unindexed peek is
 * cheaper than a component round-trip and cannot throw.
 */
async function resolveRampOrganizationId(ctx: MutationCtx): Promise<string | null> {
	const row = await ctx.db.query('deliverabilityRouteStates').first();
	return row?.organizationId ?? null;
}

/** Infrastructure verdicts, read off whichever route-state rows exist. */
function readHardStopSignals(
	rows: readonly (Doc<'deliverabilityRouteStates'> | null)[],
	isSendingPermitted: boolean
) {
	let isCircuitBreakerOpen = false;
	let isPoolBlocklisted = false;
	for (const row of rows) {
		for (const signal of row?.signals ?? []) {
			if (signal.source === 'breaker_open') isCircuitBreakerOpen = true;
			if (
				signal.severity === 'critical' &&
				(signal.source === 'dnsbl_listed' || signal.source === 'dnsbl_partial')
			) {
				isPoolBlocklisted = true;
			}
		}
	}
	return { isSendingAllowed: isSendingPermitted, isCircuitBreakerOpen, isPoolBlocklisted };
}

function readMixState(row: Doc<'deliverabilityRouteStates'> | null): RampMixState {
	return {
		share: resolveOwnShare(row),
		phaseCeiling: row?.phaseCeiling,
		cleanStreak: row?.cleanStreak,
		frozenUntil: row?.frozenUntil,
		freezeStartedAt: row?.fallbackActiveSince,
		cooldownMs: row?.cooldownMs,
		greenSince: row?.healthySince,
		graduatedAt: row?.graduatedAt,
	};
}

/**
 * Build the controller input for one cell. Reads only; decides nothing.
 *
 * `null` means the cell is UNMANAGED: no per-stream row carries a share, so the
 * cell is still governed entirely by the shipped boolean + hysteresis on the
 * stream-less row. The controller does not seed a share here — seeding is the
 * transport-connection flow's act, and a controller that invented one would
 * change shipped routing on a deployment that never opted into the ramp (D1:
 * no behaviour change until the controller starts writing shares).
 */
async function loadCellInput(
	ctx: MutationCtx,
	args: {
		organizationId: string;
		cell: DeliverabilityCell;
		isKillSwitchEngaged: boolean;
		isSendingPermitted: boolean;
		now: number;
	}
): Promise<{ input: RampControllerInput; perStream: Doc<'deliverabilityRouteStates'> } | null> {
	const { organizationId, cell, now } = args;
	const cellKey = deliverabilityCellKey(cell);
	const { perStream, streamless } = await loadRouteStateCell(ctx, organizationId, cell);
	if (!perStream || perStream.ownShare === undefined) return null;
	const mix = readMixState(perStream);

	const window = { organizationId, cell: cellKey, since: now - RAMP_WINDOW_MS };
	const { own, reference } = await summarizeTransportOutcomeArms(ctx.db, window);
	const recent = await summarizeTransportOutcomeArms(ctx.db, {
		organizationId,
		cell: cellKey,
		since: now - ENGAGEMENT_RECENT_MS,
	});
	const prior = await summarizeTransportOutcomeArms(ctx.db, {
		organizationId,
		cell: cellKey,
		since: now - ENGAGEMENT_BASELINE_MS,
		until: now - ENGAGEMENT_RECENT_MS,
	});

	// The reference arm is ABSENT, not empty, when nothing was sent through it:
	// an empty summary would read as "the relay engaged 0% of its recipients"
	// and fail a ratio the deployment never opted into (plan D2).
	const referenceArm = reference.sent > 0 ? reference : null;
	const engagement = evaluateEngagementGate({
		cell,
		own,
		reference: referenceArm,
		ownRecent: recent.own,
		ownPriorBaseline: prior.own,
		now,
	});

	const evaluation = referenceArmGateEvaluator.evaluate({
		config: RAMP_STREAM_CONFIGS[cell.stream],
		own,
		reference: referenceArm,
		engagement,
		previousCleanStreak: perStream?.cleanStreak ?? 0,
		now,
	});

	const capacity = await loadRampCapacity(ctx.db, { organizationId, cell: cellKey, now });

	return {
		perStream,
		input: {
			cell,
			config: RAMP_STREAM_CONFIGS[cell.stream],
			mix,
			signals: readHardStopSignals([perStream, streamless], args.isSendingPermitted),
			evaluation,
			capacity,
			isKillSwitchEngaged: args.isKillSwitchEngaged,
			now,
		},
	};
}

/**
 * Persist one decision onto the cell's per-stream route-state row.
 *
 * `mixVersion` advances ONLY when the share actually moves: it salts
 * per-recipient assignment (plan D7), so bumping it on a no-op would reshuffle
 * every recipient's arm for no reason and destroy the comparison in flight.
 */
async function applyDecision(
	ctx: MutationCtx,
	args: {
		perStream: Doc<'deliverabilityRouteStates'>;
		decision: RampDecision;
		now: number;
	}
): Promise<void> {
	const { perStream, decision, now } = args;
	const moved = decision.direction !== 'hold';
	const fields = {
		isFallbackActive: isFallbackActiveForShare(decision.share),
		ownShare: decision.share,
		phaseCeiling: decision.phaseCeiling,
		cleanStreak: decision.cleanStreak,
		mixVersion: (perStream.mixVersion ?? 0) + (moved ? 1 : 0),
		// The freeze clock: START, EXPIRY and LADDER POSITION move together, and a
		// decision that imposed no new freeze leaves all three exactly as they were.
		fallbackActiveSince: decision.frozenUntil === undefined ? perStream.fallbackActiveSince : now,
		frozenUntil: decision.frozenUntil ?? perStream.frozenUntil,
		cooldownMs: decision.cooldownMs ?? perStream.cooldownMs,
		healthySince: decision.greenSince,
		graduatedAt: decision.graduatedAt,
		snapshotGeneratedAt: now,
		expiresAt: now + ROUTE_STATE_TTL_MS,
		updatedAt: now,
	};
	await ctx.db.patch(perStream._id, fields);
}

/**
 * The hourly tick. `cursor` is an index into the stable cell grid, so a tick
 * always resumes where the previous one stopped and never re-reads the whole
 * grid in one transaction.
 */
export const runRampController = internalMutation({
	args: { cursor: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const now = Date.now();
		const cells = allDeliverabilityCells();
		const rawCursor = args.cursor ?? 0;
		const cursor = Number.isFinite(rawCursor) ? Math.max(0, Math.floor(rawCursor)) : 0;
		if (cursor >= cells.length) return { evaluated: 0, done: true as const };

		// The tenant comes from the route-state rows themselves rather than from the
		// auth component: this deployment hosts exactly one organization, the ramp
		// only ever touches cells that already HAVE a row, and a cron must never be
		// able to fail on an auth lookup. No rows means nothing to ramp — a
		// supported configuration, not an error (plan D2).
		const organizationId = await resolveRampOrganizationId(ctx);
		if (organizationId === null) return { evaluated: 0, done: true as const };

		const settings = await ctx.db.query('instanceSettings').first();
		const isKillSwitchEngaged = settings?.isRampControllerPaused === true;
		const isSendingPermitted = isSendingAllowed(settings?.abuseStatus);

		const slice = cells.slice(cursor, cursor + RAMP_CELLS_PER_TICK);
		let evaluated = 0;
		for (const cell of slice) {
			const loaded = await loadCellInput(ctx, {
				organizationId,
				cell,
				isKillSwitchEngaged,
				isSendingPermitted,
				now,
			});
			// An unmanaged cell is not an evaluation: there is no share to decide
			// about, and inventing one would change shipped routing.
			if (loaded === null) continue;
			const { input, perStream } = loaded;
			const decision = nextShare(input);
			evaluated += 1;

			// THE AUDIT ROW COMES FIRST AND ALWAYS (plan D12) — including for the
			// no-ops, and including while the kill switch is pinning every cell.
			await recordMixDecision(ctx, { organizationId, cell, input, decision, at: now });

			// A PAUSED CONTROLLER WRITES NO SHARE. It still evaluates and still
			// audits, so an operator can watch what it would have done.
			if (isKillSwitchEngaged) continue;

			await applyDecision(ctx, { perStream, decision, now });
			if (decision.direction === 'hold') continue;
			await recordAuditLog(ctx, {
				userId: 'system',
				organizationId,
				action: 'deliverability_ramp.share_changed',
				resource: 'deliverability_ramp',
				resourceId: deliverabilityCellKey(cell),
				details: {
					cell: deliverabilityCellKey(cell),
					fromShare: decision.fromShare,
					toShare: decision.share,
					direction: decision.direction,
					reason: decision.reason,
					verdict: decision.verdict,
					...(decision.failedGate === undefined ? {} : { failedGate: decision.failedGate }),
				},
			});
		}

		const nextCursor = cursor + slice.length;
		if (nextCursor < cells.length) {
			await ctx.scheduler.runAfter(0, internal.delivery.rampControllerCron.runRampController, {
				cursor: nextCursor,
			});
		}
		return { evaluated, done: nextCursor >= cells.length };
	},
});

/**
 * THE GLOBAL KILL SWITCH (plan P3-2's named mitigation for controller
 * complexity). Admin-facing writes live in the settings surface; this internal
 * mutation is the seam an operator runbook and the tests drive.
 */
export const setRampControllerPaused = internalMutation({
	args: { isPaused: v.boolean() },
	handler: async (ctx, args) => {
		const settings = await ctx.db.query('instanceSettings').first();
		if (!settings) return { ok: false as const };
		await ctx.db.patch(settings._id, { isRampControllerPaused: args.isPaused });
		return { ok: true as const };
	},
});

/**
 * Promote a cell one rung up the phase ladder (0.25 -> 0.5 -> 0.8 -> 1.0). A
 * deliberate act, never something the hourly AIMD loop does on its own: the
 * ladder exists precisely so that the biggest steps stay human-authorised.
 */
export const promoteRampPhase = internalMutation({
	args: { stream: v.string(), destinationProvider: v.string() },
	handler: async (ctx, args) => {
		const cell = allDeliverabilityCells().find(
			(candidate) =>
				candidate.stream === args.stream &&
				candidate.destinationProvider === args.destinationProvider
		);
		if (!cell) return { ok: false as const };
		const organizationId = await resolveRampOrganizationId(ctx);
		if (organizationId === null) return { ok: false as const };
		const { perStream } = await loadRouteStateCell(ctx, organizationId, cell);
		if (!perStream) return { ok: false as const };
		// One rung, through the ladder helper: an arbitrary caller-supplied ceiling
		// would let a promotion skip 0.5 and 0.8 straight to 1.0.
		const phaseCeiling = nextPhaseCeiling(perStream.phaseCeiling ?? RAMP_INITIAL_PHASE_CEILING);
		await ctx.db.patch(perStream._id, { phaseCeiling, updatedAt: Date.now() });
		return { ok: true as const, phaseCeiling };
	},
});
