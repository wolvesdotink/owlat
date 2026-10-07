/**
 * A folder other than the inbox whose name is `INBOX` in some case (#1302),
 * through the real pump and read and written as ImapFlow does it. RFC 3501
 * §5.1 reads `INBOX` in any case as the inbox, so at the top level such a
 * folder is listed as its name, a `⧵` and its id (`folderTree.ts`), and that
 * name reaches it in SELECT, STATUS, APPEND, COPY and MOVE while `Inbox`
 * itself still opens the inbox.
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
	listedNames,
	loggedIn,
	selectedIds,
	targetIds,
	withCounters,
} from './imapWire.js';

vi.mock('../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Folder ids as Convex writes them. */
const UPPER = 'k57cvz2c1dyq9f3hbn3hq6b9n7rjf3xa';
const LOWER = 'j9x2m4n6p8q0r2s4t6v8w0x2y4z6a8bc';

/**
 * The inbox stored as `Inbox`, a folder named `Inbox` and one named `inbox`
 * with a folder below it, and a folder named `Inbox` under `Work`, which is
 * reachable as it is.
 */
const FOLDERS: FolderRow[] = withCounters([
	{ _id: 'f-inbox', name: 'Inbox', role: 'inbox', subscribed: true },
	{ _id: UPPER, name: 'Inbox', subscribed: true },
	{ _id: LOWER, name: 'inbox', subscribed: true },
	{ _id: 'f-receipts', name: 'Receipts', parentId: LOWER, subscribed: true },
	{ _id: 'f-work', name: 'Work', subscribed: true },
	{ _id: 'f-nested', name: 'Inbox', parentId: 'f-work', subscribed: true },
]);

const PATHS: Record<string, string> = {
	'f-inbox': 'INBOX',
	[UPPER]: `Inbox⧵${UPPER}`,
	[LOWER]: `inbox⧵${LOWER}`,
	'f-receipts': `inbox⧵${LOWER}/Receipts`,
	'f-work': 'Work',
	'f-nested': 'Work/Inbox',
};

const ALIASED = [UPPER, LOWER, 'f-receipts'];

afterEach(() => {
	vi.clearAllMocks();
});

describe('LIST', () => {
	it('lists each such folder by its name with its id, in modified UTF-7', async () => {
		const { socket } = await loggedIn(FOLDERS);
		const out = await exchange(socket, 'l1', 'l1 LIST "" "*"');
		expect(out).toContain(`* LIST (\\HasNoChildren) "/" "Inbox&KfU-${UPPER}"`);
		expect(out).toContain(`* LIST (\\HasChildren) "/" "inbox&KfU-${LOWER}"`);
		expect(await listedNames(out, 'LIST')).toEqual(FOLDERS.map((f) => PATHS[f._id]));
	});

	it('lists them at the top level, and INBOX matches the inbox only', async () => {
		const { socket } = await loggedIn(FOLDERS);
		const top = await exchange(socket, 'l1', 'l1 LIST "" "%"');
		expect(await listedNames(top, 'LIST')).toEqual(['INBOX', PATHS[UPPER], PATHS[LOWER], 'Work']);
		const inbox = await exchange(socket, 'l2', 'l2 LIST "" "Inbox"');
		expect(await listedNames(inbox, 'LIST')).toEqual(['INBOX']);
	});
});

describe('the listed name reaches its folder', () => {
	it('SELECT with each name ImapFlow read from LIST opens that folder', async () => {
		const { socket, convex } = await loggedIn(FOLDERS);
		const listed = await listedNames(await exchange(socket, 'a1', 'a1 LIST "" "*"'), 'LIST');
		for (const [i, path] of listed.entries()) {
			const out = await exchange(socket, `s${i}`, await imapflowSelect(`s${i}`, path));
			expect(out.at(-1)).toBe(`s${i} OK [READ-WRITE] SELECT completed`);
		}
		expect(selectedIds(convex)).toEqual(FOLDERS.map((f) => f._id));
	});

	it.each(['INBOX', 'Inbox', 'inbox', 'iNbOx'])('SELECT %s still opens the inbox', async (name) => {
		const { socket, convex } = await loggedIn(FOLDERS);
		const out = await exchange(socket, 's1', `s1 SELECT ${name}`);
		expect(out.at(-1)).toBe('s1 OK [READ-WRITE] SELECT completed');
		expect(selectedIds(convex)).toEqual(['f-inbox']);
	});

	it.each(ALIASED)('STATUS answers for %s under its listed name', async (id) => {
		const { socket } = await loggedIn(FOLDERS);
		const folder = FOLDERS.find((f) => f._id === id)!;
		const command = await imapflowCommand('t1', 'STATUS', [{ path: PATHS[id]! }, ['UNSEEN']]);
		const out = await exchange(socket, 't1', command);
		expect(out.at(-1)).toBe('t1 OK STATUS completed');
		expect(out[0]).toMatch(new RegExp(` \\(UNSEEN ${folder.unseenCount}\\)$`));
		const parsed = await parser(out[0]!);
		expect(decodePath(REV1, String(parsed.attributes?.[0]?.value))).toBe(PATHS[id]);
	});

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

		it.each(ALIASED)('APPEND to %s stores into that folder', async (id) => {
			const { socket, convex } = await loggedIn(FOLDERS);
			const body = 'Subject: hi\r\n\r\nhello\r\n';
			const out = await exchange(
				socket,
				'p1',
				Buffer.concat([
					await imapflowLine('p1', 'APPEND', [{ path: PATHS[id]! }]),
					Buffer.from(` {${Buffer.byteLength(body)}+}\r\n${body}\r\n`),
				])
			);
			expect(out.at(-1)).toBe('p1 OK [APPENDUID 1 1] APPEND completed');
			expect(appendedIds(convex)).toEqual([id]);
		});
	});

	it.each(['COPY', 'MOVE'] as const)('%s to each such folder lands in it', async (verb) => {
		const targets: unknown[] = [];
		for (const id of ALIASED) {
			const { socket, convex } = await loggedIn(FOLDERS);
			await exchange(socket, 's1', 's1 SELECT INBOX');
			const command = await imapflowCommand('c1', verb, ['1', { path: PATHS[id]! }]);
			const out = await exchange(socket, 'c1', command);
			expect(out.at(-1)).toMatch(new RegExp(`^c1 OK .*${verb} completed$`));
			targets.push(...targetIds(convex, verb === 'COPY' ? 'copy' : 'move'));
		}
		expect(targets).toEqual(ALIASED);
	});
});

describe('the name a client cached', () => {
	it('keeps opening its folder while competing folders are created, renamed and deleted', async () => {
		// One list the mock serves throughout, changed in place between commands.
		const folders: FolderRow[] = withCounters(FOLDERS.slice(0, 3));
		const { socket, convex } = await loggedIn(folders);
		const cached = PATHS[UPPER]!;
		const changes: Array<(fs: FolderRow[]) => void> = [
			// A folder stored under the cached name itself, and its look-alikes.
			(fs) => fs.push({ ...fs[2]!, _id: 'f-same', name: cached }),
			(fs) => fs.push({ ...fs[2]!, _id: 'f-slash', name: `Inbox/${UPPER}` }),
			(fs) => fs.push({ ...fs[2]!, _id: 'f-two', name: 'Inbox (2)' }),
			// More INBOX spellings, one below the cached folder.
			(fs) => fs.push({ ...fs[2]!, _id: 'f-caps', name: 'INBOX' }),
			(fs) => fs.push({ ...fs[2]!, _id: 'f-child', name: 'Inbox', parentId: UPPER }),
			// The other folder named in some case of INBOX is renamed, then deleted.
			(fs) => (fs[2] = { ...fs[2]!, name: 'Inbox (old)' }),
			(fs) => fs.splice(2, 1),
		];
		for (const [i, change] of changes.entries()) {
			change(folders);
			const listed = await listedNames(
				await exchange(socket, `l${i}`, `l${i} LIST "" "*"`),
				'LIST'
			);
			expect(listed).toContain(cached);
			expect(new Set(listed).size).toBe(listed.length);
			await exchange(socket, `s${i}`, await imapflowSelect(`s${i}`, cached));
			await exchange(socket, `i${i}`, `i${i} SELECT Inbox`);
		}
		expect(selectedIds(convex)).toEqual(changes.flatMap(() => [UPPER, 'f-inbox']));
	});
});
