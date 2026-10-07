import { describe, expect, it } from 'vitest';
import type { ImapFlow } from 'imapflow';
import { decodePath, encodePath } from 'imapflow/lib/tools.js';
import type { ConvexClient, FolderRow } from '../../../convex.js';
import { buildFolderTree, levelName, topLevelName } from '../folderTree.js';
import { resolveFolderByName } from '../folders.js';
import {
	MAX_PATTERN_LENGTH,
	MAX_PATTERN_WILDCARDS,
	matchesPattern,
	pathFromClient,
	patternOverLimit,
} from '../mailboxPattern.js';
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

/** Ids as Convex writes them: lowercase base32 (no i, l, o, u), 32 chars. */
const ID_CHARS = '0123456789abcdefghjkmnpqrstvwxyz';

function randomIds(count: number, seed: number): string[] {
	const next = prng(seed);
	return Array.from({ length: count }, () =>
		Array.from({ length: 32 }, () => ID_CHARS[Math.floor(next() * ID_CHARS.length)]).join('')
	);
}

/** Every spelling of INBOX: inbox, Inbox, iNbOx, ..., INBOX. */
const INBOX_CASES = Array.from({ length: 32 }, (_, mask) =>
	[...'inbox'].map((c, i) => ((mask >> i) & 1 ? c.toUpperCase() : c)).join('')
);

/** The path a client writes for `path`, each level in modified UTF-7. */
const wireOf = (path: string): string => path.split('/').map(encodeMailboxName).join('/');

describe('a top-level folder named INBOX in some case', () => {
	it('is listed as its name, a "⧵" and its id; the inbox and nested folders are not', () => {
		expect(new Set(INBOX_CASES).size).toBe(32);
		expect(
			pathsOf([
				folder('inbox', 'Inbox', { role: 'inbox' }),
				folder('k57c', 'Inbox'),
				folder('j9x2', 'inbox', { role: 'archive' }),
				folder('w', 'Work'),
				folder('n', 'Inbox', { parentId: 'w' }),
				folder('r', 'Receipts', { parentId: 'k57c' }),
				folder('orphan', 'INBOX', { parentId: 'gone' }),
				folder('near', 'Inbox2'),
			])
		).toEqual({
			inbox: 'INBOX',
			k57c: 'Inbox⧵k57c',
			j9x2: 'inbox⧵j9x2',
			w: 'Work',
			n: 'Work/Inbox',
			r: 'Inbox⧵k57c/Receipts',
			orphan: 'INBOX⧵orphan',
			near: 'Inbox2',
		});
	});

	it('keeps its plain name when its id could not stand in a name', () => {
		for (const id of ['a/b', 'a*', '%', '⧵x', '∕x', '']) {
			expect(topLevelName(folder(id, 'Inbox'))).toBe('Inbox');
		}
	});

	it('leaves the top level of every other name as levelName writes it', () => {
		for (const name of [...allNames(['/', SLASH, ESCAPE, 'a'], 5), ...randomNames(5_000, 1302)]) {
			expect(topLevelName(folder('k57c', name))).toBe(levelName(folder('k57c', name)));
		}
	});

	describe('its name is one no stored name is ever written as', () => {
		const aliases = INBOX_CASES.flatMap((name) =>
			randomIds(20, 1302).map((id) => topLevelName(folder(id, name)))
		);

		it('levelName never writes "⧵" before a char other than "⧵" or "∕", so no alias reads back', () => {
			for (const alias of aliases) {
				expect(alias).toMatch(/^[a-z]{5}⧵[0-9a-z]{32}$/i);
				expect(decodeLevel(alias)).toBeNull();
			}
		});

		it('for every name of up to 5 chars after an INBOX spelling, over "⧵", "∕", "/" and id chars', () => {
			const ids = allNames(['k', '5'], 3);
			const reserved = new Set(
				['Inbox', 'inbox'].flatMap((name) => ids.map((id) => topLevelName(folder(id, name))))
			);
			const names = allNames([ESCAPE, SLASH, '/', 'k', '5'], 5).flatMap((s) => [
				`Inbox${s}`,
				`inbox${s}`,
			]);
			for (const name of names) {
				expect(reserved.has(levelName(folder('x', name)))).toBe(false);
			}
		});

		it('for 20,000 random names and every alias above', () => {
			const reserved = new Set(aliases);
			for (const name of randomNames(20_000, 1303)) {
				expect(reserved.has(levelName(folder('x', name)))).toBe(false);
				expect(reserved.has(levelName(folder('x', `Inbox${ESCAPE}${name}`)))).toBe(false);
			}
		});
	});

	it('no two folders share a path, even with the same name, and each path resolves to its folder', async () => {
		const ids = randomIds(300, 1304);
		const folders = [
			folder('inbox', 'INBOX', { role: 'inbox' }),
			// Duplicate names on purpose: the id alone keeps two aliases apart.
			...ids.map((id, i) => folder(id, INBOX_CASES[i % 4]!)),
			...ids.slice(0, 50).map((id, i) => folder(`c${i}`, 'Inbox', { parentId: id })),
			...randomNames(300, 1305).map((name, i) => folder(`o${i}`, `${name}${i}`)),
		];
		const tree = buildFolderTree(folders);
		expect(new Set(tree.map((f) => f.path)).size).toBe(folders.length);
		const convex = { query: async () => folders } as unknown as ConvexClient;
		for (const f of tree) {
			expect((await resolveFolderByName(convex, 'mb', wireOf(f.path)))?._id).toBe(f._id);
		}
	});

	it('keeps its name and its folder while other folders are created, renamed and deleted', async () => {
		const target = folder('k57cvz2c1dyq9f3hbn3hq6b9n7rjf3xa', 'Inbox');
		const alias = 'Inbox⧵k57cvz2c1dyq9f3hbn3hq6b9n7rjf3xa';
		// Names that compete with the alias: other INBOX spellings, the alias
		// itself and its look-alikes as stored names, numbered variants.
		const competing = [
			'inbox',
			'INBOX',
			alias,
			`Inbox${ESCAPE}${ESCAPE}k57c`,
			`Inbox${SLASH}k57c`,
			'Inbox/k57c',
			'Inbox (2)',
			'Inbox2',
			...INBOX_CASES,
		];
		const next = prng(1306);
		const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
		let others: FolderRow[] = [folder('inbox', 'INBOX', { role: 'inbox' })];
		const convex = { query: async () => [...others, target] } as unknown as ConvexClient;
		const pathOfTarget = () => buildFolderTree([...others, target]).at(-1)!.path;
		let serial = 0;

		expect(pathOfTarget()).toBe(alias);
		for (let step = 0; step < 400; step++) {
			const op = next();
			const movable = others.filter((f) => f.role !== 'inbox');
			if (op < 0.5 || movable.length === 0) {
				const parentId = next() < 0.3 ? pick(others)._id : undefined;
				others = [...others, folder(randomIds(1, ++serial)[0]!, pick(competing), { parentId })];
			} else if (op < 0.8) {
				const victim = pick(movable);
				others = others.map((f) => (f === victim ? { ...f, name: pick(competing) } : f));
			} else {
				const victim = pick(movable);
				others = others.filter((f) => f !== victim);
			}
			expect(pathOfTarget()).toBe(alias);
			expect((await resolveFolderByName(convex, 'mb', wireOf(alias)))?._id).toBe(target._id);
			expect((await resolveFolderByName(convex, 'mb', 'Inbox'))?._id).toBe('inbox');
		}
	});

	it('gets an ordinary name back once it is renamed', () => {
		expect(pathsOf([folder('k57c', 'Inbox old')])).toEqual({ k57c: 'Inbox old' });
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

	describe('folds ASCII case level by level', () => {
		// Names are unique as written, so `Work` and `WORK` can both exist, and
		// `Notes` under one with `notes` under the other.
		const convex = convexFor([
			folder('inbox', 'INBOX', { role: 'inbox' }),
			folder('work', 'Work'),
			folder('WORK', 'WORK'),
			folder('w-notes', 'Notes', { parentId: 'work' }),
			folder('W-notes', 'notes', { parentId: 'WORK' }),
			folder('w-ueber', 'Übersicht', { parentId: 'work' }),
			folder('ueber', 'Übersicht2'),
			folder('u-receipts', 'Receipts', { parentId: 'ueber' }),
			folder('i-receipts', 'Receipts2', { parentId: 'inbox' }),
			folder('fake-inbox', 'Inbox'),
			folder('f-receipts', 'Receipts2b', { parentId: 'fake-inbox' }),
		]);
		const resolve = async (wire: string) => (await resolveFolderByName(convex, 'mb', wire))?._id;

		it.each([
			// An ASCII level folds next to a non-ASCII one, which must match exactly.
			['&ANw-bersicht2/receipts', 'u-receipts'],
			['work/&ANw-bersicht', 'w-ueber'],
			['WoRk/&ANw-bersicht', 'w-ueber'],
			// The exact path wins before any fold.
			['Work/Notes', 'w-notes'],
			['WORK/notes', 'W-notes'],
			// INBOX in any case is the inbox, and its children fold below it.
			['inbox/receipts2', 'i-receipts'],
			['Inbox/RECEIPTS2', 'i-receipts'],
		])('%j → %j', async (wire, id) => {
			expect(await resolve(wire)).toBe(id);
		});

		it.each([
			// Two folders fold to work/notes: no fold picks between them.
			['work/notes'],
			['Work/notes'],
			// A non-ASCII level is never folded.
			['work/&APw-bersicht'],
			['&ANw-BERSICHT2/receipts'],
			// The first level INBOX is the inbox, never the folder named Inbox.
			['inbox/receipts2b'],
		])('%j → no folder', async (wire) => {
			expect(await resolve(wire)).toBeUndefined();
		});
	});

	it('folds an all-ASCII path only when one folder matches', async () => {
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

	it.each([
		['*a'.repeat(2000) + 'b', 'a'.repeat(5000), false],
		['%a'.repeat(2000), 'a'.repeat(5000), true],
		['*a'.repeat(4000) + 'b', 'a'.repeat(10_000), false],
		['%/'.repeat(500) + '*', 'x/'.repeat(1000), true],
	])(
		'fills at most (pattern + 1) × (path + 1) cells, with no backtracking (%#)',
		(pattern, path, expected) => {
			const meter = { cells: 0 };
			expect(matchesPattern(pattern, path, meter)).toBe(expected);
			expect(meter.cells).toBeGreaterThan(0);
			expect(meter.cells).toBeLessThanOrEqual((pattern.length + 1) * (path.length + 1));
		}
	);

	it('stops at the first row nothing reaches', () => {
		const meter = { cells: 0 };
		expect(matchesPattern('b' + '*a'.repeat(2000), 'a'.repeat(5000), meter)).toBe(false);
		expect(meter.cells).toBe(2 * 5001);
	});
});

describe('patternOverLimit', () => {
	it.each([
		['*', null],
		['a'.repeat(MAX_PATTERN_LENGTH), null],
		['%'.repeat(MAX_PATTERN_WILDCARDS), null],
		['a'.repeat(MAX_PATTERN_LENGTH + 1), `pattern longer than ${MAX_PATTERN_LENGTH} chars`],
		[
			'*'.repeat(MAX_PATTERN_WILDCARDS + 1),
			`pattern with more than ${MAX_PATTERN_WILDCARDS} wildcards`,
		],
	])('%#', (raw, reason) => {
		expect(patternOverLimit(raw)).toBe(reason);
	});
});
