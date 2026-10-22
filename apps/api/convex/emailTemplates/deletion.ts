/**
 * Email template deletion — the one owner of a template's way into Recently
 * deleted, back out of it, and out of the database (`lib/softDelete.ts`). The
 * template lifecycle's `remove` delegates here.
 *
 * Delete stamps the row and takes it out of its listing bucket and out of the
 * usage counts of the saved blocks it links (the block library counts live
 * templates). The live co-editing session goes too, so an open editor stops
 * collaborating on a template that is no longer there. The row and its version
 * history stay, and a restore brings both back with the block usage.
 *
 * While a template is deleted, saved-block edits pass it by: it comes back
 * with the content it was deleted with, its links to blocks deleted meanwhile
 * detached and renamed blocks' names updated.
 *
 * The purge removes the row and its version history, which is what a delete
 * did before Recently deleted existed. Once it has removed part of the history
 * without finishing, the row is marked and can no longer be restored. Share
 * links keep their own snapshot. The delete already removed the co-editing
 * state, and no session can be opened on a deleted template.
 *
 * Both directions are idempotent: deleting a deleted template does not move
 * its retention clock or its counters, and restoring a live one is a no-op.
 */

import { paginationOptsValidator } from 'convex/server';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { authedQuery } from '../lib/authedFunctions';
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
import { throwNotFound } from '../_utils/errors';
import { applyUsageCountDelta, reconcileRestoredLinks } from '../emailBlocks/module';
import { deleteCoeditState } from '../emailCoediting/sweep';
import { deleteTemplateVersions } from './versions';

/** Move a template to Recently deleted. */
export async function softDeleteTemplate(
	ctx: MutationCtx,
	template: Doc<'emailTemplates'>,
	userId: string
): Promise<DeletionOutcome> {
	if (template.deletedAt !== undefined) return 'unchanged';

	const deletedAt = Date.now();
	await ctx.db.patch(template._id, { deletedAt, deletedBy: userId });
	await recordListingCounter(ctx, 'templateType', template, { ...template, deletedAt });
	await applyUsageCountDelta(ctx, template.linkedBlockIds ?? [], []);
	await deleteCoeditState(ctx, { type: 'emailTemplate', id: template._id });
	await recordAuditLog(ctx, {
		userId,
		action: 'email_template.deleted',
		resource: 'email_template',
		resourceId: template._id,
		details: { name: template.name, applied: 'transitioned' },
	});
	return 'changed';
}

/** Bring a template back from Recently deleted, as it was when it was deleted. */
export async function restoreTemplate(
	ctx: MutationCtx,
	templateId: Id<'emailTemplates'>,
	userId: string
): Promise<DeletionOutcome> {
	const template = await ctx.db.get(templateId);
	// Gone for good: the purge got to it first.
	if (!template) throwNotFound('Email template');
	if (template.deletedAt === undefined) return 'unchanged';
	assertRestorable(template);

	// Saved blocks deleted or renamed while the template was away never reached
	// it (propagation skips deleted templates); bring its links up to date.
	const links = await reconcileRestoredLinks(ctx, template);
	await ctx.db.patch(templateId, { deletedAt: undefined, deletedBy: undefined, ...links });
	await recordListingCounter(ctx, 'templateType', template, { ...template, deletedAt: undefined });
	await applyUsageCountDelta(ctx, [], links?.linkedBlockIds ?? template.linkedBlockIds ?? []);
	await recordAuditLog(ctx, {
		userId,
		action: 'email_template.restored',
		resource: 'email_template',
		resourceId: templateId,
		details: { name: template.name },
	});
	return 'changed';
}

/**
 * Permanently remove up to `limit` templates deleted before `cutoff`, oldest
 * first, each with its version history, within the purge transaction's shared
 * `budget`. A template whose history outruns the budget keeps its row, marked
 * so it can no longer be restored (it is still selected next time), and the
 * purge resumes where it stopped. `hasMore` tells the purge to come back for
 * the rest.
 */
export async function purgeExpiredTemplates(
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
				.query('emailTemplates')
				.withIndex('by_deleted_at_and_updated_at', (q) =>
					q.gte('deletedAt', 0).lt('deletedAt', cutoff)
				)
				.first(),
		async (template) => {
			budget.chargeRead(template);
			if (!(await deleteTemplateVersions(ctx, template._id, budget))) {
				if (template.purgeStartedAt === undefined) {
					await ctx.db.patch(template._id, { purgeStartedAt: Date.now() });
				}
				return false;
			}
			budget.charge(template);
			await ctx.db.delete(template._id);
			await recordAuditLog(ctx, {
				userId: RETENTION_PURGE_USER,
				action: 'email_template.purged',
				resource: 'email_template',
				resourceId: template._id,
				details: { name: template.name },
			});
			return true;
		}
	);
}

/**
 * The email templates in Recently deleted, most recently deleted first.
 * Restoring needs `templates:manage`, the permission a delete needs, so the
 * list does too.
 */
export const listDeleted = authedQuery({
	args: { paginationOpts: paginationOptsValidator },
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'templates:manage'),
			'Only owners and admins can restore email templates'
		);
		const result = await ctx.db
			.query('emailTemplates')
			.withIndex('by_deleted_at_and_updated_at', (q) => q.gte('deletedAt', 0))
			.order('desc')
			.paginate(args.paginationOpts);
		return {
			...result,
			// One the purge has started on is already partly gone.
			page: result.page
				.filter((template) => template.purgeStartedAt === undefined)
				.map((template) => ({
					_id: template._id,
					name: template.name,
					type: template.type,
					deletedAt: template.deletedAt ?? 0,
					purgeAt: purgeAt(template.deletedAt ?? 0),
				})),
		};
	},
});
