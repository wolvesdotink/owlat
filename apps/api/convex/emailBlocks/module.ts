/**
 * Saved block (module) — single writer of `emailBlocks` rows plus the
 * cross-cutting `emailBlocks.usageCount` denormalization.
 *
 * Owns:
 *   - every write to `emailBlocks` (insert + update + delete)
 *   - every update to `emailBlocks.usageCount` (called from both consumer
 *     lifecycles' `update_block_usage_counts` effect — the canonical path)
 *   - the propagation walker that touches consumer rows in
 *     `emailTemplates` + `transactionalEmails` after a saved-block content
 *     change (replaces nested blocks atomically with `htmlRenderState.stale:
 *     true`), name change (renames the embedded `savedBlockRef.blockName`),
 *     or delete (strips the `savedBlockRef` + `linkedBlockIds` entry).
 *
 * Not a lifecycle in the `status`-column sense — saved blocks have no
 * state machine. Mirrors the **Topic subscription (module)** shape: row
 * writes (create, update, duplicate, remove) emit a typed atomic effect
 * list. The walker is one private helper consumed by three effect handlers.
 *
 * Effects:
 *   audit_log                 — fires on every entry.
 *   propagate_content         — content + htmlRenderState.stale atomic
 *                               patches across consumer rows.
 *   propagate_name            — savedBlockRef.blockName patches only.
 *   detach_all                — content + linkedBlockIds strip on delete.
 *   schedule_rerender         — enqueues the rerender pool.
 *
 * See docs/adr/0023-saved-block-module.md.
 */

import { v } from 'convex/values';
import type { SavedBlockRef } from '@owlat/shared/types';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditLog, type AuditAction } from '../lib/auditLog';
import { rerenderBlocksPool } from './renderingPool';

// ─── Types ──────────────────────────────────────────────────────────────────

interface EditorBlock {
	id: string;
	type: string;
	content: unknown;
	savedBlockRef?: SavedBlockRef;
}

export type SavedBlockCreateOutcome = {
	ok: true;
	blockId: Id<'emailBlocks'>;
};

export type SavedBlockUpdateOutcome =
	| {
			ok: true;
			blockId: Id<'emailBlocks'>;
			contentChanged: boolean;
			nameChanged: boolean;
			descriptionChanged: boolean;
	  }
	| { ok: false; reason: 'block_not_found' };

export type SavedBlockDuplicateOutcome =
	| { ok: true; blockId: Id<'emailBlocks'> }
	| { ok: false; reason: 'block_not_found' };

export type SavedBlockRemoveOutcome =
	| { ok: true }
	| { ok: false; reason: 'block_not_found' };

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

// ─── Walker (canonical parseContentBlocks lives here) ───────────────────────

/**
 * Parse email content JSON into an array of EditorBlocks. Handles the
 * three content-JSON shapes that exist on disk: multi-block
 * `{ blocks: [...] }`, legacy bare array, and single-block
 * `{ type, content }`.
 *
 * Exported so the `'use node'` rerender action in `rendering.ts` can
 * reuse the canonical implementation rather than re-declare it.
 */
export function parseContentBlocks(contentJson: string): EditorBlock[] {
	try {
		const parsed = JSON.parse(contentJson);
		if (parsed?.blocks && Array.isArray(parsed.blocks)) {
			return parsed.blocks;
		}
		if (Array.isArray(parsed)) {
			return parsed;
		}
		if (parsed?.type && parsed?.content) {
			return [parsed];
		}
		return [];
	} catch {
		return [];
	}
}

function serializeContentBlocks(blocks: EditorBlock[]): string {
	return JSON.stringify(blocks);
}

interface WalkResult {
	templateIds: Id<'emailTemplates'>[];
	transactionalIds: Id<'transactionalEmails'>[];
}

/**
 * Walk both consumer tables for every row whose `linkedBlockIds`
 * contains `blockId`. For each row, run the transform on its parsed
 * block list; if the transform returns a non-null array, patch the row
 * with the serialized content. `extraPatch` is merged into every patched
 * row (used by `propagate_content` to set `htmlRenderState.stale: true`
 * atomically with the content write; and by `detach_all` to strip the
 * `linkedBlockIds` array entry).
 */
async function walkConsumers(
	ctx: MutationCtx,
	blockId: Id<'emailBlocks'>,
	transform: (blocks: EditorBlock[]) => EditorBlock[] | null,
	extraPatch?: (
		row: Doc<'emailTemplates'> | Doc<'transactionalEmails'>,
	) => Record<string, unknown>,
): Promise<WalkResult> {
	const templateIds: Id<'emailTemplates'>[] = [];
	const transactionalIds: Id<'transactionalEmails'>[] = [];
	const now = Date.now();

	// bounded: emailTemplates is intrinsically small (one row per saved
	// template). Convex doesn't natively index array fields; an
	// `emailBlockConsumers` sidecar is listed as follow-up in ADR-0023.
	const templates = await ctx.db.query('emailTemplates').collect(); // bounded: email templates (org-scale library)
	for (const template of templates) {
		const linkedBlockIds = template.linkedBlockIds ?? [];
		if (!linkedBlockIds.includes(blockId)) continue;

		const blocks = parseContentBlocks(template.content);
		const updated = transform(blocks);
		if (!updated) continue;

		const patch: Record<string, unknown> = {
			content: serializeContentBlocks(updated),
			updatedAt: now,
			...extraPatch?.(template),
		};
		await ctx.db.patch(template._id, patch as Partial<Doc<'emailTemplates'>>);
		templateIds.push(template._id);
	}

	// bounded: transactionalEmails is intrinsically small (one row per
	// per-instance transactional template).
	const transactionalEmails = await ctx.db.query('transactionalEmails').collect(); // bounded: transactional-email templates (org-scale library)
	for (const email of transactionalEmails) {
		const linkedBlockIds = email.linkedBlockIds ?? [];
		if (!linkedBlockIds.includes(blockId)) continue;

		const blocks = parseContentBlocks(email.content);
		const updated = transform(blocks);
		if (!updated) continue;

		const patch: Record<string, unknown> = {
			content: serializeContentBlocks(updated),
			updatedAt: now,
			...extraPatch?.(email),
		};
		await ctx.db.patch(email._id, patch as Partial<Doc<'transactionalEmails'>>);
		transactionalIds.push(email._id);
	}

	return { templateIds, transactionalIds };
}

/**
 * Replace each group of blocks referencing `savedBlockId` with a freshly
 * cloned copy of `newBlocks`, preserving the original `groupId` and the
 * updated `blockName`. Returns null when no group references the block
 * (so the walker can skip the patch).
 */
function replaceLinkedBlocks(
	emailBlocks: EditorBlock[],
	savedBlockId: string,
	newBlocks: EditorBlock[],
	newName: string,
): EditorBlock[] | null {
	const groupIds = new Set<string>();
	for (const block of emailBlocks) {
		if (block.savedBlockRef?.blockId === savedBlockId) {
			groupIds.add(block.savedBlockRef.groupId);
		}
	}
	if (groupIds.size === 0) return null;

	const result: EditorBlock[] = [];
	const processedGroups = new Set<string>();

	for (const block of emailBlocks) {
		if (block.savedBlockRef?.blockId === savedBlockId) {
			const groupId = block.savedBlockRef.groupId;
			if (!processedGroups.has(groupId)) {
				processedGroups.add(groupId);
				for (const newBlock of newBlocks) {
					result.push({
						...JSON.parse(JSON.stringify(newBlock)),
						id: `block_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
						savedBlockRef: {
							blockId: savedBlockId,
							groupId,
							blockName: newName,
						},
					});
				}
			}
		} else {
			result.push(block);
		}
	}
	return result;
}

function renameLinkedBlocks(
	emailBlocks: EditorBlock[],
	savedBlockId: string,
	newName: string,
): EditorBlock[] | null {
	let changed = false;
	for (const block of emailBlocks) {
		if (block.savedBlockRef?.blockId === savedBlockId) {
			block.savedBlockRef.blockName = newName;
			changed = true;
		}
	}
	return changed ? emailBlocks : null;
}

function detachLinkedBlocks(
	emailBlocks: EditorBlock[],
	savedBlockId: string,
): EditorBlock[] | null {
	let changed = false;
	for (const block of emailBlocks) {
		if (block.savedBlockRef?.blockId === savedBlockId) {
			delete block.savedBlockRef;
			changed = true;
		}
	}
	return changed ? emailBlocks : null;
}

// ─── Effect runner ──────────────────────────────────────────────────────────

async function applyEffects(
	ctx: MutationCtx,
	effects: ReadonlyArray<Effect>,
): Promise<void> {
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
					(blocks) =>
						replaceLinkedBlocks(blocks, effect.blockId, newBlocks, effect.newName),
					() => ({
						htmlRenderState: { stale: true, failureCount: 0 },
					}),
				);
				if (
					walked.templateIds.length > 0 ||
					walked.transactionalIds.length > 0
				) {
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
					renameLinkedBlocks(blocks, effect.blockId, effect.newName),
				);
				break;
			}
			case 'detach_all': {
				await walkConsumers(
					ctx,
					effect.blockId,
					(blocks) => detachLinkedBlocks(blocks, effect.blockId),
					(row) => ({
						linkedBlockIds: (row.linkedBlockIds ?? []).filter(
							(id) => id !== effect.blockId,
						),
					}),
				);
				break;
			}
			case 'schedule_rerender': {
				// Enqueue into the saved-block rerender pool. Unlike the
				// pre-ADR-0023 `ctx.scheduler.runAfter` fire-and-forget,
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
					},
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
			content: args.content,
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

		const contentChanged =
			args.patch.content !== undefined && args.patch.content !== block.content;
		const nameChanged =
			args.patch.name !== undefined &&
			args.patch.name.trim() !== block.name;
		const descriptionChanged =
			args.patch.description !== undefined &&
			args.patch.description.trim() !== (block.description ?? '');

		const now = Date.now();
		const rowPatch: Partial<Doc<'emailBlocks'>> = { updatedAt: now };
		if (args.patch.name !== undefined) rowPatch.name = args.patch.name.trim();
		if (args.patch.description !== undefined)
			rowPatch.description = args.patch.description.trim();
		if (args.patch.content !== undefined) rowPatch.content = args.patch.content;

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
			content: block.content,
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
 * Cross-cutting entry for the **Email template lifecycle (module)** and
 * **Transactional email lifecycle (module)** `update_block_usage_counts`
 * effect. Single writer of `emailBlocks.usageCount`. Increments for
 * newly-added ids; decrements for newly-removed ids (floored at zero).
 *
 * Pre-ADR-0023 this helper lived in `lib/linkedBlockPropagation.ts` and
 * was also called open-coded from `emailTemplates/emails.ts:108` and
 * `transactional/emails.ts:252`; those direct call sites are now closed,
 * and the lifecycles route through this module.
 */
export const updateBlockUsageCounts = internalMutation({
	args: {
		previousIds: v.array(v.string()),
		nextIds: v.array(v.string()),
	},
	handler: async (ctx, args): Promise<void> => {
		await applyUsageCountDelta(ctx, args.previousIds, args.nextIds);
	},
});

/**
 * In-module helper for callers running inside another mutation. The
 * lifecycle modules call this directly (rather than going through
 * `ctx.runMutation`) so the count update is part of the same
 * transaction as the row write.
 */
export async function applyUsageCountDelta(
	ctx: MutationCtx,
	previousIds: ReadonlyArray<string>,
	nextIds: ReadonlyArray<string>,
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
