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

import {
	childBlockLists,
	normalizeBlockTreeIds,
	ownedEntries,
	type BlockIdRenewal,
	type BlockTreeNode,
} from '@owlat/shared/blockTree';
import type { SavedBlockRef } from '@owlat/shared/types';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { nextContentRevision } from '../lib/contentRevision';
import { parseTranslations, serializeTranslations } from '../lib/emailTranslations';

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

type ConsumerRow = Doc<'emailTemplates'> | Doc<'transactionalEmails'>;

/** A transform's rewrite of one consumer row: its new blocks and the other fields to patch. */
export interface ConsumerRewrite {
	blocks: EditorBlock[];
	patch?: Partial<Pick<ConsumerRow, 'translations'>>;
}

type ConsumerTransform = (
	blocks: EditorBlock[],
	row: ConsumerRow
) => EditorBlock[] | ConsumerRewrite | null;

const asRewrite = (result: EditorBlock[] | ConsumerRewrite | null): ConsumerRewrite | null =>
	Array.isArray(result) ? { blocks: result } : result;

interface WalkResult {
	templateIds: Id<'emailTemplates'>[];
	transactionalIds: Id<'transactionalEmails'>[];
}

/**
 * Walk both consumer tables for every row whose `linkedBlockIds`
 * contains `blockId`. For each row, run the transform on its parsed
 * block list; if the transform returns a rewrite, patch the row with the
 * serialized content and the rewrite's own fields. `extraPatch` is merged
 * into every patched row (used by `propagate_content` to set
 * `htmlRenderState.stale: true` atomically with the content write; and by
 * `detach_all` to strip the `linkedBlockIds` array entry).
 */
export async function walkConsumers(
	ctx: MutationCtx,
	blockId: Id<'emailBlocks'>,
	transform: ConsumerTransform,
	extraPatch?: (row: ConsumerRow) => Record<string, unknown>
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

		const rewrite = asRewrite(transform(parseContentBlocks(template.content), template));
		if (!rewrite) continue;

		const patch: Record<string, unknown> = {
			content: serializeContentBlocks(rewrite.blocks),
			...rewrite.patch,
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

		const rewrite = asRewrite(transform(parseContentBlocks(email.content), email));
		if (!rewrite) continue;

		const patch: Record<string, unknown> = {
			content: serializeContentBlocks(rewrite.blocks),
			...rewrite.patch,
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
 * The id a Block or accordion section of a linked copy has: its id in the
 * saved block, scoped to the insertion it belongs to (`groupId`). Translation
 * overlays, link tracking and version diffs are keyed by Block id, so a copy
 * keeps the same ids every time a saved-block edit reaches it; the group id
 * keeps them unique when one saved block is linked twice in a document. Both
 * parts are generated ids, so the result is safe in an HTML id attribute
 * (accordion sections render their id as one).
 */
export function linkedCopyId(groupId: string, sourceId: string): string {
	return `${groupId}-${sourceId}`;
}

const treeNodes = (blocks: EditorBlock[]) => blocks as unknown as BlockTreeNode[];

/** The saved block's root Blocks; entries that are not Block-shaped are skipped. */
const savedBlockRoots = (content: string): EditorBlock[] =>
	parseContentBlocks(content).filter(
		(block) => typeof block?.id === 'string' && typeof block.type === 'string'
	);

/** Give `node` and everything nested in it its linked-copy id, in place. */
function applyLinkedCopyIds(node: BlockTreeNode, groupId: string): void {
	node.id = linkedCopyId(groupId, node.id);
	for (const entry of ownedEntries(node)) {
		entry['id'] = linkedCopyId(groupId, typeof entry['id'] === 'string' ? entry['id'] : '');
	}
	for (const list of childBlockLists(node)) {
		for (const child of list) applyLinkedCopyIds(child, groupId);
	}
}

/**
 * The renames that move a copy's Blocks to their linked-copy ids, for the
 * Blocks whose id is not one yet: copies inserted by the editor (fresh ids)
 * and copies an older propagation wrote (a fresh root id, the saved block's
 * own ids below it). A Block's source is the saved-block Block of the same
 * id when there is one, else the Block at the same place in the saved
 * block's previous content, which the copy was cloned from. `previous` is
 * empty when the copy's shape differs from that content (a template restored
 * from Recently deleted missed an edit), so a translation is never moved onto
 * a different Block. A Block with no source keeps its id and is replaced like
 * any other.
 */
function legacyCopyRenames(
	copy: BlockTreeNode[],
	previous: BlockTreeNode[],
	sourceIds: ReadonlySet<string>,
	groupId: string,
	renames: BlockIdRenewal[],
	sectionRenames: SectionRename[]
): void {
	for (const [index, node] of copy.entries()) {
		const counterpart = previous[index]?.type === node.type ? previous[index] : undefined;
		let blockId = node.id;
		if (!node.id.startsWith(`${groupId}-`)) {
			const source = sourceIds.has(node.id) ? node.id : counterpart?.id;
			if (source !== undefined) {
				blockId = linkedCopyId(groupId, source);
				renames.push({ from: node.id, to: blockId });
			}
		}
		// Accordion sections get linked-copy ids too, and a translation keys
		// their titles by section id: each one maps the same way as its Block.
		const counterpartEntries = counterpart ? ownedEntries(counterpart) : [];
		for (const [entryIndex, entry] of ownedEntries(node).entries()) {
			const id = entry['id'];
			if (typeof id !== 'string' || id.startsWith(`${groupId}-`)) continue;
			const cloned = counterpartEntries[entryIndex]?.['id'];
			const source = sourceIds.has(id) ? id : typeof cloned === 'string' ? cloned : null;
			if (source) sectionRenames.push({ blockId, from: id, to: linkedCopyId(groupId, source) });
		}
		const previousLists = counterpart ? childBlockLists(counterpart) : [];
		for (const [listIndex, list] of childBlockLists(node).entries()) {
			legacyCopyRenames(
				list,
				previousLists[listIndex] ?? [],
				sourceIds,
				groupId,
				renames,
				sectionRenames
			);
		}
	}
}

/**
 * A section id a copy's accordion changes, scoped to that accordion (its id
 * after the Block renames): two copies of one saved block can share a
 * section id, and each copy's translation follows only its own section.
 */
interface SectionRename extends BlockIdRenewal {
	blockId: string;
}

/** The tree's Block types and child lists, without ids or content. */
const treeShape = (nodes: BlockTreeNode[]): string =>
	nodes.map((node) => `${node.type}(${childBlockLists(node).map(treeShape).join('|')})`).join(',');

const hasOwn = (record: object, key: string): boolean =>
	Object.prototype.hasOwnProperty.call(record, key);

/** The ids of every Block and accordion section in `nodes`. */
function collectIds(nodes: BlockTreeNode[], ids: Set<string>): Set<string> {
	for (const node of nodes) {
		ids.add(node.id);
		for (const entry of ownedEntries(node)) {
			if (typeof entry['id'] === 'string') ids.add(entry['id']);
		}
		for (const list of childBlockLists(node)) collectIds(list, ids);
	}
	return ids;
}

/**
 * The row's `translations` with each renamed Block's overlay moved to its new
 * id in every language; undefined when nothing changes or the stored overlays
 * cannot be read (they are then left as they are). An id that is still in
 * the document keeps its own entry, so a Block another copy shares is not
 * stripped of its translation.
 */
function carryRenamedOverlays(
	translationsBlob: string | undefined,
	renames: readonly BlockIdRenewal[],
	sectionRenames: readonly SectionRename[],
	blocks: EditorBlock[]
): string | undefined {
	if ((renames.length === 0 && sectionRenames.length === 0) || !translationsBlob) {
		return undefined;
	}
	let translations: ReturnType<typeof parseTranslations>;
	try {
		translations = parseTranslations(translationsBlob);
	} catch {
		return undefined;
	}
	const kept = collectIds(treeNodes(blocks), new Set());
	let changed = false;
	for (const translation of Object.values(translations)) {
		const overlays = translation.blocks;
		if (!overlays) continue;
		for (const { from, to } of renames) {
			if (!kept.has(to) || !hasOwn(overlays, from) || hasOwn(overlays, to)) continue;
			overlays[to] = { ...overlays[from] };
			changed = true;
		}
		// Only a moved entry is removed: the overlay of a Block this edit
		// removed stays behind, as it does for every other removed Block.
		for (const { from, to } of renames) {
			if (kept.has(to) && !kept.has(from) && hasOwn(overlays, from)) {
				delete overlays[from];
				changed = true;
			}
		}
		for (const { blockId, from, to } of sectionRenames) {
			const entry = hasOwn(overlays, blockId) ? overlays[blockId] : undefined;
			const titles = entry?.sectionTitles;
			if (!entry || !titles || !kept.has(to) || !hasOwn(titles, from) || hasOwn(titles, to)) {
				continue;
			}
			const { [from]: title, ...others } = titles;
			entry.sectionTitles = { ...others, [to]: title as string };
			changed = true;
		}
	}
	return changed ? serializeTranslations(translations) : undefined;
}

/**
 * Replace each group of blocks referencing `savedBlockId` with a copy of the
 * saved block's `newContent` that has its linked-copy ids, preserving the
 * original `groupId` and the updated `blockName`. A Block that is still in the
 * saved block keeps its id, and with it its translation (an edited one keeps
 * the translation of its earlier text, as an edit in the template editor
 * does); a Block removed from the saved block leaves its overlay entry behind,
 * as deleting a Block in the editor does. `previousContent` is the saved
 * block's content before this edit: it maps the Blocks of copies whose ids
 * predate linked-copy ids, whose overlays move to the new ids. Returns null
 * when no group references the block (so the walker can skip the patch).
 */
export function replaceLinkedBlocks(
	emailBlocks: EditorBlock[],
	savedBlockId: string,
	previousContent: string,
	newContent: string,
	newName: string,
	translations?: string
): ConsumerRewrite | null {
	const groups = new Map<string, EditorBlock[]>();
	for (const block of emailBlocks) {
		if (block.savedBlockRef?.blockId === savedBlockId) {
			const { groupId } = block.savedBlockRef;
			groups.set(groupId, [...(groups.get(groupId) ?? []), block]);
		}
	}
	if (groups.size === 0) return null;

	const previousBlocks = savedBlockRoots(previousContent);
	const newBlocks = savedBlockRoots(newContent);

	const sourceIds = collectIds(
		treeNodes(newBlocks),
		collectIds(treeNodes(previousBlocks), new Set())
	);
	const renames: BlockIdRenewal[] = [];
	const sectionRenames: SectionRename[] = [];
	const previousShape = treeShape(treeNodes(previousBlocks));
	for (const [groupId, copy] of groups) {
		const clonedFrom = treeShape(treeNodes(copy)) === previousShape ? previousBlocks : [];
		legacyCopyRenames(
			treeNodes(copy),
			treeNodes(clonedFrom),
			sourceIds,
			groupId,
			renames,
			sectionRenames
		);
	}

	const result: EditorBlock[] = [];
	const processedGroups = new Set<string>();

	for (const block of emailBlocks) {
		if (block.savedBlockRef?.blockId === savedBlockId) {
			const groupId = block.savedBlockRef.groupId;
			if (!processedGroups.has(groupId)) {
				processedGroups.add(groupId);
				// Parsed again for each group: the ids are rewritten in place.
				for (const copy of savedBlockRoots(newContent)) {
					applyLinkedCopyIds(copy as unknown as BlockTreeNode, groupId);
					result.push({
						...copy,
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
	const carried = carryRenamedOverlays(translations, renames, sectionRenames, result);
	return carried === undefined
		? { blocks: result }
		: { blocks: result, patch: { translations: carried } };
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
