/**
 * Mailbox names on the wire, through the real pump, read and written the way
 * ImapFlow does it: its response parser and modified UTF-7 decoder on LIST,
 * LSUB and STATUS output, and its encoder and command compiler for the name it
 * then SELECTs (RFC 3501 §5.1.3). Every stored name has to come back exactly
 * and lead to its own folder.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parser } from 'imapflow/lib/handler/imap-handler.js';
import { decodePath } from 'imapflow/lib/tools.js';
import type { ConvexClient, FolderRow } from '../convex.js';
import { resolveFolderByName } from '../commands/helpers/folders.js';
import {
	REV1,
	exchange,
	imapflowSelect,
	listedNames,
	loggedIn as loggedInWith,
	selectedIds,
	targetIds,
	withCounters,
} from './imapWire.js';

vi.mock('../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * The issue's names, a few more that need encoding, and one with a line
 * break. Then names that differ only in case, a stored name that only looks
 * encoded next to the name it would decode to, and ASCII names for the
 * case-folded lookup.
 */
const NAMES = [
	'Projekte "Q4"',
	'Ablage\\2026',
	'Übersicht',
	'📁 Mail',
	'R&D',
	'Ablage/Übersicht',
	'Alt\r\nName',
	'übersicht',
	'&ANw-&AOQ-',
	'Üä',
	'Receipts',
	'Notes',
	'NOTES',
];

const folderNamed = (name: string): FolderRow => FOLDERS.find((f) => f.name === name)!;

const FOLDERS: FolderRow[] = withCounters([
	{ _id: 'f-inbox', name: 'INBOX', role: 'inbox', subscribed: true },
	...NAMES.map((name, i) => ({ _id: `f-${i}`, name, subscribed: i % 2 === 0 })),
]);

/**
 * The name LIST gives a stored one: a `/` inside a single folder's name would
 * read as a hierarchy level, so it is sent as U+2215 (`folderTree.ts`).
 */
const listedAs = (name: string): string => name.replaceAll('/', '\u2215');

const loggedIn = () => loggedInWith(FOLDERS);

afterEach(() => {
	vi.clearAllMocks();
});

describe('LIST and LSUB mailbox names', () => {
	it('LIST gives every stored name back, one line each, to a client parser', async () => {
		const { socket } = await loggedIn();
		const out = await exchange(socket, 'a1', 'a1 LIST "" "*"');
		expect(out.at(-1)).toBe('a1 OK LIST completed');
		expect(out.filter((l) => !l.startsWith('* LIST ')).length).toBe(1);
		expect(await listedNames(out, 'LIST')).toEqual(FOLDERS.map((f) => listedAs(f.name)));
	});

	it('writes the scenario names quoted and modified UTF-7 encoded', async () => {
		const { socket } = await loggedIn();
		const out = await exchange(socket, 'a1', 'a1 LIST "" "*"');
		expect(out).toContain('* LIST (\\HasNoChildren) "/" "Projekte \\"Q4\\""');
		expect(out).toContain('* LIST (\\HasNoChildren) "/" "Ablage\\\\2026"');
		expect(out).toContain('* LIST (\\HasNoChildren) "/" "&ANw-bersicht"');
		expect(out).toContain('* LIST (\\HasNoChildren) "/" "&2D3cwQ- Mail"');
		expect(out).toContain('* LIST (\\HasNoChildren) "/" "R&-D"');
		expect(out).toContain('* LIST (\\HasNoChildren) "/" "Ablage&IhUA3A-bersicht"');
		expect(out).toContain('* LIST (\\HasNoChildren) "/" "Alt&AA0ACg-Name"');
	});

	it('LSUB gives the subscribed names back', async () => {
		const { socket } = await loggedIn();
		const out = await exchange(socket, 'a1', 'a1 LSUB "" "*"');
		expect(out.at(-1)).toBe('a1 OK LSUB completed');
		expect(await listedNames(out, 'LSUB')).toEqual(
			FOLDERS.filter((f) => f.subscribed).map((f) => listedAs(f.name))
		);
	});
});

describe('LIST → SELECT round trip', () => {
	it('SELECT with the name ImapFlow read from LIST opens that folder', async () => {
		const { socket, convex } = await loggedIn();
		const listed = await listedNames(await exchange(socket, 'a1', 'a1 LIST "" "*"'), 'LIST');
		// ImapFlow does not encode CR or LF (tools.js encodePath) and refuses to
		// quote them, so it cannot name that folder at all; the next test does.
		const selectable = listed.filter((name) => !/[\r\n]/.test(name));
		expect(selectable).toHaveLength(FOLDERS.length - 1);

		for (const [i, name] of selectable.entries()) {
			const tag = `s${i}`;
			const out = await exchange(socket, tag, await imapflowSelect(tag, name));
			expect(out.at(-1)).toBe(`${tag} OK [READ-WRITE] SELECT completed`);
		}
		expect(selectedIds(convex)).toEqual(
			FOLDERS.filter((f) => !/[\r\n]/.test(f.name)).map((f) => f._id)
		);
	});

	it('SELECT with the encoded form of a name holding CR LF opens that folder', async () => {
		const { socket, convex } = await loggedIn();
		const out = await exchange(socket, 's1', 's1 SELECT "Alt&AA0ACg-Name"');
		expect(out.at(-1)).toBe('s1 OK [READ-WRITE] SELECT completed');
		expect(selectedIds(convex)).toEqual([FOLDERS.find((f) => f.name === 'Alt\r\nName')!._id]);
	});

	it('a raw UTF-8 name, as clients sent before names were decoded, still opens the folder', async () => {
		const { socket, convex } = await loggedIn();
		const out = await exchange(socket, 's1', 's1 EXAMINE "Übersicht"');
		expect(out.at(-1)).toBe('s1 OK [READ-ONLY] EXAMINE completed');
		expect(selectedIds(convex)).toEqual([FOLDERS.find((f) => f.name === 'Übersicht')!._id]);
	});
});

describe('STATUS mailbox names', () => {
	it('STATUS with a modified UTF-7 name answers for that folder under the same name', async () => {
		const { socket } = await loggedIn();
		const folder = FOLDERS.find((f) => f.name === 'Übersicht')!;
		const out = await exchange(socket, 't1', 't1 STATUS "&ANw-bersicht" (UNSEEN UIDVALIDITY)');
		expect(out).toEqual([
			`* STATUS "&ANw-bersicht" (UNSEEN ${folder.unseenCount} UIDVALIDITY ${folder.uidValidity})`,
			't1 OK STATUS completed',
		]);
		const parsed = await parser(out[0]!);
		expect(decodePath(REV1, String(parsed.attributes?.[0]?.value))).toBe('Übersicht');
	});

	it.each([
		['Projekte "Q4"', '"Projekte \\"Q4\\""'],
		['Ablage\\2026', '"Ablage\\\\2026"'],
		['Alt\r\nName', '"Alt&AA0ACg-Name"'],
	])('STATUS frames %j on one line as %s', async (name, quoted) => {
		const { socket } = await loggedIn();
		const out = await exchange(socket, 't1', `t1 STATUS ${quoted} (MESSAGES)`);
		expect(out).toEqual([`* STATUS ${quoted} (MESSAGES 0)`, 't1 OK STATUS completed']);
		const parsed = await parser(out[0]!);
		expect(decodePath(REV1, String(parsed.attributes?.[0]?.value))).toBe(name);
	});
});

describe('names that differ only in case or in how they are encoded', () => {
	/** Each pair: the name LIST writes, and the stored name it must reach. */
	const PAIRS: Array<[string, string]> = [
		['"&ANw-bersicht"', 'Übersicht'],
		['"&APw-bersicht"', 'übersicht'],
		['"&-ANw-&-AOQ-"', '&ANw-&AOQ-'],
		['"&ANwA5A-"', 'Üä'],
	];

	it('LIST writes each of them in a form of its own', async () => {
		const { socket } = await loggedIn();
		const out = await exchange(socket, 'a1', 'a1 LIST "" "*"');
		for (const [wire] of PAIRS) {
			expect(out.filter((l) => l.endsWith(` "/" ${wire}`))).toHaveLength(1);
		}
	});

	it('SELECT with each listed name opens its own folder', async () => {
		const { socket, convex } = await loggedIn();
		for (const [i, [wire]] of PAIRS.entries()) {
			const out = await exchange(socket, `s${i}`, `s${i} SELECT ${wire}`);
			expect(out.at(-1)).toBe(`s${i} OK [READ-WRITE] SELECT completed`);
		}
		expect(selectedIds(convex)).toEqual(PAIRS.map(([, name]) => folderNamed(name)._id));
	});

	it.each(['COPY', 'MOVE'] as const)(
		'%s with each listed name lands in its own folder',
		async (verb) => {
			const targets: unknown[] = [];
			for (const [wire] of PAIRS) {
				const { socket, convex } = await loggedIn();
				await exchange(socket, 's1', 's1 SELECT INBOX');
				const out = await exchange(socket, 'c1', `c1 ${verb} 1 ${wire}`);
				expect(out.at(-1)).toMatch(new RegExp(`^c1 OK .*${verb} completed$`));
				targets.push(...targetIds(convex, verb === 'COPY' ? 'copy' : 'move'));
			}
			expect(targets).toEqual(PAIRS.map(([, name]) => folderNamed(name)._id));
		}
	);

	it('a stored name that only looks encoded is reached by its raw form too', async () => {
		const { socket, convex } = await loggedIn();
		const out = await exchange(socket, 's1', 's1 SELECT "&ANw-&AOQ-"');
		expect(out.at(-1)).toBe('s1 OK [READ-WRITE] SELECT completed');
		expect(selectedIds(convex)).toEqual([folderNamed('&ANw-&AOQ-')._id]);
	});
});

describe('resolveFolderByName (SELECT, EXAMINE, STATUS, APPEND, COPY, MOVE)', () => {
	const convex = { query: async () => FOLDERS } as unknown as ConvexClient;

	it.each([
		['&ANw-bersicht', 'Übersicht'],
		['&APw-bersicht', 'übersicht'],
		['Ablage&IhUA3A-bersicht', 'Ablage/Übersicht'],
		['R&-D', 'R&D'],
		['&2D3cwQ- Mail', '📁 Mail'],
		['&ANwA5A-', 'Üä'],
		['&ANw-&AOQ-', '&ANw-&AOQ-'],
		['&-ANw-&-AOQ-', '&ANw-&AOQ-'],
		['inbox', 'INBOX'],
		['InBox', 'INBOX'],
		// ASCII names still match with A-Z folded, when one folder matches.
		['receipts', 'Receipts'],
		['NOTES', 'NOTES'],
		['Notes', 'Notes'],
	])('%j → %j', async (wire, name) => {
		const folder = await resolveFolderByName(convex, 'mb1', wire);
		expect(folder?.name).toBe(name);
	});

	it.each([
		// An encoded run is case-sensitive; ÜBERSICHT is no folder.
		['&ANw-BERSICHT'],
		// A non-ASCII name is matched as written, never case-folded.
		['ÜBERSICHT'],
		// Two folders fold to `notes`: no fold picks between them.
		['notes'],
	])('%j → no folder', async (wire) => {
		expect(await resolveFolderByName(convex, 'mb1', wire)).toBeNull();
	});
});
