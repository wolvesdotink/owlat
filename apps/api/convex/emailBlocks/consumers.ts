/**
 * Saved block consumers: the stored content of the templates and
 * transactional emails that embed a saved block, and the walker that rewrites
 * them. The walker's only caller is the effect runner in
 * `emailBlocks/module.ts`, so every consumer write starts from one of that
 * module's typed effects.
 *
 *   - `parseContentBlocks` is the canonical reader of the content-JSON shapes
 *     on disk;
 *   - `walkConsumers` patches every live consumer row linked to a block;
 *   - the `…LinkedBlocks` transforms are what the effects apply to each row;
 *   - `reconcileRestoredLinks` catches up a template restored from Recently
 *     deleted, which the walker passed by.
 */

import { normalizeBlockTreeIds } from '@owlat/shared/blockTree';
import type { SavedBlockRef } from '@owlat/shared/types';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { nextContentRevision } from '../lib/contentRevision';

interface EditorBlock {
	id: string;
	type: string;
	content: unknown;
	savedBlockRef?: SavedBlockRef;
}

// ─── Walker (canonical parseContentBlocks lives here) ───────────────────────

/**
 * Parse email content JSON into an array of EditorBlocks. Handles the
 * three content-JSON shapes that exist on disk: multi-block
 * `{ blocks: [...] }`, legacy bare array, and single-block
 * `{ type, content }`.
 *
 * A Block or accordion section without an id (legacy content never had one)
 * gets one, the same deterministic id the editor's `parseStoredBlocks`
 * gives it, so the renderer never meets an id-less Block and a
 * translation overlay keyed by that id applies here too. Repeated ids are
 * kept: renewing one on read would detach the copy from the overlay it
 * shares without anything being written.
 *
 * Exported so the `'use node'` rerender action in `rendering.ts` can
 * reuse the canonical implementation rather than re-declare it.
 */
export function parseContentBlocks(contentJson: string): EditorBlock[] {
	try {
		return normalizeBlockTreeIds(contentEntries(JSON.parse(contentJson)));
	} catch {
		return [];
	}
}

/** The stored entry list for whichever content shape `parsed` is. */
function contentEntries(parsed: { blocks?: unknown; type?: unknown; content?: unknown } | null) {
	if (parsed?.blocks && Array.isArray(parsed.blocks)) {
		return parsed.blocks as EditorBlock[];
	}
	if (Array.isArray(parsed)) {
		return parsed as EditorBlock[];
	}
	if (parsed?.type && parsed?.content) {
		return [parsed as EditorBlock];
	}
	return [];
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
export async function walkConsumers(
	ctx: MutationCtx,
	blockId: Id<'emailBlocks'>,
	transform: (blocks: EditorBlock[]) => EditorBlock[] | null,
	extraPatch?: (row: Doc<'emailTemplates'> | Doc<'transactionalEmails'>) => Record<string, unknown>
): Promise<WalkResult> {
	const templateIds: Id<'emailTemplates'>[] = [];
	const transactionalIds: Id<'transactionalEmails'>[] = [];
	const now = Date.now();

	// bounded: emailTemplates is intrinsically small (one row per saved
	// template). Convex doesn't natively index array fields; an
	// `emailBlockConsumers` sidecar is a possible follow-up.
	const templates = await ctx.db.query('emailTemplates').collect(); // bounded: email templates (org-scale library)
	for (const template of templates) {
		// A template in Recently deleted keeps the content it was deleted with;
		// `reconcileRestoredLinks` catches it up when it is restored.
		if (template.deletedAt !== undefined) continue;
		const linkedBlockIds = template.linkedBlockIds ?? [];
		if (!linkedBlockIds.includes(blockId)) continue;

		const blocks = parseContentBlocks(template.content);
		const updated = transform(blocks);
		if (!updated) continue;

		const patch: Record<string, unknown> = {
			content: serializeContentBlocks(updated),
			// The content changed under any open editor: its draft is now stale.
			contentRevision: nextContentRevision(template),
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
			// The content changed under any open editor: its draft is now stale.
			contentRevision: nextContentRevision(email),
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
export function replaceLinkedBlocks(
	emailBlocks: EditorBlock[],
	savedBlockId: string,
	newBlocks: EditorBlock[],
	newName: string
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

export function renameLinkedBlocks(
	emailBlocks: EditorBlock[],
	savedBlockId: string,
	newName: string
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

export function detachLinkedBlocks(
	emailBlocks: EditorBlock[],
	savedBlockId: string
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

/**
 * The link changes a template restored from Recently deleted missed while the
 * walker passed it by: references to saved blocks deleted meanwhile are
 * detached (`savedBlockRef` and `linkedBlockIds` entry, as `detach_all` does)
 * and renamed blocks' names updated. Content edits to a block are not applied:
 * the template comes back as it was deleted, and the next edit of the block
 * reaches it like any other consumer. Returns the patch, or undefined when
 * nothing changed. The caller applies the usage counts of the kept links.
 */
export async function reconcileRestoredLinks(
	ctx: MutationCtx,
	template: Doc<'emailTemplates'>
): Promise<
	| Pick<Doc<'emailTemplates'>, 'content' | 'linkedBlockIds' | 'contentRevision' | 'updatedAt'>
	| undefined
> {
	const linkedBlockIds = template.linkedBlockIds ?? [];
	if (linkedBlockIds.length === 0) return undefined;
	const names = new Map<string, string | null>();
	for (const blockId of linkedBlockIds) {
		names.set(blockId, (await ctx.db.get(blockId as Id<'emailBlocks'>))?.name ?? null);
	}

	const blocks = parseContentBlocks(template.content);
	let changed = false;
	for (const block of blocks) {
		const ref = block.savedBlockRef;
		if (!ref || !names.has(ref.blockId)) continue;
		const name = names.get(ref.blockId);
		if (name === null) {
			delete block.savedBlockRef;
			changed = true;
		} else if (name !== undefined && name !== ref.blockName) {
			ref.blockName = name;
			changed = true;
		}
	}
	const kept = linkedBlockIds.filter((id) => names.get(id) !== null);
	if (!changed && kept.length === linkedBlockIds.length) return undefined;
	return {
		content: changed ? serializeContentBlocks(blocks) : template.content,
		linkedBlockIds: kept,
		contentRevision: changed ? nextContentRevision(template) : template.contentRevision,
		updatedAt: Date.now(),
	};
}
