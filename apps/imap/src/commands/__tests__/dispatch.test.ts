/**
 * The dispatch ceremony shared by the walker and the UID dispatcher:
 * parse, then the module's declared `requires`, then `start`. Also locks
 * the reply for a backend fault: `NO [UNAVAILABLE] <command> failed`,
 * never BAD (RFC 3501 reserves BAD for client errors).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatch } from '../walker.js';
import { fetchModule } from '../fetch/index.js';
import { storeModule } from '../store/index.js';
import { copyModule } from '../copy/index.js';
import { moveModule } from '../move/index.js';
import { expungeModule } from '../expunge/index.js';
import type { CommandDeps, CommandSession, ConnectionState, SelectedState } from '../types.js';

vi.mock('../../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const AUTH = { mailboxId: 'mb1', appPasswordId: 'ap1', address: 'a@t', userId: 'u1' };

const SELECTED: SelectedState = {
	folderId: 'f1',
	folderName: 'INBOX',
	uidValidity: 1,
	uidNext: 5,
	highestModseq: 1,
	totalCount: 4,
	readOnly: false,
};

const AUTHENTICATED: ConnectionState = { auth: AUTH, selected: null, clientId: null };

function selected(readOnly = false): ConnectionState {
	return { auth: AUTH, selected: { ...SELECTED, readOnly }, clientId: null };
}

function makeConvex() {
	return { query: vi.fn(), mutation: vi.fn(), action: vi.fn() };
}

function makeDeps(convex = makeConvex()): CommandDeps {
	return {
		convex,
		config: {},
		rateLimiter: {},
		remoteIp: '192.0.2.1',
		capabilityLine: 'CAPABILITY IMAP4rev1',
		tls: true,
		closeConnection: vi.fn(),
		commit: vi.fn(),
	} as unknown as CommandDeps;
}

async function run(
	state: ConnectionState,
	line: string,
	deps: CommandDeps = makeDeps()
): Promise<{ lines: string[]; session: CommandSession }> {
	const [tag = '', command = '', ...args] = line.split(' ');
	const lines: string[] = [];
	const session = dispatch(deps, state, { tag, command, args }, (l) => lines.push(l as string));
	await session.completion;
	return { lines, session };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('walker enforces a module’s declared requires', () => {
	it('FETCH (requires selected) without a selection gets BAD No mailbox selected', async () => {
		const spy = vi.spyOn(fetchModule, 'start');
		const { lines } = await run(AUTHENTICATED, 'a1 FETCH 1 (FLAGS)');
		expect(lines).toEqual(['a1 BAD No mailbox selected']);
		expect(spy).not.toHaveBeenCalled();
	});

	it('an unauthenticated client sees BAD Not authenticated first', async () => {
		const { lines } = await run(
			{ auth: null, selected: null, clientId: null },
			'a1 STORE 1 +FLAGS (\\Seen)'
		);
		expect(lines).toEqual(['a1 BAD Not authenticated']);
	});

	it('a parse error is reported before the precondition', async () => {
		const { lines } = await run(AUTHENTICATED, 'a1 FETCH');
		expect(lines).toEqual(['a1 BAD FETCH requires <set> (items)']);
	});

	it.each([
		['STORE', 'a1 STORE 1 +FLAGS (\\Seen)'],
		['MOVE', 'a1 MOVE 1 Archive'],
		['EXPUNGE', 'a1 EXPUNGE'],
	])('%s on a read-only folder gets NO Mailbox is read-only', async (_verb, line) => {
		const convex = makeConvex();
		const { lines } = await run(selected(true), line, makeDeps(convex));
		expect(lines).toEqual(['a1 NO Mailbox is read-only']);
		expect(convex.mutation).not.toHaveBeenCalled();
	});

	it('COPY only reads its source, so it runs on a read-only folder', async () => {
		const spy = vi.spyOn(copyModule, 'start');
		const convex = makeConvex();
		convex.query.mockResolvedValue([]); // no target folder
		const { lines } = await run(selected(true), 'a1 COPY 1 Archive', makeDeps(convex));
		expect(spy).toHaveBeenCalledOnce();
		expect(lines).toEqual(['a1 NO [TRYCREATE] Mailbox not found']);
	});
});

describe('UID dispatcher', () => {
	it.each([
		['FETCH', fetchModule, 'a1 UID FETCH 1:* (FLAGS)'],
		['STORE', storeModule, 'a1 UID STORE 3 +FLAGS (\\Seen)'],
		['COPY', copyModule, 'a1 UID COPY 3 Archive'],
		['MOVE', moveModule, 'a1 UID MOVE 3 Archive'],
		['EXPUNGE', expungeModule, 'a1 UID EXPUNGE 3'],
	] as const)('UID %s re-enters the sub-module with byUid', async (verb, module, line) => {
		const spy = vi.spyOn(module, 'start').mockReturnValue({
			completion: Promise.resolve(),
			cancel: () => undefined,
		});
		await run(selected(), line);
		expect(spy).toHaveBeenCalledOnce();
		const call = spy.mock.calls[0]![0];
		expect(call.verb).toBe(verb);
		expect(call.tag).toBe('a1');
		expect(call.args).toMatchObject({ byUid: true });
	});

	it('passes the sub-module its own parsed args', async () => {
		const spy = vi.spyOn(storeModule, 'start').mockReturnValue({
			completion: Promise.resolve(),
			cancel: () => undefined,
		});
		await run(selected(), 'a1 UID STORE 3:4 -FLAGS.SILENT (\\Deleted)');
		expect(spy.mock.calls[0]![0].args).toEqual({
			set: '3:4',
			unchangedSince: undefined,
			silent: true,
			mode: 'remove',
			flagsToken: '(\\Deleted)',
			byUid: true,
		});
	});

	it('answers BAD for a sub-command parse error', async () => {
		const { lines } = await run(selected(), 'a1 UID COPY 3');
		expect(lines).toEqual(['a1 BAD COPY requires <set> <target>']);
	});

	it('enforces the sub-module requires', async () => {
		expect((await run(AUTHENTICATED, 'a1 UID FETCH 1 (FLAGS)')).lines).toEqual([
			'a1 BAD No mailbox selected',
		]);
		expect((await run(selected(true), 'a1 UID STORE 1 +FLAGS (\\Seen)')).lines).toEqual([
			'a1 NO Mailbox is read-only',
		]);
		expect((await run(selected(true), 'a1 UID MOVE 1 Archive')).lines).toEqual([
			'a1 NO Mailbox is read-only',
		]);
	});

	it('rejects an unknown sub-command', async () => {
		const { lines } = await run(selected(), 'a1 UID SEARCH ALL');
		expect(lines).toEqual(['a1 BAD UID SEARCH not supported']);
	});
});

describe('a backend fault answers NO [UNAVAILABLE] with the command label', () => {
	it.each([
		['a1 FETCH 1 (FLAGS)', 'FETCH'],
		['a1 UID FETCH 1 (FLAGS)', 'UID FETCH'],
		['a1 STORE 1 +FLAGS (\\Seen)', 'STORE'],
		['a1 UID STORE 1 +FLAGS (\\Seen)', 'UID STORE'],
		['a1 COPY 1 Archive', 'COPY'],
		['a1 UID MOVE 1 Archive', 'UID MOVE'],
		['a1 LIST "" *', 'LIST'],
		['a1 LSUB "" *', 'LSUB'],
		['a1 SELECT INBOX', 'SELECT'],
		['a1 EXAMINE INBOX', 'EXAMINE'],
		['a1 STATUS INBOX (MESSAGES)', 'STATUS'],
	])('%s', async (line, label) => {
		const convex = makeConvex();
		convex.query.mockRejectedValue(new Error('backend down'));
		const { lines } = await run(selected(), line, makeDeps(convex));
		expect(lines.at(-1)).toBe(`a1 NO [UNAVAILABLE] ${label} failed`);
	});

	it.each([
		['a1 EXPUNGE', 'EXPUNGE'],
		['a1 UID EXPUNGE 1:3', 'UID EXPUNGE'],
	])('%s', async (line, label) => {
		const convex = makeConvex();
		convex.mutation.mockRejectedValue(new Error('backend down'));
		const { lines } = await run(selected(), line, makeDeps(convex));
		expect(lines).toEqual([`a1 NO [UNAVAILABLE] ${label} failed`]);
	});

	it('APPEND', async () => {
		const convex = makeConvex();
		convex.query.mockRejectedValue(new Error('backend down'));
		const lines: string[] = [];
		const session = dispatch(
			makeDeps(convex),
			AUTHENTICATED,
			{ tag: 'a1', command: 'APPEND', args: ['Sent', '{5+}'] },
			(l) => lines.push(l as string)
		);
		session.onLiteralBytes?.(Buffer.from('hello'));
		await session.completion;
		expect(lines).toEqual(['a1 NO [UNAVAILABLE] APPEND failed']);
	});
});
