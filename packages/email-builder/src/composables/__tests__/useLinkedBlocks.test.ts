import { describe, it, expect, vi } from 'vitest';
import { ref, shallowRef } from 'vue';
import { buildLinkedBlockIndex, useLinkedBlocks } from '../useLinkedBlocks';
import type { EditorBlock } from '../../types';

/**
 * The canvas asks three questions per Block on every render (is it linked,
 * is it first / last in its group). They used to be answered by scanning the
 * root array, O(N²) per render and rerun on every selection change (#922).
 * These tests pin the shared index: same answers as the old scans, one visit
 * per Block to build, none to answer, and rebuilt on every change that can
 * alter the answers (reorder, detach in place, undo/redo, restored content).
 */

function block(id: string, groupId?: string, name = `Saved ${groupId}`): EditorBlock {
	const b = { id, type: 'text', content: { html: `<p>${id}</p>` } } as unknown as EditorBlock;
	if (groupId) b.savedBlockRef = { groupId, blockId: `sb-${groupId}`, blockName: name };
	return b;
}

/** Ten-Block unit: one saved group of five, then five unlinked. */
function fixture(n: number): EditorBlock[] {
	return Array.from({ length: n }, (_, i) =>
		i % 10 < 5 ? block(`b${i}`, `g${Math.floor(i / 10)}`) : block(`b${i}`)
	);
}

// The pre-#922 scans, kept as the reference the index must agree with.
const reference = {
	group(blocks: EditorBlock[], groupId: string) {
		const blockIndices: number[] = [];
		let blockId = '';
		let blockName = '';
		for (const [i, b] of blocks.entries()) {
			if (b.savedBlockRef?.groupId === groupId) {
				blockIndices.push(i);
				blockId = b.savedBlockRef.blockId;
				blockName = b.savedBlockRef.blockName;
			}
		}
		return blockIndices.length ? { groupId, blockId, blockName, blockIndices } : null;
	},
	edge(blocks: EditorBlock[], id: string, last: boolean) {
		const b = blocks.find((x) => x.id === id);
		if (!b?.savedBlockRef) return false;
		const g = reference.group(blocks, b.savedBlockRef.groupId)!;
		const i = blocks.findIndex((x) => x.id === id);
		return (last ? g.blockIndices[g.blockIndices.length - 1] : g.blockIndices[0]) === i;
	},
	displayItems(blocks: EditorBlock[]) {
		const items: { id: string; blocks: string[] }[] = [];
		const seen = new Set<string>();
		for (const b of blocks) {
			const groupId = b.savedBlockRef?.groupId;
			if (!groupId) items.push({ id: b.id, blocks: [b.id] });
			else if (!seen.has(groupId)) {
				seen.add(groupId);
				const members = blocks.filter((x) => x.savedBlockRef?.groupId === groupId).map((x) => x.id);
				items.push({ id: `group-${groupId}`, blocks: members });
			}
		}
		return items;
	},
};

function expectMatchesReference(blocks: EditorBlock[]) {
	const h = useLinkedBlocks({ canvasBlocks: ref(blocks) });
	for (const b of blocks) {
		expect(h.isLinkedBlock(b.id), b.id).toBe(!!blocks.find((x) => x.id === b.id)?.savedBlockRef);
		expect(h.isFirstInGroup(b.id), b.id).toBe(reference.edge(blocks, b.id, false));
		expect(h.isLastInGroup(b.id), b.id).toBe(reference.edge(blocks, b.id, true));
		const gid = blocks.find((x) => x.id === b.id)?.savedBlockRef?.groupId;
		expect(h.getLinkedGroupByBlockId(b.id)).toEqual(gid ? reference.group(blocks, gid) : null);
	}
	expect(h.isLinkedBlock('missing')).toBe(false);
	expect(h.getLinkedGroup('missing')).toBeNull();
	const items = buildLinkedBlockIndex(blocks).displayItems.map((i) => ({
		id: i.id,
		blocks: i.blocks.map((b) => b.id),
	}));
	expect(items).toEqual(reference.displayItems(blocks));
}

describe('linked-block index agrees with the old scans', () => {
	it('mixed linked and unlinked Blocks, several groups', () => {
		expectMatchesReference(fixture(40));
	});

	it('a group split by other Blocks, single-Block groups, adjacent groups', () => {
		expectMatchesReference([
			block('a', 'g1'),
			block('x'),
			block('b', 'g2'),
			block('c', 'g1', 'Renamed'),
			block('d', 'g3'),
			block('e', 'g3'),
			block('f', 'g2'),
		]);
	});

	it('a duplicated id resolves to its first occurrence', () => {
		expectMatchesReference([block('a', 'g1'), block('b', 'g1'), block('a', 'g1'), block('c')]);
	});

	it('returns fresh group objects, so callers cannot corrupt the index', () => {
		const h = useLinkedBlocks({ canvasBlocks: ref([block('a', 'g1'), block('b', 'g1')]) });
		h.getLinkedGroup('g1')!.blockIndices.push(99);
		h.getLinkedBlockGroups()[0]!.blockIndices.reverse();
		expect(h.getLinkedGroup('g1')!.blockIndices).toEqual([0, 1]);
	});
});

describe('linked-block index cost', () => {
	/** Counts reads of Block slots on the root array. */
	function counted(blocks: EditorBlock[]) {
		const counter = { reads: 0 };
		const proxy = new Proxy(blocks, {
			get(t, k, r) {
				if (typeof k === 'string' && /^\d+$/.test(k)) counter.reads++;
				return Reflect.get(t, k, r);
			},
		});
		return { proxy, counter };
	}

	function renderPass(h: ReturnType<typeof useLinkedBlocks>, ids: string[]) {
		for (const id of ids) {
			if (h.isLinkedBlock(id)) {
				h.isFirstInGroup(id);
				h.isLastInGroup(id);
			}
		}
	}

	it.each([100, 1000])(
		'builds with one visit per Block and answers a selection render with none (%i Blocks)',
		(n) => {
			const { proxy, counter } = counted(fixture(n));
			const canvasBlocks = ref(proxy);
			const selected = ref<string | null>(null);
			const h = useLinkedBlocks({ canvasBlocks });
			const ids = fixture(n).map((b) => b.id);

			renderPass(h, ids);
			expect(counter.reads).toBe(n);

			counter.reads = 0;
			selected.value = ids[n - 1]!;
			renderPass(h, ids);
			expect(counter.reads).toBe(0);
		}
	);
});

describe('linked-block index invalidation', () => {
	it('follows a reorder', () => {
		const canvasBlocks = ref([block('a', 'g1'), block('b', 'g1'), block('c')]);
		const h = useLinkedBlocks({ canvasBlocks });
		expect(h.isLastInGroup('b')).toBe(true);
		const [a, b, c] = canvasBlocks.value;
		canvasBlocks.value.splice(0, 3, b!, c!, a!);
		expect(h.isFirstInGroup('b')).toBe(true);
		expect(h.isLastInGroup('a')).toBe(true);
		expect(h.getLinkedGroup('g1')!.blockIndices).toEqual([0, 2]);
		expect(h.index.value.displayItems.map((i) => i.id)).toEqual(['group-g1', 'c']);
	});

	it('follows a detach, which deletes savedBlockRef in place', () => {
		const onTreeMutated = vi.fn();
		const canvasBlocks = ref([block('a', 'g1'), block('b', 'g1'), block('c', 'g2')]);
		const h = useLinkedBlocks({ canvasBlocks, onTreeMutated });
		expect(h.isLinkedBlock('a')).toBe(true);
		const before = canvasBlocks.value;

		h.detachBlock('b');

		expect(canvasBlocks.value).toBe(before);
		expect(onTreeMutated).toHaveBeenCalledTimes(1);
		expect(h.isLinkedBlock('a')).toBe(false);
		expect(h.isLinkedBlock('b')).toBe(false);
		expect(h.isFirstInGroup('a')).toBe(false);
		expect(h.isLinkedBlock('c')).toBe(true);
		expect(h.getLinkedBlockGroups().map((g) => g.groupId)).toEqual(['g2']);

		h.detachBlock('a');
		expect(onTreeMutated).toHaveBeenCalledTimes(1);
	});

	it('follows a detach on a shallow ref, which cannot see the in-place delete', () => {
		const canvasBlocks = shallowRef([block('a', 'g1'), block('b')]);
		const h = useLinkedBlocks({ canvasBlocks });
		expect(h.isLinkedBlock('a')).toBe(true);
		h.detachLinkedGroup('g1');
		expect(h.isLinkedBlock('a')).toBe(false);
	});

	it('follows undo/redo and restored content that replace the array', () => {
		const canvasBlocks = ref([block('a', 'g1'), block('b', 'g1')]);
		const h = useLinkedBlocks({ canvasBlocks });
		const snapshot = JSON.parse(JSON.stringify(canvasBlocks.value)) as EditorBlock[];

		h.detachBlock('a');
		expect(h.isLinkedBlock('a')).toBe(false);

		canvasBlocks.value = snapshot; // undo
		expect(h.isLinkedBlock('a')).toBe(true);
		expect(h.isLastInGroup('b')).toBe(true);

		canvasBlocks.value = [block('z', 'g9', 'Restored'), block('y')]; // incoming content
		expect(h.isLinkedBlock('a')).toBe(false);
		expect(h.getLinkedGroupByBlockId('z')?.blockName).toBe('Restored');
		expect(h.isFirstInGroup('z') && h.isLastInGroup('z')).toBe(true);
	});

	it('follows a Block swapped in its slot', () => {
		const canvasBlocks = ref([block('a', 'g1'), block('b')]);
		const h = useLinkedBlocks({ canvasBlocks });
		expect(h.isLinkedBlock('b')).toBe(false);
		canvasBlocks.value[1] = block('b', 'g1');
		expect(h.isLinkedBlock('b')).toBe(true);
		expect(h.isLastInGroup('a')).toBe(false);
	});
});
