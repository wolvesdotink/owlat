/**
 * Spend admission (ADR-0073, Phase 1b; owner decision D1; #1333).
 *
 * Reserve before dispatch, settle against the ledger after it:
 *
 * - {@link reserve} decides and, when admitted, inserts the hold, in one
 *   mutation. It reads the complete period totals and every outstanding hold
 *   (`./admissionState.ts`), so two concurrent admissions conflict and
 *   serialize: the second sees the first's hold. Idempotent by
 *   `reservationId`.
 * - {@link settle} closes a hold from its ledger rows (`./settlement.ts`);
 *   the metered writer also settles in the same mutation that writes the rows
 *   (`analytics/llmUsage.ts` `recordRequests`).
 * - {@link release} closes a hold whose dispatch never reached a provider.
 * - {@link sweepExpiredHolds} settles holds whose action died (a crash
 *   between dispatch and settlement), charging the whole hold less what the
 *   ledger already has, and keeps the aggregate reconciled.
 * - {@link headroom} is the read-only verdict for a call of a given shape,
 *   for the gates that refuse before any work starts.
 *
 * Integer micro-USD throughout. A refusal is an answer, not an error: the
 * caller decides what a refusal means (a budget error for a user, a hold for
 * a Team message, a deferral for background work).
 */

import { v, type Infer } from 'convex/values';
import { internal } from '../_generated/api';
import { internalQuery, type MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { llmUsagePlaneValidator } from '../lib/llmUsageTags';
import {
	admissionPriorityValidator,
	aiTaskNameValidator,
	budgetClassValidator,
} from '../lib/validators/aiRouting';
import { admissionVerdict, loadAdmissionContext, needsAdmission } from './admissionState';
import { settleReservation } from './settlement';
import type { AdmissionVerdict } from '../lib/aiRouting/admissionRules';

const refusalValidator = v.object({
	isAdmitted: v.literal(false),
	reason: v.union(
		v.literal('daily_ceiling'),
		v.literal('monthly_ceiling'),
		v.literal('spend_unverifiable')
	),
	limit: v.union(
		v.literal('ceiling'),
		v.literal('triage_allowance'),
		v.literal('advisory_reserve'),
		v.literal('plane_capacity'),
		v.literal('shadow_allowance'),
		v.literal('unverifiable')
	),
});

/** Holds swept per run; the sweep reschedules itself while more are due. */
const SWEEP_BATCH = 100;

const requestBoundValidator = v.object({
	requestId: v.optional(v.string()),
	attempt: v.optional(v.number()),
	microusd: v.number(),
});

/** The most request bounds one hold records (a tool loop's steps times its attempts, with room). */
export const MAX_REQUEST_BOUNDS = 128;

const reserveArgs = {
	reservationId: v.string(),
	rootRequestId: v.string(),
	parentCallId: v.optional(v.string()),
	plane: llmUsagePlaneValidator,
	task: aiTaskNameValidator,
	budgetClass: budgetClassValidator,
	priority: admissionPriorityValidator,
	/** Integer micro-USD the whole call may cost: every request it may make. */
	heldMicrousd: v.number(),
	/** The provider requests the hold covers (attempts × steps). */
	maxRequests: v.number(),
	/** The bound of the request the hold opens with. */
	requestBound: requestBoundValidator,
	/**
	 * Further requests' own bounds, keyed by request id and attempt, for a hold
	 * that covers several calls of different sizes (an interpretation run's
	 * extraction and verifier, Sol r5 F2): unknown usage is charged at its own.
	 */
	requestBounds: v.optional(v.array(requestBoundValidator)),
	modelId: v.optional(v.string()),
	endpoint: v.optional(v.string()),
	expiresAt: v.number(),
};

export type ReserveArgs = Infer<ReturnType<typeof v.object<typeof reserveArgs>>>;

export type ReserveResult =
	| { readonly isAdmitted: true; readonly isHeld: boolean }
	| Extract<AdmissionVerdict, { isAdmitted: false }>;

/**
 * Decide and hold, in the caller's mutation: `reserve` below, and the plugin
 * host's own reservation (`plugins/llmAccounting.ts`), which takes its
 * deployment hold in the same transaction as its plugin budget.
 */
export async function reserveInMutation(
	ctx: MutationCtx,
	args: ReserveArgs
): Promise<ReserveResult> {
	const existing = await ctx.db
		.query('llmReservations')
		.withIndex('by_reservation_id', (q) => q.eq('reservationId', args.reservationId))
		.first();
	// A retried reserve (the first committed, its reply was lost) finds its hold.
	if (existing) return { isAdmitted: true, isHeld: existing.status === 'held' };
	if (
		!Number.isSafeInteger(args.heldMicrousd) ||
		args.heldMicrousd < 0 ||
		![args.requestBound, ...(args.requestBounds ?? [])].every(
			(bound) => Number.isSafeInteger(bound.microusd) && bound.microusd >= 0
		) ||
		1 + (args.requestBounds?.length ?? 0) > MAX_REQUEST_BOUNDS
	) {
		return { isAdmitted: false, reason: 'spend_unverifiable', limit: 'unverifiable' };
	}

	const now = Date.now();
	const context = await loadAdmissionContext(ctx);
	if (!needsAdmission(context, args.budgetClass)) return { isAdmitted: true, isHeld: false };
	const verdict = await admissionVerdict(
		ctx,
		context,
		{
			plane: args.plane,
			budgetClass: args.budgetClass,
			priority: args.priority,
			microusd: args.heldMicrousd,
		},
		now
	);
	if (!verdict.isAdmitted) {
		// An aggregate nobody has reconciled yet starts reconciling now.
		if (verdict.limit === 'unverifiable') {
			await ctx.scheduler.runAfter(0, internal.aiRouting.spendAggregate.ensureReconciled, {});
		}
		return verdict;
	}
	await ctx.db.insert('llmReservations', {
		reservationId: args.reservationId,
		rootRequestId: args.rootRequestId,
		...(args.parentCallId ? { parentCallId: args.parentCallId } : {}),
		plane: args.plane,
		task: args.task,
		budgetClass: args.budgetClass,
		priority: args.priority,
		heldMicrousd: args.heldMicrousd,
		status: 'held',
		...(args.modelId ? { modelId: args.modelId } : {}),
		...(args.endpoint ? { endpoint: args.endpoint } : {}),
		maxAttempts: Math.max(1, Math.floor(args.maxRequests)),
		requestBounds: [args.requestBound, ...(args.requestBounds ?? [])],
		policyVersion: context.policy.policyVersion,
		expiresAt: args.expiresAt,
		createdAt: now,
		updatedAt: now,
	});
	return { isAdmitted: true, isHeld: true };
}

export const reserve = internalMutation({
	args: reserveArgs,
	returns: v.union(
		v.object({ isAdmitted: v.literal(true), isHeld: v.boolean() }),
		refusalValidator
	),
	handler: (ctx, args) => reserveInMutation(ctx, args),
});

/**
 * Admit one run's whole path as several allocations, atomically (Sol r3 F1,
 * clarify lane): each allocation is decided by the same rule as
 * {@link reserve} against its OWN plane's capacity, the shared ceiling and
 * every hold already outstanding, the earlier allocations of this call
 * included (one transaction reads its own writes). If any allocation is
 * refused, the ones already inserted in this call are deleted, so nothing is
 * admitted. Each allocation is an ordinary hold that settles on its own plane.
 * Idempotent by the allocations' `reservationId`s.
 */
export const reserveRun = internalMutation({
	args: { allocations: v.array(v.object(reserveArgs)) },
	returns: v.union(
		v.object({ isAdmitted: v.literal(true), heldReservationIds: v.array(v.string()) }),
		refusalValidator
	),
	handler: async (ctx, args) => {
		const inserted: string[] = [];
		const held: string[] = [];
		for (const allocation of args.allocations) {
			const isNew =
				(await ctx.db
					.query('llmReservations')
					.withIndex('by_reservation_id', (q) => q.eq('reservationId', allocation.reservationId))
					.first()) === null;
			const result = await reserveInMutation(ctx, allocation);
			if (!result.isAdmitted) {
				for (const reservationId of inserted) {
					const row = await ctx.db
						.query('llmReservations')
						.withIndex('by_reservation_id', (q) => q.eq('reservationId', reservationId))
						.first();
					if (row) await ctx.db.delete(row._id);
				}
				return result;
			}
			if (result.isHeld) {
				held.push(allocation.reservationId);
				if (isNew) inserted.push(allocation.reservationId);
			}
		}
		return { isAdmitted: true as const, heldReservationIds: held };
	},
});

/**
 * Grow a held reservation by one more provider request before it is sent (a
 * retry, a tool round, a stream step), under the same rule as a new hold: the
 * hold itself already counts as outstanding, so only the increment is asked
 * for. A hold that is no longer `held` cannot grow.
 */
export const extend = internalMutation({
	args: { reservationId: v.string(), requestBound: requestBoundValidator },
	returns: v.union(v.object({ isAdmitted: v.literal(true) }), refusalValidator),
	handler: async (ctx, args) => {
		const hold = await ctx.db
			.query('llmReservations')
			.withIndex('by_reservation_id', (q) => q.eq('reservationId', args.reservationId))
			.first();
		if (!hold || hold.status !== 'held') {
			return {
				isAdmitted: false as const,
				reason: 'spend_unverifiable' as const,
				limit: 'unverifiable' as const,
			};
		}
		const addMicrousd = args.requestBound.microusd;
		const bounds = hold.requestBounds ?? [];
		if (
			!Number.isSafeInteger(addMicrousd) ||
			addMicrousd < 0 ||
			bounds.length >= MAX_REQUEST_BOUNDS
		) {
			return {
				isAdmitted: false as const,
				reason: 'spend_unverifiable' as const,
				limit: 'unverifiable' as const,
			};
		}
		const now = Date.now();
		const context = await loadAdmissionContext(ctx);
		const verdict = await admissionVerdict(
			ctx,
			context,
			{
				plane: hold.plane,
				budgetClass: hold.budgetClass,
				priority: hold.priority,
				microusd: addMicrousd,
			},
			now
		);
		if (!verdict.isAdmitted) return verdict;
		await ctx.db.patch(hold._id, {
			heldMicrousd: hold.heldMicrousd + addMicrousd,
			maxAttempts: hold.maxAttempts + 1,
			requestBounds: [...bounds, args.requestBound],
			updatedAt: now,
		});
		return { isAdmitted: true as const };
	},
});

/** Settle a hold whose dispatch is over and whose rows are written. */
export const settle = internalMutation({
	args: { reservationId: v.string(), expectedRequests: v.number() },
	handler: async (ctx, args) => {
		await settleReservation(ctx, args.reservationId, {
			mode: 'call_end',
			expectedRequests: args.expectedRequests,
		});
	},
});

/** Release a hold whose dispatch never sent a request (refused, aborted, past its deadline). */
export const release = internalMutation({
	args: { reservationId: v.string() },
	handler: async (ctx, args) => {
		await settleReservation(ctx, args.reservationId, { mode: 'call_end', expectedRequests: 0 });
	},
});

/**
 * The verdict a call of this shape would get now, without holding anything:
 * the gates that refuse before work starts (`mail/ai/gate.ts`, the Team
 * walker, the voice profile) ask with the smallest amount, one micro-USD.
 */
export const headroom = internalQuery({
	args: {
		plane: llmUsagePlaneValidator,
		budgetClass: budgetClassValidator,
		priority: admissionPriorityValidator,
	},
	returns: v.union(v.object({ isAdmitted: v.literal(true) }), refusalValidator),
	handler: async (ctx, args) => {
		const context = await loadAdmissionContext(ctx);
		return admissionVerdict(ctx, context, { ...args, microusd: 1 }, Date.now());
	},
});

/**
 * Settle every hold past its expiry (cron, and self-rescheduled while more are
 * due). A hold expires well after its action's limit, so its action is gone:
 * the whole hold is charged less what the ledger already has for it.
 */
export const sweepExpiredHolds = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const due = await ctx.db
			.query('llmReservations')
			.withIndex('by_status_and_expires_at', (q) => q.eq('status', 'held').lt('expiresAt', now))
			.take(SWEEP_BATCH);
		for (const hold of due) {
			await settleReservation(ctx, hold.reservationId, { mode: 'expired' }, now);
		}
		if (due.length === SWEEP_BATCH) {
			await ctx.scheduler.runAfter(0, internal.aiRouting.admission.sweepExpiredHolds, {});
		}
		await ctx.scheduler.runAfter(0, internal.aiRouting.spendAggregate.ensureReconciled, {});
	},
});
