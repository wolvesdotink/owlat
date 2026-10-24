/**
 * Compare two versions of an email template, Block by Block.
 *
 * `diffEmails` (`./diff.ts`) compares rendered HTML and loses which Block a
 * change came from. This works on the Block tree instead: Blocks are matched
 * by id at any depth, and each one is reported as added, removed, edited or
 * moved, with the copy and link changes it carries. The result is plain data;
 * the caller words it, and hands `outlines` to the renderer (`diffOutlines`)
 * to mark the changed Blocks in a side-by-side preview.
 *
 * Both sides are id-normalized first, the way the editor loads a document
 * (`normalizeBlockTreeIds` with `renewRepeated`): a Block without an id, or a
 * repeat of an id used earlier, gets the same deterministic id the editor
 * would give it. The normalized trees are returned, so a preview rendered from
 * them carries the ids `outlines` is keyed by.
 */

import {
	childBlockLists,
	normalizeBlockTreeIds,
	type BlockTreeNode,
} from '@owlat/shared/blockTree';
import {
	commonSubsequence,
	diffSequence,
	readOwnFields,
	type OwnFields,
	type SequenceStep,
} from './templateDiffFields';
import type { BlockChangeKind } from './types';

/** One version of a template, as far as the comparison reads it. */
export interface TemplateDiffSide<N extends BlockTreeNode = BlockTreeNode> {
	blocks: readonly N[];
	subject?: string;
	previewText?: string;
}

export interface BlockChange {
	id: string;
	type: string;
	kind: BlockChangeKind;
	/** An edited Block that also changed place. */
	moved: boolean;
	/** For an edited Block: which parts of it changed. */
	parts: { copy: boolean; links: boolean; other: boolean };
	/** The Block's first piece of copy, to recognise it by; '' when it has none. */
	excerpt: string;
}

/** A copy or link change inside one Block. `field` is the content path, indices dropped. */
export type FieldChange = SequenceStep & { blockId: string; blockType: string; field: string };

export interface MetaChange {
	field: 'subject' | 'previewText';
	before: string;
	after: string;
}

export interface TemplateDiff<N extends BlockTreeNode = BlockTreeNode> {
	/** Nothing the comparison reads differs. */
	identical: boolean;
	meta: MetaChange[];
	/** Changed Blocks in document order: the newer side first, then what it removed. */
	blocks: BlockChange[];
	copy: FieldChange[];
	links: FieldChange[];
	/** Per side, the changed Blocks by id, for the renderer's `diffOutlines`. */
	outlines: { before: Record<string, BlockChangeKind>; after: Record<string, BlockChangeKind> };
	/** The id-normalized trees the ids above refer to. */
	trees: { before: N[]; after: N[] };
}

interface Placed<N extends BlockTreeNode> {
	node: N;
	/** The child list holding the Block: `''` for the root, else `<parent id>/<list index>`. */
	list: string;
	fields: OwnFields;
}

/** Every Block of `roots`, in document order, keyed by its (now unique) id. */
function place<N extends BlockTreeNode>(roots: readonly N[]): Map<string, Placed<N>> {
	const placed = new Map<string, Placed<N>>();
	const walk = (nodes: readonly N[], list: string) => {
		for (const node of nodes) {
			// A repeat cannot survive normalization; the guard keeps a malformed
			// tree from silently replacing the first occurrence.
			if (placed.has(node.id)) continue;
			placed.set(node.id, { node, list, fields: readOwnFields(node) });
			for (const [index, children] of childBlockLists(node).entries()) {
				walk(children, `${node.id}/${index}`);
			}
		}
	};
	walk(roots, '');
	return placed;
}

const sameType = (a: Placed<BlockTreeNode>, b: Placed<BlockTreeNode>): boolean =>
	a.node.type === b.node.type;

/**
 * The Blocks that changed place: a different parent list, or out of order
 * among the siblings both versions share (whatever is not on their longest
 * common subsequence).
 */
function movedIds<N extends BlockTreeNode>(
	before: Map<string, Placed<N>>,
	after: Map<string, Placed<N>>
): Set<string> {
	const moved = new Set<string>();
	// Per child list, the Blocks both versions keep in it, in each side's order.
	const stayed = new Set<string>();
	const orderAfter = new Map<string, string[]>();
	const orderBefore = new Map<string, string[]>();
	const append = (map: Map<string, string[]>, list: string, id: string) => {
		const ids = map.get(list);
		if (ids) ids.push(id);
		else map.set(list, [id]);
	};
	for (const [id, placedAfter] of after) {
		const placedBefore = before.get(id);
		if (!placedBefore || !sameType(placedBefore, placedAfter)) continue;
		if (placedBefore.list !== placedAfter.list) {
			moved.add(id);
			continue;
		}
		stayed.add(id);
		append(orderAfter, placedAfter.list, id);
	}
	for (const [id, placedBefore] of before) {
		if (stayed.has(id)) append(orderBefore, placedBefore.list, id);
	}
	for (const [list, idsAfter] of orderAfter) {
		const idsBefore = orderBefore.get(list) ?? [];
		const kept = new Set(commonSubsequence(idsBefore, idsAfter).map(([, j]) => idsAfter[j]!));
		for (const id of idsAfter) if (!kept.has(id)) moved.add(id);
	}
	return moved;
}

function fieldSteps(
	before: Map<string, string[]> | undefined,
	after: Map<string, string[]> | undefined,
	block: { id: string; type: string }
): FieldChange[] {
	const fields = new Set([...(before?.keys() ?? []), ...(after?.keys() ?? [])]);
	const changes: FieldChange[] = [];
	for (const field of fields) {
		for (const step of diffSequence(before?.get(field) ?? [], after?.get(field) ?? [])) {
			changes.push({ ...step, blockId: block.id, blockType: block.type, field });
		}
	}
	return changes;
}

const excerptOf = (fields: OwnFields): string => {
	for (const values of fields.copy.values()) {
		const first = values[0];
		if (first) return first.length > 80 ? `${first.slice(0, 79)}…` : first;
	}
	return '';
};

/** Compare `before` (the older version) with `after` (the newer one). */
export function diffTemplateVersions<N extends BlockTreeNode>(
	before: TemplateDiffSide<N>,
	after: TemplateDiffSide<N>
): TemplateDiff<N> {
	const treeBefore = normalizeBlockTreeIds(before.blocks, { renewRepeated: true });
	const treeAfter = normalizeBlockTreeIds(after.blocks, { renewRepeated: true });
	const placedBefore = place(treeBefore);
	const placedAfter = place(treeAfter);
	const moved = movedIds(placedBefore, placedAfter);

	const blocks: BlockChange[] = [];
	const copy: FieldChange[] = [];
	const links: FieldChange[] = [];
	const outlines: TemplateDiff['outlines'] = { before: {}, after: {} };

	const record = (
		kind: BlockChangeKind,
		node: BlockTreeNode,
		fields: OwnFields,
		extra: Partial<BlockChange> = {}
	) => {
		blocks.push({
			id: node.id,
			type: node.type,
			kind,
			moved: kind === 'moved',
			parts: { copy: false, links: false, other: false },
			excerpt: excerptOf(fields),
			...extra,
		});
	};

	for (const [id, now] of placedAfter) {
		const was = placedBefore.get(id);
		if (!was || !sameType(was, now)) {
			record('added', now.node, now.fields);
			outlines.after[id] = 'added';
			copy.push(...fieldSteps(undefined, now.fields.copy, now.node));
			links.push(...fieldSteps(undefined, now.fields.links, now.node));
			continue;
		}
		const isMoved = moved.has(id);
		if (was.fields.own === now.fields.own) {
			if (isMoved) {
				record('moved', now.node, now.fields);
				outlines.before[id] = 'moved';
				outlines.after[id] = 'moved';
			}
			continue;
		}
		const copySteps = fieldSteps(was.fields.copy, now.fields.copy, now.node);
		const linkSteps = fieldSteps(was.fields.links, now.fields.links, now.node);
		copy.push(...copySteps);
		links.push(...linkSteps);
		const parts = {
			copy: copySteps.length > 0,
			links: linkSteps.length > 0,
			// Markup-only edits (bold, a colour inside the html) change neither the
			// copy nor the links, and still count as a change.
			other:
				was.fields.rest !== now.fields.rest || (copySteps.length === 0 && linkSteps.length === 0),
		};
		record('edited', now.node, now.fields, { moved: isMoved, parts });
		outlines.before[id] = 'edited';
		outlines.after[id] = 'edited';
	}

	for (const [id, was] of placedBefore) {
		const now = placedAfter.get(id);
		if (now && sameType(was, now)) continue;
		record('removed', was.node, was.fields);
		outlines.before[id] = 'removed';
		copy.push(...fieldSteps(was.fields.copy, undefined, was.node));
		links.push(...fieldSteps(was.fields.links, undefined, was.node));
	}

	const meta: MetaChange[] = [];
	for (const field of ['subject', 'previewText'] as const) {
		const was = before[field];
		const now = after[field];
		if (was !== undefined && now !== undefined && was !== now) {
			meta.push({ field, before: was, after: now });
		}
	}

	return {
		identical: blocks.length === 0 && meta.length === 0,
		meta,
		blocks,
		copy,
		links,
		outlines,
		trees: { before: treeBefore, after: treeAfter },
	};
}
