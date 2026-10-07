/**
 * LIST and LSUB over the folder tree (RFC 3501 §6.3.8, §6.3.9), through the
 * real pump and read with ImapFlow's parser: the reference and pattern select
 * what is listed, nested folders are listed by their path, `\HasChildren` comes
 * from the tree, and the path a client read opens that folder in SELECT,
 * STATUS, APPEND, COPY and MOVE.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parser } from 'imapflow/lib/handler/imap-handler.js';
import { decodePath } from 'imapflow/lib/tools.js';
import type { FolderRow } from '../convex.js';
import {
	REV1,
	appendedIds,
	exchange,
	imapflowCommand,
	imapflowLine,
	imapflowSelect,
	listedEntries,
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
 * A mailbox with nesting under a user folder and under INBOX, a top-level name
 * that shares a prefix with a parent, a non-ASCII nested name, a folder whose
 * own name holds a `/`, and one whose parent is gone. `Work` is not
 * subscribed but has subscribed folders below it.
 */
const FOLDERS: FolderRow[] = withCounters([
	{ _id: 'f-inbox', name: 'INBOX', role: 'inbox', subscribed: true },
	{ _id: 'f-sent', name: 'Sent', role: 'sent', subscribed: true },
	{ _id: 'f-work', name: 'Work', subscribed: false },
	{ _id: 'f-clients', name: 'Clients', parentId: 'f-work', subscribed: true },
	{ _id: 'f-2025', name: '2025', parentId: 'f-clients', subscribed: true },
	{ _id: 'f-ueber', name: 'Übersicht', parentId: 'f-work', subscribed: false },
	{ _id: 'f-workshop', name: 'Workshop', subscribed: true },
	{ _id: 'f-receipts', name: 'Receipts', parentId: 'f-inbox', subscribed: true },
	{ _id: 'f-slash', name: 'Clients/2026', subscribed: true },
	{ _id: 'f-orphan', name: 'Orphan', parentId: 'f-deleted', subscribed: true },
]);

/** Each folder's path, as LIST must give it. */
const PATHS: Record<string, string> = {
	'f-inbox': 'INBOX',
	'f-sent': 'Sent',
	'f-work': 'Work',
	'f-clients': 'Work/Clients',
	'f-2025': 'Work/Clients/2025',
	'f-ueber': 'Work/Übersicht',
	'f-workshop': 'Workshop',
	'f-receipts': 'INBOX/Receipts',
	'f-slash': 'Clients∕2026',
	'f-orphan': 'Orphan',
};

const idOf = (path: string): string => Object.keys(PATHS).find((id) => PATHS[id] === path)!;
const pathsOf = (...ids: string[]): string[] => ids.map((id) => PATHS[id]!);

const loggedIn = () => loggedInWith(FOLDERS);

async function list(command: string, verb: 'LIST' | 'LSUB' = 'LIST') {
	const { socket } = await loggedIn();
	const out = await exchange(socket, 'l1', `l1 ${command}`);
	expect(out.at(-1)).toBe(`l1 OK ${verb} completed`);
	return out;
}

afterEach(() => {
	vi.clearAllMocks();
});

describe('LIST reference and pattern', () => {
	it('LIST "" "" answers with the delimiter and the root only', async () => {
		const out = await list('LIST "" ""');
		expect(out).toEqual(['* LIST (\\Noselect) "/" ""', 'l1 OK LIST completed']);
		const parsed = await parser(out[0]!);
		expect(parsed.attributes?.[1]?.value).toBe('/');
	});

	it('LIST "" "*" lists every folder by its path', async () => {
		const out = await list('LIST "" "*"');
		expect(await listedNames(out, 'LIST')).toEqual(FOLDERS.map((f) => PATHS[f._id]));
	});

	it('LIST "" "%" lists the top level only', async () => {
		const out = await list('LIST "" "%"');
		expect(await listedNames(out, 'LIST')).toEqual(
			pathsOf('f-inbox', 'f-sent', 'f-work', 'f-workshop', 'f-slash', 'f-orphan')
		);
	});

	it('LIST "Work/" "%" lists the level below Work', async () => {
		const out = await list('LIST "Work/" "%"');
		expect(await listedNames(out, 'LIST')).toEqual(pathsOf('f-clients', 'f-ueber'));
	});

	it('LIST "Work/" "*" lists everything below Work', async () => {
		const out = await list('LIST "Work/" "*"');
		expect(await listedNames(out, 'LIST')).toEqual(pathsOf('f-clients', 'f-2025', 'f-ueber'));
	});

	it('LIST "" "Work%" matches top-level names only, without crossing the delimiter', async () => {
		const out = await list('LIST "" "Work%"');
		expect(await listedNames(out, 'LIST')).toEqual(pathsOf('f-work', 'f-workshop'));
	});

	it('LIST "" "%/%/%" lists the third level', async () => {
		const out = await list('LIST "" "%/%/%"');
		expect(await listedNames(out, 'LIST')).toEqual(pathsOf('f-2025'));
	});

	it('LIST with a full path is an existence check for that one folder', async () => {
		expect(await listedNames(await list('LIST "" "Work/Clients"'), 'LIST')).toEqual(
			pathsOf('f-clients')
		);
		expect(await listedNames(await list('LIST "Work/" "Clients/2025"'), 'LIST')).toEqual(
			pathsOf('f-2025')
		);
	});

	it('LIST with a name that is no folder answers with nothing', async () => {
		expect(await list('LIST "" "Archive/2025"')).toEqual(['l1 OK LIST completed']);
		// A leaf name alone is not a path: Clients lives under Work.
		expect(await list('LIST "" "Clients"')).toEqual(['l1 OK LIST completed']);
	});

	it('a modified UTF-7 pattern matches the non-ASCII nested name', async () => {
		const out = await list('LIST "Work/" "&ANw-*"');
		expect(out).toEqual([
			'* LIST (\\HasNoChildren) "/" "Work/&ANw-bersicht"',
			'l1 OK LIST completed',
		]);
		expect(await listedNames(out, 'LIST')).toEqual(['Work/Übersicht']);
	});

	it('INBOX in any case matches the inbox in a pattern, and its children below it', async () => {
		expect(await listedNames(await list('LIST "" "inbox"'), 'LIST')).toEqual(['INBOX']);
		expect(await listedNames(await list('LIST "" "Inbox/%"'), 'LIST')).toEqual(['INBOX/Receipts']);
	});

	it.each([
		['LIST (SUBSCRIBED) "" "*"'],
		['LIST "" "*" RETURN (STATUS (MESSAGES UNSEEN))'],
		['LIST "" "*" "%"'],
		['LIST ""'],
		['LSUB "" "*" RETURN (CHILDREN)'],
	])('%s is refused: LIST-EXTENDED syntax is not supported', async (command) => {
		const { socket } = await loggedIn();
		const out = await exchange(socket, 'l1', `l1 ${command}`);
		expect(out).toEqual(['l1 BAD LIST and LSUB take <reference> <mailbox>']);
	});
});

describe('LIST hierarchy attributes', () => {
	it('a folder with folders below it has \\HasChildren, every other \\HasNoChildren', async () => {
		const entries = await listedEntries(await list('LIST "" "*"'), 'LIST');
		const withChildren = entries
			.filter((e) => e.flags.includes('\\HasChildren'))
			.map((e) => e.path);
		expect(withChildren).toEqual(pathsOf('f-inbox', 'f-work', 'f-clients'));
		for (const e of entries) {
			expect(e.delimiter).toBe('/');
			expect(e.flags.filter((f) => /^\\Has(No)?Children$/.test(f))).toHaveLength(1);
		}
		expect(entries.find((e) => e.path === 'Sent')?.flags).toEqual(['\\Sent', '\\HasNoChildren']);
	});

	it('a folder whose own name holds a "/" is one level, not a phantom parent', async () => {
		const out = await list('LIST "" "*"');
		expect(out).toContain('* LIST (\\HasNoChildren) "/" "Clients&IhU-2026"');
		const entry = (await listedEntries(out, 'LIST')).find((e) => e.path.startsWith('Clients'));
		expect(entry?.path.split(entry.delimiter)).toEqual(['Clients∕2026']);
	});
});

describe('LSUB', () => {
	it('LSUB "" "*" lists the subscribed folders only, by path', async () => {
		const out = await list('LSUB "" "*"', 'LSUB');
		expect(await listedNames(out, 'LSUB')).toEqual(
			FOLDERS.filter((f) => f.subscribed).map((f) => PATHS[f._id])
		);
	});

	it('LSUB "" "%" returns an unsubscribed parent of subscribed folders as \\Noselect', async () => {
		const entries = await listedEntries(await list('LSUB "" "%"', 'LSUB'), 'LSUB');
		expect(entries.map((e) => e.path)).toEqual(
			pathsOf('f-inbox', 'f-sent', 'f-work', 'f-workshop', 'f-slash', 'f-orphan')
		);
		expect(entries.find((e) => e.path === 'Work')?.flags).toEqual(['\\Noselect']);
	});

	it('LSUB "Work/" "%" leaves out an unsubscribed folder with nothing subscribed below', async () => {
		const out = await list('LSUB "Work/" "%"', 'LSUB');
		expect(await listedNames(out, 'LSUB')).toEqual(pathsOf('f-clients'));
	});

	it('LSUB "" "" answers with nothing', async () => {
		expect(await list('LSUB "" ""', 'LSUB')).toEqual(['l1 OK LSUB completed']);
	});
});

describe('the listed path reaches its folder', () => {
	it('SELECT with each path ImapFlow read from LIST opens that folder', async () => {
		const { socket, convex } = await loggedIn();
		const listed = await listedNames(await exchange(socket, 'a1', 'a1 LIST "" "*"'), 'LIST');
		for (const [i, path] of listed.entries()) {
			const out = await exchange(socket, `s${i}`, await imapflowSelect(`s${i}`, path));
			expect(out.at(-1)).toBe(`s${i} OK [READ-WRITE] SELECT completed`);
		}
		expect(selectedIds(convex)).toEqual(FOLDERS.map((f) => f._id));
	});

	it.each([
		['work/clients/2025', 'f-2025'],
		['inbox/receipts', 'f-receipts'],
		['INBOX/Receipts', 'f-receipts'],
		['"Work/&ANw-bersicht"', 'f-ueber'],
		['"Work/Übersicht"', 'f-ueber'],
		['"Clients&IhU-2026"', 'f-slash'],
	])('SELECT %s opens its folder', async (name, id) => {
		const { socket, convex } = await loggedIn();
		const out = await exchange(socket, 's1', `s1 SELECT ${name}`);
		expect(out.at(-1)).toBe('s1 OK [READ-WRITE] SELECT completed');
		expect(selectedIds(convex)).toEqual([id]);
	});

	it.each([['Clients'], ['2025'], ['Clients/2026'], ['Work/2025']])(
		'SELECT %s, a leaf name or a path that is not there, opens nothing',
		async (name) => {
			const { socket, convex } = await loggedIn();
			const out = await exchange(socket, 's1', `s1 SELECT "${name}"`);
			expect(out).toEqual(['s1 NO Mailbox not found']);
			expect(selectedIds(convex)).toEqual([]);
		}
	);

	it.each(['Work/Clients/2025', 'Work/Übersicht', 'INBOX/Receipts', 'Clients∕2026'])(
		'STATUS %s answers for that folder under its path',
		async (path) => {
			const { socket } = await loggedIn();
			const folder = FOLDERS.find((f) => f._id === idOf(path))!;
			const command = await imapflowCommand('t1', 'STATUS', [{ path }, ['UNSEEN']]);
			const out = await exchange(socket, 't1', command);
			expect(out.at(-1)).toBe('t1 OK STATUS completed');
			expect(out[0]).toMatch(new RegExp(` \\(UNSEEN ${folder.unseenCount}\\)$`));
			const parsed = await parser(out[0]!);
			expect(decodePath(REV1, String(parsed.attributes?.[0]?.value))).toBe(path);
		}
	);

	describe('APPEND', () => {
		beforeEach(() => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response(JSON.stringify({ storageId: 'sid1' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
			);
		});
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it.each(['Work/Clients', 'Work/Übersicht', 'INBOX/Receipts', 'Clients∕2026'])(
			'APPEND to %s stores into that folder',
			async (path) => {
				const { socket, convex } = await loggedIn();
				const body = 'Subject: hi\r\n\r\nhello\r\n';
				const out = await exchange(
					socket,
					'p1',
					Buffer.concat([
						await imapflowLine('p1', 'APPEND', [{ path }]),
						Buffer.from(` {${Buffer.byteLength(body)}+}\r\n${body}\r\n`),
					])
				);
				expect(out.at(-1)).toBe('p1 OK [APPENDUID 1 1] APPEND completed');
				expect(appendedIds(convex)).toEqual([idOf(path)]);
			}
		);
	});

	it.each(['COPY', 'MOVE'] as const)('%s to a nested path lands in that folder', async (verb) => {
		const targets: unknown[] = [];
		const paths = ['Work/Clients/2025', 'Work/Übersicht', 'INBOX/Receipts', 'Clients∕2026'];
		for (const path of paths) {
			const { socket, convex } = await loggedIn();
			await exchange(socket, 's1', 's1 SELECT INBOX');
			const out = await exchange(socket, 'c1', await imapflowCommand('c1', verb, ['1', { path }]));
			expect(out.at(-1)).toMatch(new RegExp(`^c1 OK .*${verb} completed$`));
			targets.push(...targetIds(convex, verb === 'COPY' ? 'copy' : 'move'));
		}
		expect(targets).toEqual(paths.map(idOf));
	});
});
