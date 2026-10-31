/**
 * Saved block (module) — single writer of `emailBlocks` rows plus the
 * cross-cutting `emailBlocks.usageCount` denormalization.
 *
 * Owns:
 *   - every write to `emailBlocks` (insert + update + delete)
 *   - every update to `emailBlocks.usageCount` (called from both consumer
 *     lifecycles' `update_block_usage_counts` effect — the canonical path)
 *   - the propagation walker (`emailBlocks/consumers.ts`, run only from
 *     this module's effects) that touches consumer rows in
 *     `emailTemplates` (live ones; `reconcileRestoredLinks` catches up a
 *     restored one) + `transactionalEmails` after a saved-block content
 *     change (replaces nested blocks atomically with `htmlRenderState.stale:
 *     true`), name change (renames the embedded `savedBlockRef.blockName`),
 *     or delete (strips the `savedBlockRef` + `linkedBlockIds` entry).
 *
 * Not a lifecycle in the `status`-column sense — saved blocks have no
 * state machine. Mirrors the **Topic subscription (module)** shape: row
 * writes (create, update, duplicate, remove) emit a typed atomic effect
 * list. The walker is one helper consumed by three effect handlers.
 *
 * Effects:
 *   audit_log                 — fires on every entry.
 *   propagate_content         — content + htmlRenderState.stale atomic
 *                               patches across consumer rows.
 *   propagate_name            — savedBlockRef.blockName patches only.
 *   detach_all                — content + linkedBlockIds strip on delete.
 *   schedule_rerender         — enqueues the rerender pool.
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditLog, type AuditAction } from '../lib/auditLog';
import { rerenderBlocksPool } from './renderingPool';
import { sanitizeStoredBlocksJson } from '../lib/emailContentSanitize';
import {
	detachLinkedBlocks,
	parseContentBlocks,
	renameLinkedBlocks,
	replaceLinkedBlocks,
	walkConsumers,
} from './consumers';

// ─── Types ──────────────────────────────────────────────────────────────────

type SavedBlockCreateOutcome = {
	ok: true;
	blockId: Id<'emailBlocks'>;
};

type SavedBlockUpdateOutcome =
	| {
			ok: true;
			blockId: Id<'emailBlocks'>;
			contentChanged: boolean;
			nameChanged: boolean;
			descriptionChanged: boolean;
	  }
	| { ok: false; reason: 'block_not_found' };

type SavedBlockDuplicateOutcome =
	| { ok: true; blockId: Id<'emailBlocks'> }
	| { ok: false; reason: 'block_not_found' };

type SavedBlockRemoveOutcome = { ok: true } | { ok: false; reason: 'block_not_found' };

// ─── Effects ────────────────────────────────────────────────────────────────

type Effect =
	| {
			kind: 'audit_log';
			action: AuditAction;
			blockId: Id<'emailBlocks'>;
			userId: string;
			details: Record<string, string | number | boolean | null>;
	  }
	| {
			kind: 'propagate_content';
			blockId: Id<'emailBlocks'>;
			newContent: string;
			newName: string;
	  }
	| {
			kind: 'propagate_name';
			blockId: Id<'emailBlocks'>;
			newName: string;
	  }
	| {
			kind: 'detach_all';
			blockId: Id<'emailBlocks'>;
	  }
	| {
			kind: 'schedule_rerender';
			templateIds: Id<'emailTemplates'>[];
			transactionalIds: Id<'transactionalEmails'>[];
	  };

// ─── Effect runner ──────────────────────────────────────────────────────────

async function applyEffects(ctx: MutationCtx, effects: ReadonlyArray<Effect>): Promise<void> {
	for (const effect of effects) {
		switch (effect.kind) {
			case 'audit_log': {
				await recordAuditLog(ctx, {
					userId: effect.userId,
					action: effect.action,
					resource: 'email_block',
					resourceId: effect.blockId,
					details: effect.details,
				});
				break;
			}
			case 'propagate_content': {
				const newBlocks = parseContentBlocks(effect.newContent);
				const walked = await walkConsumers(
					ctx,
					effect.blockId,
					(blocks) => replaceLinkedBlocks(blocks, effect.blockId, newBlocks, effect.newName),
					() => ({
						htmlRenderState: { stale: true, failureCount: 0 },
					})
				);
				if (walked.templateIds.length > 0 || walked.transactionalIds.length > 0) {
					// `schedule_rerender` is dispatched immediately so the pool
					// kicks off once we know which consumers were touched.
					await applyEffects(ctx, [
						{
							kind: 'schedule_rerender',
							templateIds: walked.templateIds,
							transactionalIds: walked.transactionalIds,
						},
					]);
				}
				break;
			}
			case 'propagate_name': {
				await walkConsumers(ctx, effect.blockId, (blocks) =>
					renameLinkedBlocks(blocks, effect.blockId, effect.newName)
				);
				break;
			}
			case 'detach_all': {
				await walkConsumers(
					ctx,
					effect.blockId,
					(blocks) => detachLinkedBlocks(blocks, effect.blockId),
					(row) => ({
						linkedBlockIds: (row.linkedBlockIds ?? []).filter((id) => id !== effect.blockId),
					})
				);
				break;
			}
			case 'schedule_rerender': {
				// Enqueue into the saved-block rerender pool. Unlike the
				// old `ctx.scheduler.runAfter` fire-and-forget,
				// failures retry with backoff and the `onComplete` callback
				// records terminal-failure bookkeeping on the consumer rows.
				await rerenderBlocksPool.enqueueAction(
					ctx,
					internal.emailBlocks.rendering.reRenderEmails,
					{
						templateIds: effect.templateIds,
						transactionalIds: effect.transactionalIds,
					},
					{
						onComplete: internal.emailBlocks.renderingPool.onRerenderComplete,
						context: {
							templateIds: effect.templateIds,
							transactionalIds: effect.transactionalIds,
						},
					}
				);
				break;
			}
		}
	}
}

// ─── Public entry points ────────────────────────────────────────────────────

/**
 * Insert a new `emailBlocks` row at `usageCount: 0`. Emits
 * `email_block.created` audit.
 */
export const create = internalMutation({
	args: {
		name: v.string(),
		description: v.optional(v.string()),
		content: v.string(),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<SavedBlockCreateOutcome> => {
		const now = Date.now();
		const blockId = await ctx.db.insert('emailBlocks', {
			name: args.name.trim(),
			description: args.description?.trim(),
			content: sanitizeStoredBlocksJson(args.content),
			usageCount: 0,
			createdAt: now,
			updatedAt: now,
		});

		await applyEffects(ctx, [
			{
				kind: 'audit_log',
				action: 'email_block.created',
				blockId,
				userId: args.userId,
				details: {
					name: args.name.trim(),
				},
			},
		]);

		return { ok: true, blockId };
	},
});

/**
 * Patch one or more of `name`/`description`/`content` on an
 * `emailBlocks` row. The effect list depends on which fields changed:
 *   - content changed → propagate_content + audit_log (propagate enqueues rerender)
 *   - name changed (only) → propagate_name + audit_log
 *   - description-only → audit_log
 *
 * `propagate_content` writes both the new content JSON and
 * `htmlRenderState: { stale: true, failureCount: 0 }` to every consumer
 * row in a single patch — those two writes are atomic.
 */
export const update = internalMutation({
	args: {
		blockId: v.id('emailBlocks'),
		patch: v.object({
			name: v.optional(v.string()),
			description: v.optional(v.string()),
			content: v.optional(v.string()),
		}),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<SavedBlockUpdateOutcome> => {
		const block = await ctx.db.get(args.blockId);
		if (!block) return { ok: false, reason: 'block_not_found' };

		const content = sanitizeStoredBlocksJson(args.patch.content);
		const contentChanged = content !== undefined && content !== block.content;
		const nameChanged = args.patch.name !== undefined && args.patch.name.trim() !== block.name;
		const descriptionChanged =
			args.patch.description !== undefined &&
			args.patch.description.trim() !== (block.description ?? '');

		const now = Date.now();
		const rowPatch: Partial<Doc<'emailBlocks'>> = { updatedAt: now };
		if (args.patch.name !== undefined) rowPatch.name = args.patch.name.trim();
		if (args.patch.description !== undefined) rowPatch.description = args.patch.description.trim();
		if (content !== undefined) rowPatch.content = content;

		await ctx.db.patch(args.blockId, rowPatch);

		const effects: Effect[] = [];
		const newName = rowPatch.name ?? block.name;

		if (contentChanged) {
			effects.push({
				kind: 'propagate_content',
				blockId: args.blockId,
				newContent: rowPatch.content ?? block.content,
				newName,
			});
		} else if (nameChanged) {
			effects.push({
				kind: 'propagate_name',
				blockId: args.blockId,
				newName,
			});
		}

		effects.push({
			kind: 'audit_log',
			action: 'email_block.updated',
			blockId: args.blockId,
			userId: args.userId,
			details: {
				contentChanged,
				nameChanged,
				descriptionChanged,
			},
		});

		await applyEffects(ctx, effects);

		return {
			ok: true,
			blockId: args.blockId,
			contentChanged,
			nameChanged,
			descriptionChanged,
		};
	},
});

/**
 * Clone an `emailBlocks` row with `name → "<n> (Copy)"` and
 * `usageCount: 0`. Emits `email_block.duplicated`.
 */
export const duplicate = internalMutation({
	args: {
		blockId: v.id('emailBlocks'),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<SavedBlockDuplicateOutcome> => {
		const block = await ctx.db.get(args.blockId);
		if (!block) return { ok: false, reason: 'block_not_found' };

		const now = Date.now();
		const newName = `${block.name} (Copy)`;
		const newId = await ctx.db.insert('emailBlocks', {
			name: newName,
			description: block.description,
			content: sanitizeStoredBlocksJson(block.content),
			usageCount: 0,
			createdAt: now,
			updatedAt: now,
		});

		await applyEffects(ctx, [
			{
				kind: 'audit_log',
				action: 'email_block.duplicated',
				blockId: newId,
				userId: args.userId,
				details: {
					sourceBlockId: args.blockId,
					name: newName,
				},
			},
		]);

		return { ok: true, blockId: newId };
	},
});

/**
 * Delete an `emailBlocks` row. Detaches the block from every consumer
 * row first (strips `savedBlockRef` annotations and removes the entry
 * from `linkedBlockIds`), then deletes the row. Emits
 * `email_block.deleted`.
 */
export const remove = internalMutation({
	args: {
		blockId: v.id('emailBlocks'),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<SavedBlockRemoveOutcome> => {
		const block = await ctx.db.get(args.blockId);
		if (!block) return { ok: false, reason: 'block_not_found' };

		const name = block.name;

		await applyEffects(ctx, [
			{ kind: 'detach_all', blockId: args.blockId },
			{
				kind: 'audit_log',
				action: 'email_block.deleted',
				blockId: args.blockId,
				userId: args.userId,
				details: { name },
			},
		]);

		await ctx.db.delete(args.blockId);

		return { ok: true };
	},
});

/**
 * Cross-cutting helper for the **Email template lifecycle (module)** and
 * **Transactional email lifecycle (module)** `update_block_usage_counts`
 * effect. This is the single implementation of `emailBlocks.usageCount`
 * deltas: increments for newly-added ids and decrements for newly-removed ids
 * (floored at zero).
 *
 * The lifecycle modules call this directly from their mutations so the count
 * update is atomic with the consumer row write. The former
 * `updateBlockUsageCounts` Convex mutation only delegated here and had no
 * production caller, so it was removed under the entry-wiring debt tracked by
 * issue #528.
 */
export async function applyUsageCountDelta(
	ctx: MutationCtx,
	previousIds: ReadonlyArray<string>,
	nextIds: ReadonlyArray<string>
): Promise<void> {
	const previousSet = new Set(previousIds);
	const nextSet = new Set(nextIds);

	for (const blockId of nextIds) {
		if (previousSet.has(blockId)) continue;
		const block = await ctx.db.get(blockId as Id<'emailBlocks'>);
		if (block) {
			await ctx.db.patch(block._id, { usageCount: block.usageCount + 1 });
		}
	}

	for (const blockId of previousIds) {
		if (nextSet.has(blockId)) continue;
		const block = await ctx.db.get(blockId as Id<'emailBlocks'>);
		if (block) {
			await ctx.db.patch(block._id, {
				usageCount: Math.max(0, block.usageCount - 1),
			});
		}
	}
}
