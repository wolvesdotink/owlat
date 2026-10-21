// The Block tree's one child contract: every child-bearing Block type is
// listed once, and the three helpers agree on where its children live.
import { describe, it, expect } from 'vitest';
import {
	childBlockLists,
	mapChildBlockLists,
	normalizeBlockTreeIds,
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

describe('normalizeBlockTreeIds', () => {
	type Raw = Record<string, unknown>;
	const raw = (type: string, content: object, id?: unknown): Raw =>
		id === undefined ? { type, content } : { id, type, content };
	const text = (id?: unknown): Raw => raw('text', { html: String(id) }, id);

	/** Every Block and section id in document order, reaching id-less entries too. */
	const idsOf = (roots: unknown[]): unknown[] => {
		const out: unknown[] = [];
		const visit = (node: Raw): void => {
			out.push(node['id']);
			const content = node['content'] as Raw;
			const sections = Array.isArray(content['sections']) ? (content['sections'] as Raw[]) : [];
			for (const section of sections) out.push(section['id']);
			const lists = Array.isArray(content['columns'])
				? (content['columns'] as Raw[][])
				: Array.isArray(content['items'])
					? [content['items'] as Raw[]]
					: sections.map((section) => (section['items'] as Raw[]) ?? []);
			for (const list of lists) for (const child of list) visit(child);
		};
		for (const root of roots as Raw[]) visit(root);
		return out;
	};

	it('fills missing, empty and non-string ids at every depth, keeping usable ones', () => {
		const roots = [
			text(),
			text(12),
			text(''),
			raw('container', { items: [text(), text('kept')] }, 'box'),
			raw('columns', { columns: [[text()], [text(null)]] }),
			raw('accordion', { sections: [{ title: 'One', items: [text()] }] }, 'acc'),
		];
		const ids = idsOf(normalizeBlockTreeIds(roots));
		expect(ids.every((id) => typeof id === 'string' && id !== '')).toBe(true);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain('kept');
		expect(ids).toContain('box');
		expect(ids).toContain('acc');
		// A section is not a Block: its fresh id says so.
		expect(ids[ids.indexOf('acc') + 1]).toMatch(/^section-/);
	});

	it('keeps repeated ids by default and renews later occurrences on request', () => {
		const roots = () => [
			text('b1'),
			raw('container', { items: [text('b1'), text('c')] }, 'box'),
			raw(
				'accordion',
				{
					sections: [
						{ id: 's', items: [] },
						{ id: 's', items: [] },
					],
				},
				'acc'
			),
			text('b1'),
		];
		expect(idsOf(normalizeBlockTreeIds(roots()))).toEqual(idsOf(roots()));

		const renewed = idsOf(normalizeBlockTreeIds(roots(), { renewRepeated: true }));
		expect(renewed[0]).toBe('b1');
		expect(renewed).toEqual([
			'b1',
			'box',
			expect.any(String),
			'c',
			'acc',
			's',
			expect.any(String),
			expect.any(String),
		]);
		expect(new Set(renewed).size).toBe(renewed.length);
	});

	it('never hands out an id the document already uses, even later in it', () => {
		const roots = [
			text(),
			text('block-1'),
			text('block-2'),
			raw('accordion', { sections: [{ id: 'block-3', items: [] }] }, 'acc'),
		];
		const ids = idsOf(normalizeBlockTreeIds(roots));
		expect(ids[0]).toBe('block-4');
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('fills a missing id the same way whether or not repeats are renewed', () => {
		const roots = () => [text('b1'), text('b1'), text()];
		const fillOnly = idsOf(normalizeBlockTreeIds(roots()));
		const renewed = idsOf(normalizeBlockTreeIds(roots(), { renewRepeated: true }));
		expect(renewed[2]).toBe(fillOnly[2]);
		expect(renewed[1]).not.toBe('b1');
	});

	it('is deterministic, so repeated reads of one document agree', () => {
		const roots = () => [
			text('b1'),
			text(),
			raw('container', { items: [text('b1'), text()] }, 'box'),
		];
		const first = normalizeBlockTreeIds(roots(), { renewRepeated: true });
		const second = normalizeBlockTreeIds(roots(), { renewRepeated: true });
		expect(second).toEqual(first);
		expect(normalizeBlockTreeIds(first, { renewRepeated: true })).toEqual(first);
	});

	it('does not mutate the input, and returns the same entries when nothing needs repair', () => {
		const roots = [text('b1'), text('b1'), raw('container', { items: [text()] }, 'box')];
		const snapshot = JSON.parse(JSON.stringify(roots));
		normalizeBlockTreeIds(roots, { renewRepeated: true });
		expect(roots).toEqual(snapshot);

		const clean = [text('a'), text('b')];
		const result = normalizeBlockTreeIds(clean, { renewRepeated: true });
		expect(result).not.toBe(clean);
		expect(result[0]).toBe(clean[0]);
		expect(result[1]).toBe(clean[1]);
	});

	it('leaves entries that are not Blocks where they are', () => {
		const roots: unknown[] = [null, 'text', { id: 'no-type' }, text()];
		const result = normalizeBlockTreeIds(roots);
		expect(result.slice(0, 3)).toEqual([null, 'text', { id: 'no-type' }]);
		expect((result[3] as Raw)['id']).toBe('block-1');
	});
});
