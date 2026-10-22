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
 * did before Recently deleted existed. Runs and step runs are per-contact
 * history and keep their policy (contact erasure owns their removal).
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
import { purgeAt, RETENTION_PURGE_USER, type DeletionOutcome } from '../lib/softDelete';
import { throwInvalidState, throwNotFound } from '../_utils/errors';

/** Steps deleted per transaction while purging; an automation has a handful. */
const STEP_PURGE_BATCH = 200;

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
 * Permanently remove up to `limit` automations deleted before `cutoff`, oldest
 * first, each with its steps. An automation whose steps outrun one batch keeps
 * its row (it is still selected next time), so the purge resumes where it
 * stopped. `hasMore` tells the purge to come back for the rest.
 */
export async function purgeExpiredAutomations(
	ctx: MutationCtx,
	cutoff: number,
	limit: number
): Promise<{ purged: number; hasMore: boolean }> {
	const expired = await ctx.db
		.query('automations')
		.withIndex('by_deleted_at', (q) => q.gte('deletedAt', 0).lt('deletedAt', cutoff))
		.take(limit + 1);
	let purged = 0;
	for (const automation of expired.slice(0, limit)) {
		const steps = await ctx.db
			.query('automationSteps')
			.withIndex('by_automation', (q) => q.eq('automationId', automation._id))
			.take(STEP_PURGE_BATCH + 1);
		for (const step of steps.slice(0, STEP_PURGE_BATCH)) await ctx.db.delete(step._id);
		if (steps.length > STEP_PURGE_BATCH) return { purged, hasMore: true };

		await ctx.db.delete(automation._id);
		await recordAuditLog(ctx, {
			userId: RETENTION_PURGE_USER,
			action: 'automation.purged',
			resource: 'automation',
			resourceId: automation._id,
			details: { name: automation.name },
		});
		purged += 1;
	}
	return { purged, hasMore: expired.length > limit };
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
			page: result.page.map((automation) => ({
				_id: automation._id,
				name: automation.name,
				status: automation.status,
				deletedAt: automation.deletedAt ?? 0,
				purgeAt: purgeAt(automation.deletedAt ?? 0),
			})),
		};
	},
});
