/**
 * A logged-in connection through the real pump, answered by a mocked Convex
 * client that serves a fixed folder list, plus the ImapFlow parser, path codec
 * and command compiler to read and write the wire the way a client does.
 * Shared by the mailbox-name and LIST tests. Each test file mocks
 * `../logger.js` itself.
 */

import { expect, vi } from 'vitest';
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

// convex/server declares this type but does not export it.
type AnyFunctionReference = Parameters<typeof getFunctionName>[0];

/** One node of a command ImapFlow's compiler writes. */
type CompileNode = NonNullable<Parameters<typeof compiler>[0]['attributes']>;

/** An IMAP4rev1 session without UTF8=ACCEPT, as ImapFlow sees this server. */
export const REV1 = {
	enabled: new Set(),
	capabilities: new Set(['IMAP4rev1']),
} as unknown as ImapFlow;

export class MockSocket extends EventEmitter {
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

/** Give each folder the counters SELECT and STATUS read. */
export function withCounters(folders: ReadonlyArray<Omit<FolderRow, 'uidValidity'>>): FolderRow[] {
	return folders.map((f, i) => ({
		uidNext: 1,
		highestModseq: 1,
		totalCount: 0,
		unseenCount: i,
		...f,
		uidValidity: 100 + i,
	}));
}

/**
 * Convex answering from `folders`. The inbox-role folder holds one message,
 * UID 1, for COPY and MOVE to take; APPEND stores into whichever folder it
 * names.
 */
export function makeConvex(folders: readonly FolderRow[]) {
	const inboxId = folders.find((f) => f.role === 'inbox')?._id;
	const query = vi.fn(async (ref: AnyFunctionReference, args: Record<string, unknown>) => {
		switch (getFunctionName(ref)) {
			case 'mail/imap/session:listFolders':
				return folders;
			case 'mail/imap/session:selectFolder': {
				const folder = folders.find((f) => f._id === args['folderId']);
				return folder ? { folder } : null;
			}
			case 'mail/imap/fetch:listFolderUidsPage':
				return {
					uids: args['folderId'] === inboxId && !args['afterUid'] ? [1] : [],
					nextUid: null,
				};
			case 'mail/imap/fetch:resolveMessageIdsByUid':
				return {
					rows: args['folderId'] === inboxId ? [{ _id: 'm1', uid: 1, modseq: 1 }] : [],
					nextUid: null,
				};
			default:
				return null;
		}
	});
	const mutation = vi.fn(async (ref: AnyFunctionReference) => {
		switch (getFunctionName(ref)) {
			case 'mail/imap/move:copyMessages':
			case 'mail/imap/move:moveMessages':
				return { uidValidity: 1, pairs: [{ sourceUid: 1, targetUid: 1 }] };
			case 'mail/imap/append:generateRawUploadUrl':
				return 'https://upload.test/blob';
			case 'mail/imap/append:appendMessage':
				return { uid: 1, uidValidity: 1, modseq: 1 };
			default:
				return undefined;
		}
	});
	const action = vi.fn(async () => ({ mailboxId: 'mb1', appPasswordId: 'ap1', userId: 'u1' }));
	return { query, mutation, action };
}

export type MockConvex = ReturnType<typeof makeConvex>;

function connect(folders: readonly FolderRow[]) {
	const socket = new MockSocket();
	const convex = makeConvex(folders);
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
export async function exchange(socket: MockSocket, tag: string, command: string | Buffer) {
	const mark = socket.text().length;
	socket.emit('data', typeof command === 'string' ? `${command}\r\n` : command);
	await vi.waitFor(() => expect(socket.text().slice(mark)).toMatch(new RegExp(`^${tag} `, 'm')));
	return socket
		.text()
		.slice(mark)
		.split('\r\n')
		.filter((l) => l.length > 0);
}

export async function loggedIn(folders: readonly FolderRow[]) {
	const conn = connect(folders);
	const out = await exchange(conn.socket, 'a0', 'a0 LOGIN "alice@example.com" "pw"');
	expect(out.at(-1)).toBe('a0 OK LOGIN completed');
	return conn;
}

/** One LIST or LSUB line as ImapFlow reads it: attributes, delimiter, decoded path. */
export interface ListedEntry {
	readonly flags: string[];
	readonly delimiter: string;
	readonly path: string;
}

export async function listedEntries(
	lines: string[],
	verb: 'LIST' | 'LSUB'
): Promise<ListedEntry[]> {
	const entries: ListedEntry[] = [];
	for (const line of lines.filter((l) => l.startsWith(`* ${verb} `))) {
		const parsed = await parser(line);
		const [flags, delimiter, name] = parsed.attributes ?? [];
		expect(name?.type).toBe('STRING');
		entries.push({
			flags: ((flags as unknown as Array<{ value: string }>) ?? []).map((f) => f.value),
			delimiter: String(delimiter?.value),
			path: decodePath(REV1, String(name?.value)),
		});
	}
	return entries;
}

/** The mailbox names in a set of LIST/LSUB lines, decoded as ImapFlow does. */
export async function listedNames(lines: string[], verb: 'LIST' | 'LSUB'): Promise<string[]> {
	return (await listedEntries(lines, verb)).map((e) => e.path);
}

/** One command argument: an atom, a mailbox path, or a parenthesized list of atoms. */
export type CommandArg = string | { readonly path: string } | readonly string[];

/**
 * A command as ImapFlow writes it, without the closing CRLF (commands/*.js):
 * a path is modified UTF-7 encoded and quoted when it holds a `&`.
 */
export async function imapflowLine(
	tag: string,
	command: string,
	args: readonly CommandArg[]
): Promise<Buffer> {
	const attribute = (arg: CommandArg): CompileNode => {
		if (typeof arg === 'string') return { type: 'ATOM', value: arg };
		if (Array.isArray(arg)) return arg.map(attribute);
		const encoded = encodePath(REV1, (arg as { path: string }).path);
		return { type: encoded.includes('&') ? 'STRING' : 'ATOM', value: encoded };
	};
	const parts = await compiler(
		{ tag, command, attributes: args.map(attribute) },
		{ asArray: true }
	);
	return Buffer.concat(parts);
}

/** {@link imapflowLine} with its CRLF, ready to send. */
export async function imapflowCommand(
	tag: string,
	command: string,
	args: readonly CommandArg[]
): Promise<Buffer> {
	return Buffer.concat([await imapflowLine(tag, command, args), Buffer.from('\r\n')]);
}

/** The SELECT command ImapFlow writes for a decoded path. */
export function imapflowSelect(tag: string, path: string): Promise<Buffer> {
	return imapflowCommand(tag, 'SELECT', [{ path }]);
}

/** The folder each SELECT opened, by `selectFolder` call. */
export function selectedIds(convex: MockConvex): unknown[] {
	return convex.query.mock.calls
		.filter(([ref]) => getFunctionName(ref) === 'mail/imap/session:selectFolder')
		.map(([, args]) => args['folderId']);
}

/** The folder argument of each call to one mutation. */
function mutationFolderIds(convex: MockConvex, name: string, field: string): unknown[] {
	return convex.mutation.mock.calls
		.filter(([ref]) => getFunctionName(ref) === name)
		.map((call) => (call as unknown as [unknown, Record<string, unknown>])[1][field]);
}

/** The target folder of each COPY or MOVE, by mutation call. */
export function targetIds(convex: MockConvex, verb: 'copy' | 'move'): unknown[] {
	return mutationFolderIds(convex, `mail/imap/move:${verb}Messages`, 'targetFolderId');
}

/** The folder each APPEND stored into. */
export function appendedIds(convex: MockConvex): unknown[] {
	return mutationFolderIds(convex, 'mail/imap/append:appendMessage', 'folderId');
}
