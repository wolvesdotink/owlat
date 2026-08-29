import { describe, expect, it } from 'vitest';
import {
	buildLabelTree,
	flattenLabelTree,
	labelAncestorIds,
	labelPath,
	type PostboxLabelNodeInput,
} from '../postboxLabelTree';

const label = (
	_id: string,
	name: string,
	extra: Partial<PostboxLabelNodeInput> = {}
): PostboxLabelNodeInput => ({ _id, name, ...extra });

const WORK = label('work', 'Work');
const CLIENTS = label('clients', 'Clients', { parentId: 'work' });
const ACME = label('acme', 'Acme', { parentId: 'clients' });
const PERSONAL = label('personal', 'Personal');

describe('buildLabelTree', () => {
	it('nests children under their parent with a depth per level', () => {
		const [work] = buildLabelTree([ACME, WORK, CLIENTS]);
		expect(work?.label.name).toBe('Work');
		expect(work?.depth).toBe(0);
		expect(work?.children[0]?.label.name).toBe('Clients');
		expect(work?.children[0]?.depth).toBe(1);
		expect(work?.children[0]?.children[0]?.label.name).toBe('Acme');
		expect(work?.children[0]?.children[0]?.depth).toBe(2);
	});

	it('sorts pinned first, then manual order, then name', () => {
		const tree = buildLabelTree([
			label('b', 'Beta', { order: 1 }),
			label('a', 'Alpha', { order: 2 }),
			label('p', 'Zeta', { order: 9, isPinned: true }),
		]);
		expect(tree.map((n) => n.label.name)).toEqual(['Zeta', 'Beta', 'Alpha']);
	});

	it('reads alphabetically when no label carries an order', () => {
		// Every pre-nesting row has `order` absent; the name tiebreak is what
		// keeps that mailbox's rail looking exactly as it did.
		const tree = buildLabelTree([label('c', 'Charlie'), label('a', 'Alpha'), label('b', 'Bravo')]);
		expect(tree.map((n) => n.label.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
	});

	it('rolls unread counts up the branch while keeping the local count', () => {
		const [work] = buildLabelTree([WORK, CLIENTS, ACME], { work: 2, acme: 5 });
		expect(work?.unreadCount).toBe(2);
		expect(work?.totalUnreadCount).toBe(7);
		expect(work?.children[0]?.unreadCount).toBe(0);
		expect(work?.children[0]?.totalUnreadCount).toBe(5);
	});

	it('promotes a label whose parent is missing rather than hiding it', () => {
		// A row pointing at a deleted parent is still the user's label; dropping
		// it would leave them with no way to see or fix it.
		const tree = buildLabelTree([label('orphan', 'Orphan', { parentId: 'gone' }), PERSONAL]);
		expect(tree.map((n) => n.label.name).sort()).toEqual(['Orphan', 'Personal']);
	});

	it('renders a cycle instead of dropping every label caught in it', () => {
		const a = label('a', 'A', { parentId: 'b' });
		const b = label('b', 'B', { parentId: 'a' });
		const tree = buildLabelTree([a, b]);
		const rendered = flattenLabelTree(tree, new Set()).map((n) => n.label.name);
		expect(rendered.sort()).toEqual(['A', 'B']);
	});
});

describe('flattenLabelTree', () => {
	it('keeps a collapsed node and hides everything under it', () => {
		const tree = buildLabelTree([WORK, CLIENTS, ACME, PERSONAL]);
		const rows = flattenLabelTree(tree, new Set(['clients']));
		expect(rows.map((n) => n.label.name)).toEqual(['Personal', 'Work', 'Clients']);
	});

	it('restores the inner collapse state when a branch re-expands', () => {
		const tree = buildLabelTree([WORK, CLIENTS, ACME]);
		const collapsed = new Set(['work', 'clients']);
		expect(flattenLabelTree(tree, collapsed).map((n) => n.label._id)).toEqual(['work']);
		collapsed.delete('work');
		// Clients is visible again but still collapsed, so Acme stays hidden.
		expect(flattenLabelTree(tree, collapsed).map((n) => n.label._id)).toEqual(['work', 'clients']);
	});
});

describe('labelAncestorIds', () => {
	it('walks up to the root, nearest ancestor first', () => {
		expect(labelAncestorIds([WORK, CLIENTS, ACME], 'acme')).toEqual(['clients', 'work']);
	});

	it('terminates on a cycle instead of spinning', () => {
		const a = label('a', 'A', { parentId: 'b' });
		const b = label('b', 'B', { parentId: 'a' });
		expect(labelAncestorIds([a, b], 'a')).toEqual(['b']);
	});
});

describe('labelPath', () => {
	it('spells the whole branch, root first', () => {
		expect(labelPath([WORK, CLIENTS, ACME], 'acme')).toBe('Work / Clients / Acme');
	});

	it('is empty for a label that is not in the set', () => {
		expect(labelPath([WORK], 'gone')).toBe('');
	});
});
