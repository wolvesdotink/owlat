/**
 * Automation deletion — the one owner of an automation's way into Recently
 * deleted, back out of it, and out of the database (`lib/softDelete.ts`).
 *
 * Only an automation that is not running can be deleted (pause it first), so
 * no trigger enrols contacts into a deleted one and its in-flight runs stay
 * held exactly as pausing left them. Delete stamps the row and takes it out of
 * its listing bucket; its steps and runs stay, so a restore brings back the
 * same workflow, paused or draft as it was.
 *
 * The purge removes the automation row and its steps, which is what a delete
 * did before Recently deleted existed. Once it has removed some steps without
 * finishing, the row is marked and can no longer be restored. Runs and step
 * runs are per-contact history and keep their policy (contact erasure owns
 * their removal).
 *
 * Both directions are idempotent: deleting a deleted automation does not move
 * its retention clock or its counter, and restoring a live one is a no-op.
 */

import { paginationOptsValidator } from 'convex/server';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { automationsQuery } from './_helpers';
import { recordAuditLog } from '../lib/auditLog';
import { recordListingCounter } from '../lib/listingCounters';
import { hasPermission, requirePermission } from '../lib/sessionOrganization';
import {
	assertRestorable,
	drainExpiredRows,
	purgeAt,
	RETENTION_PURGE_USER,
	type DeletionOutcome,
	type PurgeProgress,
} from '../lib/softDelete';
import type { ErasureBudget } from '../contacts/erasure/budget';
import { throwInvalidState, throwNotFound } from '../_utils/errors';

/** Move an automation to Recently deleted. Refuses one that is running. */
export async function softDeleteAutomation(
	ctx: MutationCtx,
	automation: Doc<'automations'>,
	userId: string
): Promise<DeletionOutcome> {
	if (automation.deletedAt !== undefined) return 'unchanged';
	if (automation.status === 'active') {
		throwInvalidState('Cannot delete active automations. Please pause first.');
	}

	const deletedAt = Date.now();
	await ctx.db.patch(automation._id, { deletedAt, deletedBy: userId });
	await recordListingCounter(ctx, 'automationStatus', automation, { ...automation, deletedAt });
	await recordAuditLog(ctx, {
		userId,
		action: 'automation.deleted',
		resource: 'automation',
		resourceId: automation._id,
		details: { name: automation.name },
	});
	return 'changed';
}

/** Bring an automation back from Recently deleted, as it was when it was deleted. */
export async function restoreAutomation(
	ctx: MutationCtx,
	automationId: Id<'automations'>,
	userId: string
): Promise<DeletionOutcome> {
	const automation = await ctx.db.get(automationId);
	// Gone for good: the purge got to it first.
	if (!automation) throwNotFound('Automation');
	if (automation.deletedAt === undefined) return 'unchanged';
	assertRestorable(automation);

	await ctx.db.patch(automationId, { deletedAt: undefined, deletedBy: undefined });
	await recordListingCounter(ctx, 'automationStatus', automation, {
		...automation,
		deletedAt: undefined,
	});
	await recordAuditLog(ctx, {
		userId,
		action: 'automation.restored',
		resource: 'automation',
		resourceId: automationId,
		details: { name: automation.name },
	});
	return 'changed';
}

/**
 * Delete an automation's steps within `budget`. True when none are left.
 */
async function deleteStepsWithin(
	ctx: MutationCtx,
	automationId: Id<'automations'>,
	budget: ErasureBudget
): Promise<boolean> {
	while (!budget.isExhausted) {
		const chunk = budget.chunk();
		const steps = await ctx.db
			.query('automationSteps')
			.withIndex('by_automation', (q) => q.eq('automationId', automationId))
			.take(chunk);
		for (const step of steps) {
			budget.charge(step);
			await ctx.db.delete(step._id);
		}
		if (steps.length < chunk) return true;
	}
	return false;
}

/**
 * Permanently remove up to `limit` automations deleted before `cutoff`, oldest
 * first, each with its steps, within the purge transaction's shared `budget`.
 * An automation whose steps outrun the budget keeps its row, marked so it can
 * no longer be restored (it is still selected next time), and the purge
 * resumes where it stopped. `hasMore` tells the purge to come back for the rest.
 */
export async function purgeExpiredAutomations(
	ctx: MutationCtx,
	cutoff: number,
	limit: number,
	budget: ErasureBudget
): Promise<PurgeProgress> {
	return await drainExpiredRows(
		budget,
		limit,
		() =>
			ctx.db
				.query('automations')
				.withIndex('by_deleted_at', (q) => q.gte('deletedAt', 0).lt('deletedAt', cutoff))
				.first(),
		async (automation) => {
			budget.chargeRead(automation);
			if (!(await deleteStepsWithin(ctx, automation._id, budget))) {
				if (automation.purgeStartedAt === undefined) {
					await ctx.db.patch(automation._id, { purgeStartedAt: Date.now() });
				}
				return false;
			}
			budget.charge(automation);
			await ctx.db.delete(automation._id);
			await recordAuditLog(ctx, {
				userId: RETENTION_PURGE_USER,
				action: 'automation.purged',
				resource: 'automation',
				resourceId: automation._id,
				details: { name: automation.name },
			});
			return true;
		}
	);
}

/**
 * The automations in Recently deleted, most recently deleted first. Restoring
 * needs `automations:manage`, the permission a delete needs, so the list does too.
 */
export const listDeleted = automationsQuery({
	args: { paginationOpts: paginationOptsValidator },
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'automations:manage'),
			'Only owners and admins can restore automations'
		);
		const result = await ctx.db
			.query('automations')
			.withIndex('by_deleted_at', (q) => q.gte('deletedAt', 0))
			.order('desc')
			.paginate(args.paginationOpts);
		return {
			...result,
			// One the purge has started on is already partly gone.
			page: result.page
				.filter((automation) => automation.purgeStartedAt === undefined)
				.map((automation) => ({
					_id: automation._id,
					name: automation.name,
					status: automation.status,
					deletedAt: automation.deletedAt ?? 0,
					purgeAt: purgeAt(automation.deletedAt ?? 0),
				})),
		};
	},
});
