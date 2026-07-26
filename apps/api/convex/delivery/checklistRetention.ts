/**
 * Bounded retention for Deliverability Center observations and incidents.
 *
 * Evidence is immutable and useful for diagnosing regressions, but it must not
 * grow forever. The current observation for every check and observations
 * referenced by an unresolved incident are retained regardless of age.
 * Resolved incidents and completed loopback probes have a shorter operational
 * window because neither is part of the active checklist state.
 */

import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { loopbackTimeoutPatch } from './checklistLoopbackState';
import { checklistTraits } from './checklistTraits';

const DAY_MS = 24 * 60 * 60 * 1_000;
export const DELIVERABILITY_EVIDENCE_RETENTION_MS = 90 * DAY_MS;
export const DELIVERABILITY_COMPLETED_RETENTION_MS = 30 * DAY_MS;
export const DELIVERABILITY_RETENTION_BATCH_SIZE = 128;

const sweepArgs = {
	cursor: v.optional(v.string()),
	startedAt: v.optional(v.number()),
};

type RetentionSweepResult = {
	examined: number;
	deleted?: number;
	resolved?: number;
	reconciled?: number;
	continuationScheduled: boolean;
};

function sweepStartedAt(value: number | undefined): number {
	return value ?? Date.now();
}

export const sweepOrphanAlerts = internalMutation({
	args: sweepArgs,
	handler: async (ctx, args): Promise<RetentionSweepResult> => {
		const startedAt = sweepStartedAt(args.startedAt);
		const page = await ctx.db
			.query('deliverabilityRegressionAlerts')
			.withIndex('by_domain_id')
			.paginate({
				cursor: args.cursor ?? null,
				numItems: DELIVERABILITY_RETENTION_BATCH_SIZE,
			});
		let resolved = 0;
		for (const alert of page.page) {
			if (
				alert.domainId === undefined ||
				alert.resolvedAt !== undefined ||
				(await ctx.db.get(alert.domainId)) !== null
			) {
				continue;
			}
			await ctx.db.patch(alert._id, { resolvedAt: startedAt });
			resolved++;
		}
		if (page.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.delivery.checklistRetention.sweepOrphanVerificationStates,
				{ startedAt }
			);
		} else {
			await ctx.scheduler.runAfter(0, internal.delivery.checklistRetention.sweepOrphanAlerts, {
				cursor: page.continueCursor,
				startedAt,
			});
		}
		return { examined: page.page.length, resolved, continuationScheduled: !page.isDone };
	},
});

async function isProtectedEvidence(
	ctx: MutationCtx,
	evidenceId: Id<'deliverabilityEvidence'>
): Promise<boolean> {
	const [currentState, previousAlert, regressedAlert] = await Promise.all([
		ctx.db
			.query('deliverabilityVerificationState')
			.withIndex('by_current_evidence', (q) => q.eq('currentEvidenceId', evidenceId))
			.first(),
		ctx.db
			.query('deliverabilityRegressionAlerts')
			.withIndex('by_previous_evidence_resolved', (q) =>
				q.eq('previousEvidenceId', evidenceId).eq('resolvedAt', undefined)
			)
			.first(),
		ctx.db
			.query('deliverabilityRegressionAlerts')
			.withIndex('by_regressed_evidence_resolved', (q) =>
				q.eq('regressedEvidenceId', evidenceId).eq('resolvedAt', undefined)
			)
			.first(),
	]);
	return currentState !== null || previousAlert !== null || regressedAlert !== null;
}

/**
 * Remove one cursor page of domain-scoped state whose domain was deleted.
 * This runs before evidence retention so an orphaned currentEvidenceId cannot
 * pin an otherwise superseded observation forever.
 */
export const sweepOrphanVerificationStates = internalMutation({
	args: sweepArgs,
	handler: async (ctx, args): Promise<RetentionSweepResult> => {
		const startedAt = sweepStartedAt(args.startedAt);
		const page = await ctx.db
			.query('deliverabilityVerificationState')
			.withIndex('by_domain_id')
			.paginate({
				cursor: args.cursor ?? null,
				numItems: DELIVERABILITY_RETENTION_BATCH_SIZE,
			});
		let deleted = 0;
		for (const state of page.page) {
			if (
				checklistTraits(state.itemId).scope !== 'domain' ||
				state.domainId === undefined ||
				(await ctx.db.get(state.domainId)) !== null
			) {
				continue;
			}
			await ctx.db.delete(state._id);
			deleted++;
		}
		if (page.isDone) {
			await ctx.scheduler.runAfter(0, internal.delivery.checklistRetention.sweepEvidence, {
				startedAt,
			});
		} else {
			await ctx.scheduler.runAfter(
				0,
				internal.delivery.checklistRetention.sweepOrphanVerificationStates,
				{ cursor: page.continueCursor, startedAt }
			);
		}
		return {
			examined: page.page.length,
			deleted,
			continuationScheduled: !page.isDone,
		};
	},
});

/** Delete one cursor page of superseded evidence, then continue the chain. */
export const sweepEvidence = internalMutation({
	args: sweepArgs,
	handler: async (ctx, args): Promise<RetentionSweepResult> => {
		const startedAt = sweepStartedAt(args.startedAt);
		const cutoff = startedAt - DELIVERABILITY_EVIDENCE_RETENTION_MS;
		const page = await ctx.db
			.query('deliverabilityEvidence')
			.withIndex('by_observed_at', (q) => q.lt('observedAt', cutoff))
			.paginate({
				cursor: args.cursor ?? null,
				numItems: DELIVERABILITY_RETENTION_BATCH_SIZE,
			});
		let deleted = 0;
		for (const evidence of page.page) {
			if (await isProtectedEvidence(ctx, evidence._id)) continue;
			await ctx.db.delete(evidence._id);
			deleted++;
		}
		if (page.isDone) {
			await ctx.scheduler.runAfter(0, internal.delivery.checklistRetention.sweepAlerts, {
				startedAt,
			});
		} else {
			await ctx.scheduler.runAfter(0, internal.delivery.checklistRetention.sweepEvidence, {
				cursor: page.continueCursor,
				startedAt,
			});
		}
		return {
			examined: page.page.length,
			deleted,
			continuationScheduled: !page.isDone,
		};
	},
});

/** Delete one cursor page of alerts resolved more than 30 days ago. */
export const sweepAlerts = internalMutation({
	args: sweepArgs,
	handler: async (ctx, args): Promise<RetentionSweepResult> => {
		const startedAt = sweepStartedAt(args.startedAt);
		const cutoff = startedAt - DELIVERABILITY_COMPLETED_RETENTION_MS;
		const page = await ctx.db
			.query('deliverabilityRegressionAlerts')
			.withIndex('by_resolved_at', (q) => q.gte('resolvedAt', 0).lt('resolvedAt', cutoff))
			.paginate({
				cursor: args.cursor ?? null,
				numItems: DELIVERABILITY_RETENTION_BATCH_SIZE,
			});
		for (const alert of page.page) await ctx.db.delete(alert._id);
		if (page.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.delivery.checklistRetention.reconcileExpiredLoopbackAttempts,
				{ startedAt }
			);
		} else {
			await ctx.scheduler.runAfter(0, internal.delivery.checklistRetention.sweepAlerts, {
				cursor: page.continueCursor,
				startedAt,
			});
		}
		return {
			examined: page.page.length,
			deleted: page.page.length,
			continuationScheduled: !page.isDone,
		};
	},
});

/** Reconcile probes whose scheduled expiry was missed before retaining terminal rows. */
export const reconcileExpiredLoopbackAttempts = internalMutation({
	args: sweepArgs,
	handler: async (ctx, args): Promise<RetentionSweepResult> => {
		const startedAt = sweepStartedAt(args.startedAt);
		const page = await ctx.db
			.query('deliverabilityLoopbackAttempts')
			.withIndex('by_expires_at', (q) => q.lte('expiresAt', startedAt))
			.paginate({
				cursor: args.cursor ?? null,
				numItems: DELIVERABILITY_RETENTION_BATCH_SIZE,
			});
		let reconciled = 0;
		for (const attempt of page.page) {
			if (attempt.status !== 'sending' && attempt.status !== 'awaiting_inbound') continue;
			await ctx.db.patch(attempt._id, loopbackTimeoutPatch(attempt._id, startedAt));
			reconciled++;
		}
		if (page.isDone) {
			await ctx.scheduler.runAfter(0, internal.delivery.checklistRetention.sweepLoopbackAttempts, {
				startedAt,
			});
		} else {
			await ctx.scheduler.runAfter(
				0,
				internal.delivery.checklistRetention.reconcileExpiredLoopbackAttempts,
				{ cursor: page.continueCursor, startedAt }
			);
		}
		return {
			examined: page.page.length,
			reconciled,
			continuationScheduled: !page.isDone,
		};
	},
});

function isCompletedLoopbackStatus(status: string): boolean {
	return status === 'passed' || status === 'failed' || status === 'timed_out';
}

/** Delete one cursor page of terminal loopback probes completed over 30 days ago. */
export const sweepLoopbackAttempts = internalMutation({
	args: sweepArgs,
	handler: async (ctx, args): Promise<RetentionSweepResult> => {
		const startedAt = sweepStartedAt(args.startedAt);
		const cutoff = startedAt - DELIVERABILITY_COMPLETED_RETENTION_MS;
		const page = await ctx.db
			.query('deliverabilityLoopbackAttempts')
			.withIndex('by_completed_at', (q) => q.gte('completedAt', 0).lt('completedAt', cutoff))
			.paginate({
				cursor: args.cursor ?? null,
				numItems: DELIVERABILITY_RETENTION_BATCH_SIZE,
			});
		let deleted = 0;
		for (const attempt of page.page) {
			if (!isCompletedLoopbackStatus(attempt.status)) continue;
			await ctx.db.delete(attempt._id);
			deleted++;
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.delivery.checklistRetention.sweepLoopbackAttempts, {
				cursor: page.continueCursor,
				startedAt,
			});
		}
		return {
			examined: page.page.length,
			deleted,
			continuationScheduled: !page.isDone,
		};
	},
});
