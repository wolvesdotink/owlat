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
	hasCriticalBlocklistSignal,
	isFallbackActiveForShare,
	resolveOwnShare,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import type { Doc } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { isSendingAllowed } from '../workspaces/abuseGate';
import { loadRouteStateCell, loadStreamlessRouteState } from '../lib/deliverabilityRouteState';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import {
	summarizeTransportOutcomeArms,
	summarizeTransportOutcomes,
} from '../analytics/transportOutcomes';
import { recordAuditLog } from '../lib/auditLog';
import { nextPhaseCeiling, RAMP_AIMD, RAMP_INITIAL_PHASE_CEILING } from './ramp/controllerConfig';
import { nextShare } from './ramp/controller';
import { RAMP_STREAM_CONFIGS } from './ramp/gateConfig';
import { referenceArmGateEvaluator } from './ramp/gateEvaluation';
import { evaluateEngagementGate } from './ramp/engagementGate';
import { UNCONSTRAINED_RAMP_CAPACITY } from './rampCapacity';
import { recordMixDecision } from './rampMixDecisions';
import {
	deliverabilityStreamValidator,
	destinationProviderValidator,
} from './deliverabilityValidators';
import type { RampControllerInput, RampDecision, RampMixState } from './ramp/controllerTypes';

/** Cells evaluated per tick. The grid is 15; three ticks cover it. */
export const RAMP_CELLS_PER_TICK = 5;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/**
 * The gate evaluation window: one day of outcomes. Taken from the controller's
 * own constant rather than re-declared, because the SAME number is what spaces
 * two counted windows apart — the cron ticks hourly, so a query window and a
 * streak-spacing window that could disagree would let three overlapping reads of
 * the same day satisfy K_CLEAN.
 */
const RAMP_WINDOW_MS = RAMP_AIMD.evaluationWindowMs;
/** Route-state rows are refreshed on every tick; the TTL matches the snapshot's. */
const ROUTE_STATE_TTL_MS = DAY_MS;
/** The engagement floor's recent window and the prior baseline it is compared to. */
const ENGAGEMENT_RECENT_MS = 7 * DAY_MS;
const ENGAGEMENT_BASELINE_MS = 30 * DAY_MS;

/**
 * The deployment's tenant, through the SAME resolver every other org-scoped
 * background writer uses (`analytics/transportOutcomes.ts` does exactly this).
 * A cron must never be able to fail on an auth lookup, so a throw is read as
 * "no organization yet" — a supported configuration, not an error (plan D2).
 */
async function resolveRampOrganizationId(ctx: MutationCtx): Promise<string | null> {
	try {
		return await getSingletonOrganizationId(ctx);
	} catch {
		return null;
	}
}

/**
 * Infrastructure verdicts, read off whichever route-state rows exist.
 *
 * WHICH ROWS MATTER IS NOT THE SAME PER SIGNAL. `breaker_open` is emitted per
 * destination provider, so the cell's own rows carry it. Pool-level blocklist
 * and quarantine signals are emitted by the MTA against the WHOLE pool with
 * `provider: 'all'`, and `applySnapshot` files them onto the `'all'` row only —
 * so a controller that read the cell's rows alone would never see one, and the
 * plan's critical-blocklist hard stop would be dead code. Every caller passes
 * the pool row as well.
 *
 * The blocklist test itself is the SHIPPED predicate, not a local copy: one
 * definition of "critically blocklisted" for routing and for the ramp.
 */
function readHardStopSignals(
	rows: readonly (Doc<'deliverabilityRouteStates'> | null)[],
	isSendingPermitted: boolean
) {
	let isCircuitBreakerOpen = false;
	let isPoolBlocklisted = false;
	for (const row of rows) {
		const signals = row?.signals ?? [];
		if (signals.some((signal) => signal.source === 'breaker_open')) isCircuitBreakerOpen = true;
		if (hasCriticalBlocklistSignal(signals)) isPoolBlocklisted = true;
	}
	return { isSendingAllowed: isSendingPermitted, isCircuitBreakerOpen, isPoolBlocklisted };
}

/**
 * The STORED state, read out verbatim.
 *
 * `share` is deliberately NOT normalised here. `resolveOwnShare` clamps a stored
 * `ownShare` on the way out, which is right for every routing reader — but
 * handing the controller a clamped value would mean a row holding `-0.5`, `1.5`
 * or `NaN` arrives as a perfectly ordinary `0` or `1`, the decision function's
 * `share_unreadable` rung could never fire in production, and a corrupt row
 * would be stepped UP on the next clean tick (or start a graduation clock).
 * `resolveOwnShare` stays as the fallback for the ABSENT-share case only, which
 * is the one case it is being asked a question about.
 */
function readMixState(row: Doc<'deliverabilityRouteStates'> | null): RampMixState {
	return {
		share: row?.ownShare ?? resolveOwnShare(row),
		phaseCeiling: row?.phaseCeiling,
		cleanStreak: row?.cleanStreak,
		frozenUntil: row?.frozenUntil,
		freezeStartedAt: row?.fallbackActiveSince,
		cooldownMs: row?.cooldownMs,
		greenSince: row?.healthySince,
		graduatedAt: row?.graduatedAt,
		lastCountedAt: row?.lastCountedAt,
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
		/**
		 * The POOL-WIDE slice, read ONCE per tick by the caller: every blocklist /
		 * quarantine signal the MTA reports is filed against `provider: 'all'`, so
		 * it lives on no cell's row — and it is cell-independent, so reading it in
		 * here would be the same index lookup repeated once per cell.
		 */
		pool: Doc<'deliverabilityRouteStates'> | null;
		isKillSwitchEngaged: boolean;
		isSendingPermitted: boolean;
		now: number;
	}
): Promise<{ input: RampControllerInput; perStream: Doc<'deliverabilityRouteStates'> } | null> {
	const { organizationId, cell, pool, now } = args;
	const cellKey = deliverabilityCellKey(cell);
	const { perStream, streamless } = await loadRouteStateCell(ctx, organizationId, cell);
	if (!perStream || perStream.ownShare === undefined) return null;
	const mix = readMixState(perStream);

	const window = { organizationId, cell: cellKey, since: now - RAMP_WINDOW_MS };
	const { own, reference } = await summarizeTransportOutcomeArms(ctx.db, window);
	// The engagement baselines are OWN-ARM ONLY (that gate compares the own arm
	// to its own past), so they read one arm rather than both: a reference-arm
	// summary here would be a second indexed collect thrown away.
	const ownRecent = await summarizeTransportOutcomes(ctx.db, {
		organizationId,
		cell: cellKey,
		arm: 'own',
		since: now - ENGAGEMENT_RECENT_MS,
	});
	const ownPriorBaseline = await summarizeTransportOutcomes(ctx.db, {
		organizationId,
		cell: cellKey,
		arm: 'own',
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
		ownRecent,
		ownPriorBaseline,
		now,
	});

	const evaluation = referenceArmGateEvaluator.evaluate({
		config: RAMP_STREAM_CONFIGS[cell.stream],
		own,
		reference: referenceArm,
		engagement,
		previousCleanStreak: perStream.cleanStreak ?? 0,
		now,
	});

	return {
		perStream,
		input: {
			cell,
			config: RAMP_STREAM_CONFIGS[cell.stream],
			mix,
			signals: readHardStopSignals([perStream, streamless, pool], args.isSendingPermitted),
			evaluation,
			// P3-3 owns the real per-(IP x mailbox provider) projection; until it
			// lands the controller is bounded by its PHASE CEILING alone. A stand-in
			// projection here would be a rule with no fixture and a ceiling nobody
			// designed (see rampCapacity.ts).
			capacity: UNCONSTRAINED_RAMP_CAPACITY,
			isKillSwitchEngaged: args.isKillSwitchEngaged,
			now,
		},
	};
}

/**
 * KEEP THE CELL'S RAMP STATE ALIVE.
 *
 * `deliverabilityRouteStates` rows carry a 24h `expiresAt` and the shipped
 * 5-minute sweep deletes anything past it. That TTL is right for a cached MTA
 * snapshot; it is WRONG for the durable AIMD state the ramp keeps on the
 * per-stream row (share, phase ceiling, clean streak, graduation clock). A
 * paused controller — or any deploy/outage gap over a day — would otherwise
 * lose the row, and a missing row resolves to share 1.0: the exact opposite of
 * "pinned at its current share".
 *
 * So EVERY evaluation refreshes the lease, including the ones that write no
 * share. The refresh touches nothing else.
 */
async function refreshRouteStateLease(
	ctx: MutationCtx,
	perStream: Doc<'deliverabilityRouteStates'>,
	now: number
): Promise<void> {
	await ctx.db.patch(perStream._id, { expiresAt: now + ROUTE_STATE_TTL_MS, updatedAt: now });
}

/**
 * Persist one decision onto the cell's per-stream route-state row.
 *
 * `mixVersion` is NOT touched here. It salts per-recipient assignment (plan
 * D7), so it names a mix GENERATION, not a step: bumping it on an ordinary
 * +5pp promotion would re-shuffle every recipient's arm mid-comparison, ~20
 * times during a single ramp. It advances only on a deliberate generation
 * change (a phase promotion), where re-randomising is the point.
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
	const fields = {
		isFallbackActive: isFallbackActiveForShare(decision.share),
		ownShare: decision.share,
		phaseCeiling: decision.phaseCeiling,
		cleanStreak: decision.cleanStreak,
		// The GATE-COOLDOWN ladder's clock: start, expiry and rung move together,
		// and only a LADDER freeze re-stamps the start. A hard-stop freeze (breaker
		// 6h, critical blocklist 24h) sets the expiry and leaves the ladder's anchor
		// alone — otherwise an infrastructure incident would re-arm the "repeat
		// within 24h" window and double the next gate cooldown off a stale rung.
		fallbackActiveSince: decision.cooldownMs === undefined ? perStream.fallbackActiveSince : now,
		frozenUntil: decision.frozenUntil ?? perStream.frozenUntil,
		cooldownMs: decision.cooldownMs ?? perStream.cooldownMs,
		healthySince: decision.greenSince,
		graduatedAt: decision.graduatedAt,
		// Only a COUNTED window moves the anchor: an evaluation that did not count
		// must leave the previous one in place, or every hourly tick would push the
		// next countable window another hour out and the streak could never grow.
		lastCountedAt: decision.countedAt ?? perStream.lastCountedAt,
		// `snapshotGeneratedAt` is NOT touched. It means "the instant the MTA
		// generated the snapshot" everywhere else, and `applySnapshot` uses it as
		// its idempotency comparand; stamping the controller's own clock into it
		// would give one column two meanings across two row shapes. The controller's
		// clock is `updatedAt`.
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

		// No organization yet means nothing to ramp — a supported configuration,
		// not an error (plan D2). See `resolveRampOrganizationId`.
		const organizationId = await resolveRampOrganizationId(ctx);
		if (organizationId === null) return { evaluated: 0, done: true as const };

		const settings = await ctx.db.query('instanceSettings').first();
		const isKillSwitchEngaged = settings?.isRampControllerPaused === true;
		const isSendingPermitted = isSendingAllowed(settings?.abuseStatus);

		// Cell-independent, so it is read ONCE for the whole slice rather than once
		// per cell: the pool row carries the same verdict for all fifteen cells.
		const pool = await loadStreamlessRouteState(ctx, organizationId, 'all');

		const slice = cells.slice(cursor, cursor + RAMP_CELLS_PER_TICK);
		let evaluated = 0;
		for (const cell of slice) {
			const loaded = await loadCellInput(ctx, {
				organizationId,
				cell,
				pool,
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

			// A PAUSED CONTROLLER WRITES NO SHARE. It still evaluates, still audits —
			// so an operator can watch what it would have done — and still renews the
			// row's lease, because "pinned" has to survive longer than the cache TTL.
			if (isKillSwitchEngaged) {
				await refreshRouteStateLease(ctx, perStream, now);
				continue;
			}

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
 * complexity). The OPERATOR path is `workspaces/settings.update`
 * (`isRampControllerPaused`), which is permission-gated and audits the change;
 * this internal mutation is the seam an incident runbook and the tests drive
 * when there is no session to act through.
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
 *
 * A promotion IS a new mix generation, so it is also the one place that
 * advances `mixVersion` (plan D7): the cohort is deliberately re-randomised
 * when the phase changes, and never on an ordinary AIMD step.
 */
export const promoteRampPhase = internalMutation({
	args: {
		stream: deliverabilityStreamValidator,
		destinationProvider: destinationProviderValidator,
	},
	handler: async (ctx, args) => {
		const cell: DeliverabilityCell = {
			stream: args.stream,
			destinationProvider: args.destinationProvider,
		};
		const organizationId = await resolveRampOrganizationId(ctx);
		if (organizationId === null) return { ok: false as const };
		const { perStream } = await loadRouteStateCell(ctx, organizationId, cell);
		if (!perStream) return { ok: false as const };
		// One rung, through the ladder helper: an arbitrary caller-supplied ceiling
		// would let a promotion skip 0.5 and 0.8 straight to 1.0.
		const current = perStream.phaseCeiling ?? RAMP_INITIAL_PHASE_CEILING;
		const phaseCeiling = nextPhaseCeiling(current);
		// Already at the top rung: nothing to promote, and re-randomising the
		// cohort for a no-op would cost the comparison its continuity for nothing.
		if (phaseCeiling === current) return { ok: true as const, phaseCeiling };
		await ctx.db.patch(perStream._id, {
			phaseCeiling,
			mixVersion: (perStream.mixVersion ?? 0) + 1,
			updatedAt: Date.now(),
		});
		return { ok: true as const, phaseCeiling };
	},
});
