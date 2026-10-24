/**
 * Email template version history (Convex half) — the single writer, reader and
 * cascade-deleter of `emailTemplateVersions`.
 *
 * Capture sites (all of them):
 *   `emails.update`            → trigger `save`
 *   `emails.publish`           → trigger `publish`
 *   `campaigns/sendCommit.ts`  → trigger `send` (the send preparation commit,
 *                                for Variant B's template too in a content test)
 *   `emailCoediting/sessions.ts` → trigger `conflict` (a co-editor's change replaced)
 *
 * Restore is deliberately NOT a mutation here: the editor loads a snapshot into
 * its working state, where it becomes an ordinary undoable edit, and the next
 * save persists it through `emails.update` like any other change. That keeps
 * exactly one write path to `emailTemplates.content`.
 *
 * The dedupe/retention rules live in `versionSnapshot.ts` (pure, unit-tested).
 */

import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import type { Doc, Id } from '../_generated/dataModel';
import { authedQuery } from '../lib/authedFunctions';
import { getOrThrow, throwNotFound } from '../_utils/errors';
import { getLive } from '../lib/softDelete';
import type { ErasureBudget } from '../contacts/erasure/budget';
import {
	VERSION_HISTORY_LIMIT,
	VERSION_PRUNE_BATCH,
	fingerprintSnapshot,
	selectVersionsToEvict,
	shouldCaptureVersion,
	type TemplateVersionTrigger,
} from './versionSnapshot';

/** Newest snapshot for a template, or null when it has no history yet. */
async function latestVersion(
	ctx: QueryCtx,
	templateId: Id<'emailTemplates'>
): Promise<Doc<'emailTemplateVersions'> | null> {
	return await ctx.db
		.query('emailTemplateVersions')
		.withIndex('by_template_and_created_at', (q) => q.eq('templateId', templateId))
		.order('desc')
		.first();
}

/**
 * Snapshot a template, unless the previous snapshot already records the same
 * content under the same trigger. Returns the new row id, or null when the
 * capture was deduplicated away.
 *
 * Runs in the caller's transaction: a save that rolls back must not leave a
 * version row claiming content that was never stored.
 */
export async function captureTemplateVersion(
	ctx: MutationCtx,
	args: {
		template: Doc<'emailTemplates'>;
		trigger: TemplateVersionTrigger;
		userId: string;
	}
): Promise<Id<'emailTemplateVersions'> | null> {
	const { template, trigger, userId } = args;
	const fingerprint = fingerprintSnapshot({
		name: template.name,
		subject: template.subject,
		content: template.content,
	});

	const previous = await latestVersion(ctx, template._id);
	if (!shouldCaptureVersion(previous, { contentHash: fingerprint.contentHash, trigger })) {
		return null;
	}

	const versionId = await ctx.db.insert('emailTemplateVersions', {
		templateId: template._id,
		trigger,
		content: template.content,
		name: template.name,
		subject: template.subject,
		previewText: template.previewText,
		contentBlockVersion: template.contentBlockVersion,
		contentBytes: fingerprint.contentBytes,
		contentHash: fingerprint.contentHash,
		createdBy: userId,
		createdAt: Date.now(),
	});

	// Enforce retention. Steady state evicts one row; the read is bounded by
	// the cap plus a fixed slack batch, so it never scans the whole history.
	const retained = await ctx.db
		.query('emailTemplateVersions')
		.withIndex('by_template_and_created_at', (q) => q.eq('templateId', template._id))
		.order('desc')
		.take(VERSION_HISTORY_LIMIT + VERSION_PRUNE_BATCH);
	for (const stale of selectVersionsToEvict(retained)) {
		await ctx.db.delete(stale._id);
	}

	return versionId;
}

/**
 * Drop a template's history, as much of it as `budget` allows. True when none
 * is left. Called by the purge (`./deletion.ts`), which resumes a template
 * whose history outran one transaction.
 */
export async function deleteTemplateVersions(
	ctx: MutationCtx,
	templateId: Id<'emailTemplates'>,
	budget: ErasureBudget
): Promise<boolean> {
	while (!budget.isExhausted) {
		const chunk = budget.chunk();
		const versions = await ctx.db
			.query('emailTemplateVersions')
			.withIndex('by_template_and_created_at', (q) => q.eq('templateId', templateId))
			.take(chunk);
		for (const version of versions) {
			budget.charge(version);
			await ctx.db.delete(version._id);
		}
		if (versions.length < chunk) return true;
	}
	return false;
}

/**
 * Capture a `send` snapshot from an action. Silently no-ops on a template that
 * vanished mid-send — recording history must never be able to fail a send.
 * The send preparation now captures inside its own commit; this stays for
 * preparations the previous release still has in flight.
 */
export const captureForSend = internalMutation({
	args: {
		templateId: v.id('emailTemplates'),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<void> => {
		const template = await ctx.db.get(args.templateId);
		if (!template) return;
		await captureTemplateVersion(ctx, {
			template,
			trigger: 'send',
			userId: args.userId,
		});
	},
});

/**
 * Version history for one template, newest first. Metadata only — `content` is
 * the bulky half and is fetched per snapshot by `get` on preview/restore.
 */
// all-members: version history is exactly the template body every org member
// can already read via emails.get; the restore write is gated separately.
// A template in Recently deleted has no readable history, like its body.
export const list = authedQuery({
	args: { templateId: v.id('emailTemplates') },
	handler: async (ctx, args) => {
		if (!(await getLive(ctx, args.templateId))) return [];
		const versions = await ctx.db
			.query('emailTemplateVersions')
			.withIndex('by_template_and_created_at', (q) => q.eq('templateId', args.templateId))
			.order('desc')
			.take(VERSION_HISTORY_LIMIT);

		return versions.map((version) => ({
			_id: version._id,
			trigger: version.trigger,
			name: version.name,
			subject: version.subject,
			contentBytes: version.contentBytes,
			createdBy: version.createdBy,
			createdAt: version.createdAt,
		}));
	},
});

/**
 * One snapshot with its content, for preview and restore. A snapshot of a
 * template in Recently deleted reads as missing, like the template.
 */
// all-members: same body as emails.get, scoped to one snapshot.
export const get = authedQuery({
	args: { versionId: v.id('emailTemplateVersions') },
	handler: async (ctx, args) => {
		const version = await getOrThrow(ctx, args.versionId, 'Template version');
		if (!(await getLive(ctx, version.templateId))) throwNotFound('Template version');
		return version;
	},
});

/**
 * The newest `send` snapshot of a template, for the campaign review's "changed
 * since the last send": the body the template's most recent campaign send
 * started with (captured in that send's preparation commit, whichever campaign
 * it was), and whether the template still holds the same body, subject and
 * preview text.
 *
 * Null when the history holds no send: the template was never sent, or that
 * snapshot was evicted by the retention cap. The caller says so instead of
 * comparing against an older event. A template in Recently deleted reads as
 * having no history, like `list`.
 */
// all-members: the same snapshot `get` returns to every org member.
export const latestSend = authedQuery({
	args: { templateId: v.id('emailTemplates') },
	handler: async (ctx, args) => {
		const template = await getLive(ctx, args.templateId);
		if (!template) return null;
		const version = await ctx.db
			.query('emailTemplateVersions')
			.withIndex('by_template_and_trigger_and_created_at', (q) =>
				q.eq('templateId', args.templateId).eq('trigger', 'send')
			)
			.order('desc')
			.first();
		if (!version) return null;
		return {
			version: {
				_id: version._id,
				name: version.name,
				subject: version.subject,
				contentBytes: version.contentBytes,
				createdAt: version.createdAt,
			},
			unchanged:
				version.content === template.content &&
				version.subject === template.subject &&
				(version.previewText ?? '') === (template.previewText ?? ''),
		};
	},
});
