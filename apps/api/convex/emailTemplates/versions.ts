/**
 * Email template version history (Convex half) — the single writer, reader and
 * cascade-deleter of `emailTemplateVersions`.
 *
 * Capture sites (all of them):
 *   `emails.update`            → trigger `save`
 *   `emails.publish`           → trigger `publish`
 *   `campaigns/send.ts` PREP   → trigger `send` (via `captureForSend`)
 *
 * Restore is deliberately NOT a mutation here: the editor loads a snapshot into
 * its working state, where it becomes an ordinary undoable edit, and the next
 * save persists it through `emails.update` like any other change. That keeps
 * exactly one write path to `emailTemplates.content`.
 *
 * The dedupe/retention rules live in `versionSnapshot.ts` (pure, unit-tested).
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx, type QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { authedQuery } from '../lib/authedFunctions';
import { getOrThrow } from '../_utils/errors';
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
 * Drop a template's whole history. Called from the template lifecycle's
 * `remove` so a deleted template leaves no orphaned snapshots behind.
 */
export async function deleteTemplateVersions(
	ctx: MutationCtx,
	templateId: Id<'emailTemplates'>
): Promise<number> {
	const versions = await ctx.db
		.query('emailTemplateVersions')
		.withIndex('by_template_and_created_at', (q) => q.eq('templateId', templateId))
		.take(VERSION_HISTORY_LIMIT + VERSION_PRUNE_BATCH);
	for (const version of versions) {
		await ctx.db.delete(version._id);
	}
	return versions.length;
}

/**
 * Capture a `send` snapshot from an action (the campaign send orchestrator has
 * no `ctx.db`). Silently no-ops on a template that vanished mid-send —
 * recording history must never be able to fail a send.
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
export const list = authedQuery({
	args: { templateId: v.id('emailTemplates') },
	handler: async (ctx, args) => {
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

/** One snapshot with its content, for preview and restore. */
// all-members: same body as emails.get, scoped to one snapshot.
export const get = authedQuery({
	args: { versionId: v.id('emailTemplateVersions') },
	handler: async (ctx, args) => {
		return await getOrThrow(ctx, args.versionId, 'Template version');
	},
});
