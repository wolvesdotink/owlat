import { describe, expect, it } from 'vitest';
import type { ImapFlow } from 'imapflow';
import { decodePath, encodePath } from 'imapflow/lib/tools.js';
import type { ConvexClient, FolderRow } from '../../../convex.js';
import { buildFolderTree, levelName } from '../folderTree.js';
import { resolveFolderByName } from '../folders.js';
import { matchesPattern, pathFromClient } from '../mailboxPattern.js';
import { decodeMailboxName, encodeMailboxName } from '../mailboxName.js';

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

	it('escapes a literal U+2215 and the escape char, so they stay apart from "/"', () => {
		expect(
			pathsOf([
				folder('a', 'A/B'),
				folder('b', 'A∕B'),
				folder('c', 'A⧵∕B'),
				folder('d', 'A⧵/B'),
				folder('e', '⧵'),
			])
		).toEqual({ a: 'A∕B', b: 'A⧵∕B', c: 'A⧵⧵⧵∕B', d: 'A⧵⧵∕B', e: '⧵⧵' });
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

const SLASH = '\u2215';
const ESCAPE = '\u29f5';

/** The inverse of `levelName` for a non-inbox folder, or null for no level it writes. */
function decodeLevel(level: string): string | null {
	const chars = [...level];
	let out = '';
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i]!;
		if (ch === ESCAPE) {
			const next = chars[i + 1];
			if (next !== SLASH && next !== ESCAPE) return null;
			out += next;
			i += 1;
		} else {
			out += ch === SLASH ? '/' : ch;
		}
	}
	return out;
}

/** mulberry32: a seeded PRNG, so a failure names the case that broke. */
function prng(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const REV1 = { enabled: new Set(), capabilities: new Set(['IMAP4rev1']) } as unknown as ImapFlow;

/** Chars that matter to the escape, to modified UTF-7 and to LIST patterns. */
const ALPHABET = ['/', SLASH, ESCAPE, 'a', 'Z', ' ', '&', '-', '%', '*', '"', '\\', 'Ü', '📁'];

function randomNames(count: number, seed: number): string[] {
	const next = prng(seed);
	return Array.from({ length: count }, () => {
		const length = 1 + Math.floor(next() * 8);
		return Array.from({ length }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]).join('');
	});
}

/** Every string of up to `max` chars over `chars`. */
function allNames(chars: readonly string[], max: number): string[] {
	let level = [''];
	const out: string[] = [];
	for (let n = 1; n <= max; n++) {
		level = level.flatMap((prefix) => chars.map((c) => prefix + c));
		out.push(...level);
	}
	return out;
}

const count = (s: string, ch: string): number => s.split(ch).length - 1;

describe('levelName is injective and reads back', () => {
	const check = (names: readonly string[]) => {
		const seen = new Map<string, string>();
		for (const name of names) {
			const level = levelName(folder('x', name));
			expect(level).not.toContain('/');
			expect(count(level, '%')).toBe(count(name, '%'));
			expect(count(level, '*')).toBe(count(name, '*'));
			expect(decodeLevel(level)).toBe(name);
			// Through modified UTF-7 and back, ours and ImapFlow's.
			const wire = encodeMailboxName(level);
			expect(decodeMailboxName(wire)).toBe(level);
			expect(decodePath(REV1, encodePath(REV1, level))).toBe(level);
			const other = seen.get(level);
			if (other !== undefined && other !== name) {
				throw new Error(`${JSON.stringify(name)} and ${JSON.stringify(other)} meet`);
			}
			seen.set(level, name);
		}
	};

	it('for every name of up to 6 chars over "/", "∕", "⧵" and "a"', () => {
		check(allNames(['/', SLASH, ESCAPE, 'a'], 6));
	});

	it('for 20,000 random names over the chars that matter', () => {
		check(randomNames(20_000, 1295));
	});

	it('so every random name, top level or nested, resolves to its own folder', async () => {
		const names = [...new Set(randomNames(400, 1296))];
		const folders = names.map((name, i) =>
			folder(`f${i}`, name, i % 2 === 1 ? { parentId: 'f0' } : {})
		);
		const convex = { query: async () => folders } as unknown as ConvexClient;
		for (const f of buildFolderTree(folders)) {
			const wire = f.path.split('/').map(encodeMailboxName).join('/');
			expect((await resolveFolderByName(convex, 'mb', wire))?._id).toBe(f._id);
		}
	});
});

describe('resolveFolderByName with paths', () => {
	const convexFor = (folders: FolderRow[]) =>
		({ query: async () => folders }) as unknown as ConvexClient;

	it('a "/" name and its look-alike keep their own names through create, rename and delete', async () => {
		let folders: FolderRow[] = [folder('slash', 'A/B')];
		const convex = { query: async () => folders } as unknown as ConvexClient;
		const resolve = async (wire: string) => (await resolveFolderByName(convex, 'mb', wire))?._id;
		const slashName = encodeMailboxName(levelName(folder('x', 'A/B')));
		const lookAlikeName = encodeMailboxName(levelName(folder('x', 'A∕B')));
		expect(slashName).not.toBe(lookAlikeName);
		expect(await resolve(slashName)).toBe('slash');

		// The look-alike is created: each name still reaches its own folder.
		folders = [...folders, folder('look', 'A∕B')];
		expect(await resolve(slashName)).toBe('slash');
		expect(await resolve(lookAlikeName)).toBe('look');

		// The first is renamed: its old name reaches nothing, not the look-alike.
		folders = [folder('slash', 'C'), folder('look', 'A∕B')];
		expect(await resolve(slashName)).toBeUndefined();
		expect(await resolve('C')).toBe('slash');
		expect(await resolve(lookAlikeName)).toBe('look');

		// The first is deleted: the look-alike keeps its name.
		folders = [folder('look', 'A∕B')];
		expect(await resolve(lookAlikeName)).toBe('look');
		expect(await resolve(slashName)).toBeUndefined();
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
