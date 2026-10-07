import { describe, expect, it } from 'vitest';
import type { ConvexClient, FolderRow } from '../../../convex.js';
import { buildFolderTree } from '../folderTree.js';
import { resolveFolderByName } from '../folders.js';
import { matchesPattern, pathFromClient } from '../mailboxPattern.js';

const folder = (_id: string, name: string, extra: Partial<FolderRow> = {}): FolderRow => ({
	_id,
	name,
	...extra,
});

const pathsOf = (folders: FolderRow[]): Record<string, string> =>
	Object.fromEntries(buildFolderTree(folders).map((f) => [f._id, f.path]));

describe('buildFolderTree', () => {
	it('joins the parentId chain with "/", outermost first', () => {
		expect(
			pathsOf([
				folder('a', 'Work'),
				folder('b', 'Clients', { parentId: 'a' }),
				folder('c', '2025', { parentId: 'b' }),
			])
		).toEqual({ a: 'Work', b: 'Work/Clients', c: 'Work/Clients/2025' });
	});

	it('lists the inbox as INBOX, at the top, whatever it is stored as', () => {
		expect(
			pathsOf([
				folder('i', 'Inbox', { role: 'inbox', parentId: 'x' }),
				folder('x', 'Elsewhere'),
				folder('r', 'Receipts', { parentId: 'i' }),
			])
		).toEqual({ i: 'INBOX', x: 'Elsewhere', r: 'INBOX/Receipts' });
	});

	it('sends a "/" inside one name as U+2215, so it is not a level', () => {
		expect(pathsOf([folder('a', 'A/B'), folder('b', 'C/D', { parentId: 'a' })])).toEqual({
			a: 'A∕B',
			b: 'A∕B/C∕D',
		});
	});

	it('puts a folder whose parent is missing at the top level', () => {
		expect(pathsOf([folder('a', 'Orphan', { parentId: 'gone' })])).toEqual({ a: 'Orphan' });
	});

	it('stops at a parentId loop instead of walking it forever', () => {
		const tree = pathsOf([
			folder('a', 'A', { parentId: 'b' }),
			folder('b', 'B', { parentId: 'a' }),
		]);
		expect(tree).toEqual({ a: 'B/A', b: 'A/B' });
	});

	it('sets hasChildren from the tree', () => {
		const tree = buildFolderTree([
			folder('a', 'Work'),
			folder('b', 'Clients', { parentId: 'a' }),
			folder('c', 'Solo'),
		]);
		expect(tree.map((f) => [f._id, f.hasChildren])).toEqual([
			['a', true],
			['b', false],
			['c', false],
		]);
	});

	it("never changes a folder's path when other folders appear", () => {
		const before = [
			folder('a', 'Work'),
			folder('b', 'Clients', { parentId: 'a' }),
			folder('c', 'A/B'),
		];
		const after = [
			...before,
			folder('d', 'Clients'),
			folder('e', 'A∕B'),
			folder('f', 'Work', { parentId: 'd' }),
		];
		const was = pathsOf(before);
		const now = pathsOf(after);
		for (const id of Object.keys(was)) expect(now[id]).toBe(was[id]);
	});
});

describe('resolveFolderByName with paths', () => {
	const convexFor = (folders: FolderRow[]) =>
		({ query: async () => folders }) as unknown as ConvexClient;

	it('where two folders share a path, the older one keeps it', async () => {
		// Listing order is oldest first: `A/B` existed before `A∕B` was created.
		const convex = convexFor([folder('old', 'A/B'), folder('new', 'A∕B')]);
		expect((await resolveFolderByName(convex, 'mb', 'A&IhU-B'))?._id).toBe('old');
	});

	it('decodes each level on its own, so a raw level does not stop the others', async () => {
		const convex = convexFor([folder('a', 'R&D'), folder('b', 'Übersicht', { parentId: 'a' })]);
		expect((await resolveFolderByName(convex, 'mb', 'R&D/&ANw-bersicht'))?._id).toBe('b');
	});

	it('folds ASCII case over the whole path only when one folder matches', async () => {
		const convex = convexFor([
			folder('a', 'Work'),
			folder('b', 'Notes', { parentId: 'a' }),
			folder('c', 'NOTES', { parentId: 'a' }),
			folder('d', 'Receipts', { parentId: 'a' }),
		]);
		expect((await resolveFolderByName(convex, 'mb', 'work/receipts'))?._id).toBe('d');
		expect(await resolveFolderByName(convex, 'mb', 'work/notes')).toBeNull();
	});
});

describe('pathFromClient', () => {
	it.each([
		['inbox', 'INBOX'],
		['Inbox/Receipts', 'INBOX/Receipts'],
		['Work/inbox', 'Work/inbox'],
		['Work/&ANw-bersicht', 'Work/Übersicht'],
		['R&D/&ANw-*', 'R&D/Ü*'],
		['', ''],
	])('%j → %j', (wire, path) => {
		expect(pathFromClient(wire)).toBe(path);
	});
});

describe('matchesPattern', () => {
	it.each([
		['*', 'Work/Clients/2025', true],
		['%', 'Work', true],
		['%', 'Work/Clients', false],
		['Work/%', 'Work/Clients', true],
		['Work/%', 'Work/Clients/2025', false],
		['Work/*', 'Work/Clients/2025', true],
		['Work/*', 'Work', false],
		['Work%', 'Workshop', true],
		['Work%', 'Work/Clients', false],
		['%/%', 'Work/Clients', true],
		['*/2025', 'Work/Clients/2025', true],
		['W*s', 'Work/Clients', true],
		['W%s', 'Work/Clients', false],
		['Work', 'work', false],
		['Work', 'Work', true],
		['Ü*', 'Übersicht', true],
		['**%%', 'Work/Clients', true],
		['%%', 'Work/Clients', false],
		['a.b', 'axb', false],
		['(x)+', '(x)+', true],
	])('%j matches %j: %s', (pattern, path, expected) => {
		expect(matchesPattern(pattern, path)).toBe(expected);
	});

	it('a pattern of many wildcards against a long name answers at once', () => {
		const pattern = '*a'.repeat(2000) + 'b';
		const path = 'a'.repeat(5000);
		const start = performance.now();
		expect(matchesPattern(pattern, path)).toBe(false);
		expect(matchesPattern('%a'.repeat(2000), path)).toBe(true);
		expect(performance.now() - start).toBeLessThan(2000);
	});
});
