/**
 * Co-editing operations: the edit vocabulary two people working on one email
 * exchange (docs/adr/0071-email-coediting.md).
 *
 * A document is the email's root block list plus a few named fields (name,
 * subject, the text/plain override, ...). An edit is expressed per root block:
 * insert, delete, move, or update (the whole block replaced), plus a `field`
 * write. A nested item (a column's content, a container's child) belongs to its
 * root block, so two people editing different columns of one columns block
 * edit the same block.
 *
 * `diffCoeditDocument` turns two states into the operations that lead from one
 * to the other; `applyCoeditOps` replays operations on a state that may have
 * moved on in the meantime (another person's edits landed first). The replay is
 * tolerant: an update of a block someone deleted puts it back, a move whose
 * anchor is gone leaves the block where it is, and an insert whose anchor is
 * gone appends. Unchanged blocks keep their object identity, so a caller can
 * hand the result to a canvas without re-rendering what did not change.
 *
 * Pure and dependency-free: the Convex backend applies operations to the
 * shared session and the editor applies them to its canvas and undo history.
 */

import { canonicalJson } from './canonicalJson';

/** Anything with a stable id: a root block of the email. */
export interface CoeditBlock {
	readonly id: string;
}

/** One editing state: the root blocks in order and the named fields. */
export interface CoeditDocument<B extends CoeditBlock = CoeditBlock> {
	readonly blocks: readonly B[];
	readonly fields: Readonly<Record<string, unknown>>;
}

export type CoeditOp<B extends CoeditBlock = CoeditBlock> =
	/** A new block, placed after `afterId` (`null` = first). */
	| { kind: 'insert'; block: B; afterId: string | null }
	| { kind: 'delete'; blockId: string }
	/** A block repositioned after `afterId` (`null` = first). */
	| { kind: 'move'; blockId: string; afterId: string | null }
	/**
	 * A block's new content. `afterId` is where it sat, so an update that meets
	 * a concurrent delete can put the block back where its author saw it.
	 */
	| { kind: 'update'; block: B; afterId: string | null }
	| { kind: 'field'; field: string; value: unknown };

/**
 * Upper bound on operations in one batch an editor sends. The server refuses a
 * larger batch, so the editor sends a bigger change in several.
 */
export const MAX_COEDIT_OPS_PER_BATCH = 200;

/** The unit last-writer-wins is decided on: one root block or one field. */
export type CoeditKey = `block:${string}` | `field:${string}`;

export function coeditBlockKey(blockId: string): CoeditKey {
	return `block:${blockId}`;
}

/**
 * The key an operation writes, or `null` for a move: a move changes where a
 * block sits, not what it says, so it never replaces anyone's content.
 */
export function coeditOpKey(op: CoeditOp<CoeditBlock>): CoeditKey | null {
	switch (op.kind) {
		case 'insert':
		case 'update':
			return coeditBlockKey(op.block.id);
		case 'delete':
			return coeditBlockKey(op.blockId);
		case 'move':
			return null;
		case 'field':
			return `field:${op.field}`;
	}
}

/** Whether two values persist to the same JSON, whatever their key order. */
export function sameCoeditValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined) return false;
	return canonicalJson(a) === canonicalJson(b);
}

/**
 * Indices (into `seq`) of one longest strictly increasing subsequence. The
 * blocks at those positions keep their relative order, so they stay put and
 * only the rest are moved.
 */
function longestIncreasingRun(seq: readonly number[]): Set<number> {
	const tails: number[] = [];
	const previous = Array.from({ length: seq.length }, () => -1);
	for (let i = 0; i < seq.length; i++) {
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (seq[tails[mid]!]! < seq[i]!) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0) previous[i] = tails[lo - 1]!;
		tails[lo] = i;
	}
	const kept = new Set<number>();
	let at = tails.length > 0 ? tails[tails.length - 1]! : -1;
	while (at !== -1) {
		kept.add(at);
		at = previous[at]!;
	}
	return kept;
}

/** The operations that turn `from`'s root blocks into `to`'s. */
function diffCoeditBlocks<B extends CoeditBlock>(
	from: readonly B[],
	to: readonly B[]
): CoeditOp<B>[] {
	const ops: CoeditOp<B>[] = [];
	const fromById = new Map(from.map((block) => [block.id, block]));
	const toIds = new Set(to.map((block) => block.id));

	for (const block of from) {
		if (!toIds.has(block.id)) ops.push({ kind: 'delete', blockId: block.id });
	}

	// Blocks present on both sides keep their order unless they have to move:
	// the longest run already in target order stays, everything else moves.
	const rank = new Map<string, number>();
	for (const block of from) if (toIds.has(block.id)) rank.set(block.id, rank.size);
	const survivors = to.filter((block) => rank.has(block.id));
	const stationaryAt = longestIncreasingRun(survivors.map((block) => rank.get(block.id)!));
	const stationary = new Set([...stationaryAt].map((index) => survivors[index]!.id));

	// Placed in target order, each after its target predecessor, which is
	// already in its final place by then.
	let afterId: string | null = null;
	const predecessor = new Map<string, string | null>();
	for (const block of to) {
		predecessor.set(block.id, afterId);
		if (!fromById.has(block.id)) ops.push({ kind: 'insert', block, afterId });
		else if (!stationary.has(block.id)) ops.push({ kind: 'move', blockId: block.id, afterId });
		afterId = block.id;
	}

	for (const block of to) {
		const before = fromById.get(block.id);
		if (before !== undefined && !sameCoeditValue(before, block)) {
			ops.push({ kind: 'update', block, afterId: predecessor.get(block.id) ?? null });
		}
	}
	return ops;
}

/** The field writes that turn `from`'s fields into `to`'s. */
function diffCoeditFields(
	from: Readonly<Record<string, unknown>>,
	to: Readonly<Record<string, unknown>>
): CoeditOp<never>[] {
	const ops: CoeditOp<never>[] = [];
	for (const field of Object.keys(to)) {
		if (!sameCoeditValue(from[field], to[field])) {
			ops.push({ kind: 'field', field, value: to[field] });
		}
	}
	return ops;
}

/** Everything that changed from `from` to `to`, blocks first. */
export function diffCoeditDocument<B extends CoeditBlock>(
	from: CoeditDocument<B>,
	to: CoeditDocument<B>
): CoeditOp<B>[] {
	return [...diffCoeditBlocks(from.blocks, to.blocks), ...diffCoeditFields(from.fields, to.fields)];
}

function placeAfter<B extends CoeditBlock>(
	blocks: B[],
	block: B,
	afterId: string | null,
	whenAnchorMissing: 'append' | 'skip'
): boolean {
	if (afterId === null) {
		blocks.unshift(block);
		return true;
	}
	const anchor = blocks.findIndex((candidate) => candidate.id === afterId);
	if (anchor === -1) {
		if (whenAnchorMissing === 'skip') return false;
		blocks.push(block);
		return true;
	}
	blocks.splice(anchor + 1, 0, block);
	return true;
}

/** Apply block operations in order. The input array is not modified. */
function applyCoeditBlockOps<B extends CoeditBlock>(
	blocks: readonly B[],
	ops: readonly CoeditOp<B>[]
): B[] {
	const next = [...blocks];
	for (const op of ops) {
		switch (op.kind) {
			case 'insert':
			case 'update': {
				const at = next.findIndex((block) => block.id === op.block.id);
				if (at !== -1) {
					next[at] = op.block;
					// A repeated insert (a retry after a lost acknowledgement)
					// also repositions; an update only rewrites content.
					if (op.kind === 'insert') {
						next.splice(at, 1);
						placeAfter(next, op.block, op.afterId, 'append');
					}
				} else {
					placeAfter(next, op.block, op.afterId, 'append');
				}
				break;
			}
			case 'delete': {
				const at = next.findIndex((block) => block.id === op.blockId);
				if (at !== -1) next.splice(at, 1);
				break;
			}
			case 'move': {
				const at = next.findIndex((block) => block.id === op.blockId);
				if (at === -1 || op.afterId === op.blockId) break;
				const [moved] = next.splice(at, 1);
				if (!placeAfter(next, moved!, op.afterId, 'skip')) next.splice(at, 0, moved!);
				break;
			}
			case 'field':
				break;
		}
	}
	return next;
}

/** Apply operations to a whole document. The input is not modified. */
export function applyCoeditOps<B extends CoeditBlock>(
	doc: CoeditDocument<B>,
	ops: readonly CoeditOp<B>[]
): CoeditDocument<B> {
	if (ops.length === 0) return doc;
	let fields: Record<string, unknown> | null = null;
	for (const op of ops) {
		if (op.kind !== 'field') continue;
		fields ??= { ...doc.fields };
		fields[op.field] = op.value;
	}
	const touchesBlocks = ops.some((op) => op.kind !== 'field');
	return {
		blocks: touchesBlocks ? applyCoeditBlockOps(doc.blocks, ops) : doc.blocks,
		fields: fields ?? doc.fields,
	};
}
