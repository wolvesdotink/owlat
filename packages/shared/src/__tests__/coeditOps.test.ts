import { describe, it, expect } from 'vitest';
import {
	applyCoeditOps,
	coeditOpKey,
	diffCoeditDocument,
	sameCoeditValue,
	type CoeditOp,
} from '../coeditOps';

interface Block {
	id: string;
	text: string;
}

const b = (id: string, text = id): Block => ({ id, text });
const ids = (blocks: readonly Block[]) => blocks.map((block) => block.id);

// The block-level halves, through the document API.
const diffCoeditBlocks = (from: readonly Block[], to: readonly Block[]) =>
	diffCoeditDocument({ blocks: from, fields: {} }, { blocks: to, fields: {} });
const applyCoeditBlockOps = (blocks: readonly Block[], ops: CoeditOp<Block>[]) =>
	applyCoeditOps({ blocks, fields: {} }, ops).blocks;

/** Deterministic PRNG so a failing permutation can be replayed. */
function rng(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

describe('diffCoeditBlocks / applyCoeditBlockOps', () => {
	it('is empty for identical lists', () => {
		const blocks = [b('a'), b('b')];
		expect(
			diffCoeditBlocks(
				blocks,
				blocks.map((x) => ({ ...x }))
			)
		).toEqual([]);
	});

	it('emits inserts, deletes, moves and updates that rebuild the target', () => {
		const from = [b('a'), b('b'), b('c'), b('d')];
		const to = [b('d'), b('a', 'A!'), b('x'), b('c')];
		const ops = diffCoeditBlocks(from, to);
		expect(ops.map((op) => op.kind).sort()).toEqual(['delete', 'insert', 'move', 'update']);
		expect(applyCoeditBlockOps(from, ops)).toEqual(to);
	});

	it('moves the fewest blocks', () => {
		const from = [b('a'), b('b'), b('c'), b('d'), b('e')];
		const to = [b('a'), b('c'), b('d'), b('e'), b('b')];
		const ops = diffCoeditBlocks(from, to);
		expect(ops).toEqual([{ kind: 'move', blockId: 'b', afterId: 'e' }]);
	});

	it('ignores key order when comparing blocks', () => {
		expect(sameCoeditValue({ id: 'a', text: 'x' }, { text: 'x', id: 'a' })).toBe(true);
		expect(diffCoeditBlocks([{ id: 'a', text: 'x' }], [{ text: 'x', id: 'a' }])).toEqual([]);
	});

	it('round-trips random edits', () => {
		const random = rng(7);
		for (let round = 0; round < 300; round++) {
			const from = Array.from({ length: Math.floor(random() * 8) }, (_, i) => b(`b${i}`));
			const to = from
				.filter(() => random() > 0.25)
				.map((block) => (random() > 0.7 ? b(block.id, `${block.text}*`) : block));
			for (let i = 0; i < 3; i++) {
				if (random() > 0.5)
					to.splice(Math.floor(random() * (to.length + 1)), 0, b(`n${round}-${i}`));
			}
			to.sort(() => random() - 0.5);
			expect(applyCoeditBlockOps(from, diffCoeditBlocks(from, to))).toEqual(to);
		}
	});

	it('keeps the identity of blocks it does not touch', () => {
		const from = [b('a'), b('b')];
		const next = applyCoeditBlockOps(from, [{ kind: 'update', block: b('b', 'B'), afterId: 'a' }]);
		expect(next[0]).toBe(from[0]);
		expect(from[1]!.text).toBe('b');
	});
});

describe('applyCoeditBlockOps on a state that moved on', () => {
	it('merges edits to different blocks', () => {
		const base = [b('a'), b('b'), b('c')];
		const mine = diffCoeditBlocks(base, [b('a', 'mine'), b('b'), b('c')]);
		const theirs = diffCoeditBlocks(base, [b('a'), b('b'), b('c', 'theirs'), b('d')]);
		const server = applyCoeditBlockOps(applyCoeditBlockOps(base, theirs), mine);
		expect(server).toEqual([b('a', 'mine'), b('b'), b('c', 'theirs'), b('d')]);
	});

	it('puts a block back when an update meets a concurrent delete', () => {
		const next = applyCoeditBlockOps(
			[b('a'), b('c')],
			[{ kind: 'update', block: b('b', 'kept'), afterId: 'a' }]
		);
		expect(ids(next)).toEqual(['a', 'b', 'c']);
	});

	it('appends an insert whose anchor is gone', () => {
		const next = applyCoeditBlockOps(
			[b('a')],
			[{ kind: 'insert', block: b('n'), afterId: 'gone' }]
		);
		expect(ids(next)).toEqual(['a', 'n']);
	});

	it('leaves a block in place when its move anchor is gone', () => {
		const next = applyCoeditBlockOps(
			[b('a'), b('b'), b('c')],
			[{ kind: 'move', blockId: 'a', afterId: 'gone' }]
		);
		expect(ids(next)).toEqual(['a', 'b', 'c']);
	});

	it('ignores deletes and moves of missing blocks', () => {
		const base = [b('a')];
		expect(
			applyCoeditBlockOps(base, [
				{ kind: 'delete', blockId: 'x' },
				{ kind: 'move', blockId: 'x', afterId: null },
			])
		).toEqual(base);
	});

	it('repositions a repeated insert instead of duplicating it', () => {
		const next = applyCoeditBlockOps(
			[b('a'), b('n'), b('c')],
			[{ kind: 'insert', block: b('n', 'again'), afterId: 'c' }]
		);
		expect(next).toEqual([b('a'), b('c'), b('n', 'again')]);
	});
});

describe('documents and fields', () => {
	it('diffs and applies field writes', () => {
		const from = { blocks: [b('a')], fields: { subject: 'Hi', name: 'N' } };
		const to = { blocks: [b('a')], fields: { subject: 'Hello', name: 'N' } };
		const ops = diffCoeditDocument(from, to);
		expect(ops).toEqual([{ kind: 'field', field: 'subject', value: 'Hello' }]);
		const applied = applyCoeditOps(from, ops);
		expect(applied.fields).toEqual(to.fields);
		expect(applied.blocks).toBe(from.blocks);
	});

	it('returns the same document for no operations', () => {
		const doc = { blocks: [b('a')], fields: {} };
		expect(applyCoeditOps(doc, [])).toBe(doc);
	});

	it('keys content writes but not moves', () => {
		const ops: CoeditOp<Block>[] = [
			{ kind: 'insert', block: b('a'), afterId: null },
			{ kind: 'update', block: b('a'), afterId: null },
			{ kind: 'delete', blockId: 'a' },
			{ kind: 'move', blockId: 'a', afterId: null },
			{ kind: 'field', field: 'subject', value: 'x' },
		];
		expect(ops.map(coeditOpKey)).toEqual(['block:a', 'block:a', 'block:a', null, 'field:subject']);
	});
});
