/**
 * Mailbox names on the wire, through the real pump, read and written the way
 * ImapFlow does it: its response parser and modified UTF-7 decoder on LIST,
 * LSUB and STATUS output, and its encoder and command compiler for the name it
 * then SELECTs (RFC 3501 §5.1.3). Every stored name has to come back exactly
 * and lead to its own folder.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { EventEmitter } from 'events';
import type { Socket } from 'net';
import type { ImapFlow } from 'imapflow';
import { compiler, parser } from 'imapflow/lib/handler/imap-handler.js';
import { decodePath, encodePath } from 'imapflow/lib/tools.js';
import { ImapConnection } from '../connection.js';
import type { ImapConfig } from '../config.js';
import type { ConvexClient, FolderRow } from '../convex.js';
import { AuthRateLimiter } from '../rateLimit.js';
import { resolveFolderByName } from '../commands/helpers/folders.js';

// convex/server declares this type but does not export it.
type AnyFunctionReference = Parameters<typeof getFunctionName>[0];

vi.mock('../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** An IMAP4rev1 session without UTF8=ACCEPT, as ImapFlow sees this server. */
const REV1 = { enabled: new Set(), capabilities: new Set(['IMAP4rev1']) } as unknown as ImapFlow;

class MockSocket extends EventEmitter {
	readonly written: string[] = [];

	write(data: string | Buffer): boolean {
		this.written.push(data.toString());
		return true;
	}

	end(): void {}
	pause(): this {
		return this;
	}
	resume(): this {
		return this;
	}

	text(): string {
		return this.written.join('');
	}
}

const config: ImapConfig = {
	port: 993,
	listenAddress: '0.0.0.0',
	tls: null,
	greetingHost: 'imap.test',
	convexUrl: 'https://example.convex.cloud',
	convexAdminKey: 'test-admin-key',
	redisUrl: null,
	maxConnectionsPerIp: 20,
	maxClients: 500,
	idleTimeoutMs: 30 * 60 * 1000,
	authRateLimit: { failuresPerWindow: 5, windowMs: 60_000, tarpitMs: 900_000 },
};

/** The issue's names, a few more that need encoding, and one with a line break. */
const NAMES = [
	'Projekte "Q4"',
	'Ablage\\2026',
	'Übersicht',
	'📁 Mail',
	'R&D',
	'Ablage/Übersicht',
	'Alt\r\nName',
];

const FOLDERS: FolderRow[] = [
	{ _id: 'f-inbox', name: 'INBOX', role: 'inbox', subscribed: true },
	...NAMES.map((name, i) => ({ _id: `f-${i}`, name, subscribed: i % 2 === 0 })),
].map((f, i) => ({
	...f,
	uidValidity: 100 + i,
	uidNext: 1,
	highestModseq: 1,
	totalCount: 0,
	unseenCount: i,
}));

function makeConvex() {
	const query = vi.fn(async (ref: AnyFunctionReference, args: Record<string, unknown>) => {
		switch (getFunctionName(ref)) {
			case 'mail/imap/session:listFolders':
				return FOLDERS;
			case 'mail/imap/session:selectFolder': {
				const folder = FOLDERS.find((f) => f._id === args['folderId']);
				return folder ? { folder } : null;
			}
			case 'mail/imap/fetch:listFolderUidsPage':
				return { uids: [], nextUid: null };
			default:
				return null;
		}
	});
	const mutation = vi.fn(async () => undefined);
	const action = vi.fn(async () => ({ mailboxId: 'mb1', appPasswordId: 'ap1', userId: 'u1' }));
	return { query, mutation, action };
}

function connect() {
	const socket = new MockSocket();
	const convex = makeConvex();
	const connection = new ImapConnection(
		socket as unknown as Socket,
		config,
		convex as unknown as ConvexClient,
		new AuthRateLimiter(null, config.authRateLimit),
		'10.0.0.1'
	);
	return { connection, socket, convex };
}

/**
 * Send one command (its raw bytes, CRLF included) and return the response
 * lines up to and including its tagged completion. A response line that held
 * a raw CR or LF would come back here as more than one line.
 */
async function exchange(socket: MockSocket, tag: string, command: string | Buffer) {
	const mark = socket.text().length;
	socket.emit('data', typeof command === 'string' ? `${command}\r\n` : command);
	await vi.waitFor(() => expect(socket.text().slice(mark)).toMatch(new RegExp(`^${tag} `, 'm')));
	return socket
		.text()
		.slice(mark)
		.split('\r\n')
		.filter((l) => l.length > 0);
}

async function loggedIn() {
	const conn = connect();
	const out = await exchange(conn.socket, 'a0', 'a0 LOGIN "alice@example.com" "pw"');
	expect(out.at(-1)).toBe('a0 OK LOGIN completed');
	return conn;
}

/** The mailbox names in a set of LIST/LSUB lines, decoded as ImapFlow does. */
async function listedNames(lines: string[], verb: 'LIST' | 'LSUB'): Promise<string[]> {
	const names: string[] = [];
	for (const line of lines.filter((l) => l.startsWith(`* ${verb} `))) {
		const parsed = await parser(line);
		const attr = parsed.attributes?.[2];
		expect(attr?.type).toBe('STRING');
		names.push(decodePath(REV1, String(attr?.value)));
	}
	return names;
}

/** The SELECT command ImapFlow writes for a decoded path (commands/select.js). */
async function imapflowSelect(tag: string, path: string): Promise<Buffer> {
	const encoded = encodePath(REV1, path);
	const parts = await compiler(
		{
			tag,
			command: 'SELECT',
			attributes: [{ type: encoded.includes('&') ? 'STRING' : 'ATOM', value: encoded }],
		},
		{ asArray: true }
	);
	return Buffer.concat([...parts, Buffer.from('\r\n')]);
}

/** The folder each SELECT opened, by `selectFolder` call. */
function selectedIds(convex: ReturnType<typeof makeConvex>): unknown[] {
	return convex.query.mock.calls
		.filter(([ref]) => getFunctionName(ref) === 'mail/imap/session:selectFolder')
		.map(([, args]) => args['folderId']);
}

afterEach(() => {
	vi.clearAllMocks();
});

describe('LIST and LSUB mailbox names', () => {
	it('LIST gives every stored name back, one line each, to a client parser', async () => {
		const { socket } = await loggedIn();
		const out = await exchange(socket, 'a1', 'a1 LIST "" "*"');
		expect(out.at(-1)).toBe('a1 OK LIST completed');
		expect(out.filter((l) => !l.startsWith('* LIST ')).length).toBe(1);
		expect(await listedNames(out, 'LIST')).toEqual(FOLDERS.map((f) => f.name));
	});

	it('writes the scenario names quoted and modified UTF-7 encoded', async () => {
		const { socket } = await loggedIn();
		const out = await exchange(socket, 'a1', 'a1 LIST "" "*"');
		expect(out).toContain('* LIST (\\HasNoChildren) "/" "Projekte \\"Q4\\""');
		expect(out).toContain('* LIST (\\HasNoChildren) "/" "Ablage\\\\2026"');
		expect(out).toContain('* LIST (\\HasNoChildren) "/" "&ANw-bersicht"');
		expect(out).toContain('* LIST (\\HasNoChildren) "/" "&2D3cwQ- Mail"');
		expect(out).toContain('* LIST (\\HasNoChildren) "/" "R&-D"');
		expect(out).toContain('* LIST (\\HasNoChildren) "/" "Ablage/&ANw-bersicht"');
		expect(out).toContain('* LIST (\\HasNoChildren) "/" "Alt&AA0ACg-Name"');
	});

	it('LSUB gives the subscribed names back', async () => {
		const { socket } = await loggedIn();
		const out = await exchange(socket, 'a1', 'a1 LSUB "" "*"');
		expect(out.at(-1)).toBe('a1 OK LSUB completed');
		expect(await listedNames(out, 'LSUB')).toEqual(
			FOLDERS.filter((f) => f.subscribed).map((f) => f.name)
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

describe('resolveFolderByName (SELECT, EXAMINE, STATUS, APPEND, COPY, MOVE)', () => {
	const convex = { query: async () => FOLDERS } as unknown as ConvexClient;

	it.each([
		['&ANw-bersicht', 'Übersicht'],
		['&ANw-BERSICHT', 'Übersicht'],
		['Ablage/&ANw-bersicht', 'Ablage/Übersicht'],
		['R&-D', 'R&D'],
		['&2D3cwQ- Mail', '📁 Mail'],
		['inbox', 'INBOX'],
	])('%j → %j', async (wire, name) => {
		const folder = await resolveFolderByName(convex, 'mb1', wire);
		expect(folder?.name).toBe(name);
	});
});
