// The Block tree's one child contract: every child-bearing Block type is
// listed once, and the three helpers agree on where its children live.
import { describe, it, expect } from 'vitest';
import {
	childBlockLists,
	mapChildBlockLists,
	ownedEntries,
	renewBlockTreeIds,
	type BlockTreeNode,
} from '../blockTree';

const leaf = (id: string, type = 'text'): BlockTreeNode => ({ id, type, content: { html: id } });

const tree = (): BlockTreeNode => ({
	id: 'root',
	type: 'container',
	content: {
		backgroundColor: '#fff',
		items: [
			leaf('a'),
			{
				id: 'cols',
				type: 'columns',
				content: { columnCount: 2, columns: [[leaf('l1'), leaf('l2')], [leaf('r1')]] },
			},
			{
				id: 'inner',
				type: 'container',
				content: { items: [leaf('deep')] },
			},
		],
	},
});

const allIds = (node: BlockTreeNode): string[] => [
	node.id,
	...childBlockLists(node).flatMap((list) => list.flatMap(allIds)),
];

describe('childBlockLists', () => {
	it('lists the column grid, the items list of a container and a hero, and accordion sections', () => {
		const ids = (node: BlockTreeNode) =>
			childBlockLists(node).map((list) => list.map((child) => child.id));
		expect(
			ids({ id: 'c', type: 'columns', content: { columns: [[leaf('x')], [], [leaf('y')]] } })
		).toEqual([['x'], [], ['y']]);
		expect(ids({ id: 'c', type: 'container', content: { items: [leaf('x')] } })).toEqual([['x']]);
		expect(ids({ id: 'h', type: 'hero', content: { items: [leaf('x'), leaf('y')] } })).toEqual([
			['x', 'y'],
		]);
		expect(
			ids({
				id: 'acc',
				type: 'accordion',
				content: {
					sections: [
						{ id: 's1', title: 'One', items: [leaf('x')] },
						{ id: 's2', title: 'Two', items: [] },
					],
				},
			})
		).toEqual([['x'], []]);
	});

	it('has no children for leaves, unknown types and malformed content', () => {
		expect(childBlockLists(leaf('t'))).toEqual([]);
		expect(
			childBlockLists({ id: 'x', type: 'plugin:callout', content: { items: [leaf('a')] } })
		).toEqual([]);
		expect(childBlockLists({ id: 'c', type: 'container', content: {} })).toEqual([]);
		expect(childBlockLists({ id: 'c', type: 'columns', content: { columns: 'nope' } })).toEqual([]);
	});

	it('returns the stored arrays, so an in-place edit lands in the tree', () => {
		const node = tree();
		childBlockLists(node)[0]!.push(leaf('added'));
		expect(allIds(node)).toContain('added');
	});

	it('skips entries that are not Block-shaped', () => {
		const node = {
			id: 'c',
			type: 'container',
			content: { items: [null, leaf('ok'), { id: 1 }] },
		} as unknown as BlockTreeNode;
		expect(childBlockLists(node)).toEqual([[leaf('ok')]]);
	});
});

describe('mapChildBlockLists', () => {
	it('rebuilds the child lists without touching the input', () => {
		const node = tree();
		const before = JSON.stringify(node);
		const next = mapChildBlockLists(node, (list) => list.filter((child) => child.id !== 'a'));
		expect(JSON.stringify(node)).toBe(before);
		expect(next).not.toBe(node);
		expect(childBlockLists(next)[0]!.map((c) => c.id)).toEqual(['cols', 'inner']);
		// Untouched children and other content keep their identity and values.
		expect(childBlockLists(next)[0]![0]).toBe(childBlockLists(node)[0]![1]);
		expect((next.content as Record<string, unknown>)['backgroundColor']).toBe('#fff');
	});

	it('writes accordion section items back into their sections', () => {
		const node: BlockTreeNode = {
			id: 'acc',
			type: 'accordion',
			content: { sections: [{ id: 's1', title: 'One', items: [leaf('x')] }] },
		};
		const next = mapChildBlockLists(node, (list) => [...list, leaf('y')]);
		expect(next.content).toEqual({
			sections: [{ id: 's1', title: 'One', items: [leaf('x'), leaf('y')] }],
		});
	});

	it('returns a leaf as is', () => {
		const node = leaf('t');
		expect(mapChildBlockLists(node, () => [])).toBe(node);
	});
});

describe('ownedEntries', () => {
	it('returns the stored accordion sections, so an id written to one lands in the tree', () => {
		const accordion: BlockTreeNode = {
			id: 'acc',
			type: 'accordion',
			content: { sections: [{ id: 's1', title: 'One', items: [] }, 'not a section'] },
		};
		const entries = ownedEntries(accordion);
		expect(entries.map((entry) => entry['id'])).toEqual(['s1']);
		entries[0]!['id'] = 's9';
		expect((accordion.content as { sections: { id: string }[] }).sections[0]!.id).toBe('s9');
	});

	it('is empty for every type that owns no such entries', () => {
		expect(ownedEntries(tree())).toEqual([]);
		expect(ownedEntries(leaf('t'))).toEqual([]);
	});
});

describe('renewBlockTreeIds', () => {
	let counter = 0;
	const newId = () => `new-${++counter}`;

	it('gives the node and every descendant a fresh id', () => {
		const node = tree();
		const before = allIds(node);
		renewBlockTreeIds(node, newId);
		const after = allIds(node);
		expect(after).toHaveLength(before.length);
		expect(new Set(after).size).toBe(after.length);
		expect(after.some((id) => before.includes(id))).toBe(false);
	});

	it('renews hero children and accordion sections with their items', () => {
		const hero: BlockTreeNode = {
			id: 'hero',
			type: 'hero',
			content: {
				items: [leaf('h1'), { id: 'box', type: 'container', content: { items: [leaf('h2')] } }],
			},
		};
		renewBlockTreeIds(hero, newId);
		expect(allIds(hero).filter((id) => ['hero', 'h1', 'box', 'h2'].includes(id))).toEqual([]);

		const accordion: BlockTreeNode = {
			id: 'acc',
			type: 'accordion',
			content: { sections: [{ id: 's1', title: 'One', items: [leaf('x')] }] },
		};
		renewBlockTreeIds(accordion, newId);
		const section = (accordion.content as { sections: { id: string }[] }).sections[0]!;
		expect(section.id).not.toBe('s1');
		expect(allIds(accordion)).not.toContain('x');
	});
});
