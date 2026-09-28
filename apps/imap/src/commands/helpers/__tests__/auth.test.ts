/**
 * The shared precondition check and the credential flow behind LOGIN and
 * AUTHENTICATE PLAIN.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Shared from '@owlat/shared';
import { checkRequires } from '../auth.js';
import { dispatch } from '../../walker.js';
import type {
	CommandDeps,
	CommandRequirement,
	ConnectionState,
	SelectedState,
} from '../../types.js';

const { sleep } = vi.hoisted(() => ({ sleep: vi.fn(async (_ms: number) => undefined) }));

vi.mock('@owlat/shared', async (importOriginal) => ({
	...(await importOriginal<typeof Shared>()),
	sleep,
}));

vi.mock('../../../logger.js', () => ({
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

const UNAUTHENTICATED: ConnectionState = { auth: null, selected: null, clientId: null };
const AUTHENTICATED: ConnectionState = { auth: AUTH, selected: null, clientId: null };
const SELECTED_RW: ConnectionState = { auth: AUTH, selected: SELECTED, clientId: null };
const SELECTED_RO: ConnectionState = {
	auth: AUTH,
	selected: { ...SELECTED, readOnly: true },
	clientId: null,
};

describe('checkRequires', () => {
	const cases: Array<[CommandRequirement | undefined, ConnectionState, string | null]> = [
		[undefined, UNAUTHENTICATED, null],
		['auth', UNAUTHENTICATED, 't BAD Not authenticated'],
		['auth', AUTHENTICATED, null],
		['auth', SELECTED_RO, null],
		['selected', UNAUTHENTICATED, 't BAD Not authenticated'],
		['selected', AUTHENTICATED, 't BAD No mailbox selected'],
		['selected', SELECTED_RO, null],
		['writable', UNAUTHENTICATED, 't BAD Not authenticated'],
		['writable', AUTHENTICATED, 't BAD No mailbox selected'],
		['writable', SELECTED_RO, 't NO Mailbox is read-only'],
		['writable', SELECTED_RW, null],
	];
	it.each(cases)('requires=%s', (requires, state, expected) => {
		expect(checkRequires(requires, state, 't')).toBe(expected);
	});
});

describe('LOGIN and AUTHENTICATE share one credential flow', () => {
	const good = { mailboxId: 'mb1', appPasswordId: 'ap1', userId: 'u1' };

	function makeDeps(throttled: boolean) {
		const rateLimiter = {
			check: vi.fn(async () => ({
				throttled,
				tarpitMs: throttled ? 900_000 : 0,
				ipCount: 0,
				authCount: throttled ? 5 : 0,
			})),
			recordFailure: vi.fn(async () => undefined),
		};
		const convex = {
			query: vi.fn(),
			mutation: vi.fn(async () => null),
			action: vi.fn(async () => good),
		};
		const committed: ConnectionState[] = [];
		const deps = {
			convex,
			config: {},
			rateLimiter,
			remoteIp: '192.0.2.1',
			capabilityLine: 'CAPABILITY IMAP4rev1',
			tls: true,
			closeConnection: vi.fn(),
			commit: (s: ConnectionState) => committed.push(s),
		} as unknown as CommandDeps;
		return { deps, rateLimiter, convex, committed };
	}

	const saslPlain = (user: string, password: string): string =>
		Buffer.from(`\0${user}\0${password}`, 'utf-8').toString('base64');

	const commands = [
		{ verb: 'LOGIN', args: ['Alice@Test', 'secret'], ok: 'a1 OK LOGIN completed' },
		{
			verb: 'AUTHENTICATE',
			args: ['PLAIN', saslPlain('Alice@Test', 'secret')],
			ok: 'a1 OK AUTHENTICATE completed',
		},
	] as const;

	beforeEach(() => {
		sleep.mockClear();
	});

	it.each(commands)('$verb: a throttled user is tarpitted and refused', async ({ verb, args }) => {
		const { deps, rateLimiter, convex, committed } = makeDeps(true);
		const lines: string[] = [];
		await dispatch(deps, UNAUTHENTICATED, { tag: 'a1', command: verb, args: [...args] }, (l) =>
			lines.push(l as string)
		).completion;

		// The tarpit is capped at 5s whatever the limiter asks for.
		expect(sleep).toHaveBeenCalledExactlyOnceWith(5_000);
		expect(rateLimiter.check).toHaveBeenCalledWith('192.0.2.1', 'alice@test');
		expect(rateLimiter.recordFailure).toHaveBeenCalledWith('192.0.2.1', 'alice@test');
		expect(convex.action).not.toHaveBeenCalled();
		expect(committed).toEqual([]);
		expect(lines).toEqual(['a1 NO Authentication failed']);
	});

	it.each(commands)('$verb: success commits auth, touches, and sends the banner', async (cmd) => {
		const { deps, rateLimiter, convex, committed } = makeDeps(false);
		const lines: string[] = [];
		await dispatch(
			deps,
			{ ...UNAUTHENTICATED, clientId: 'Thunderbird' },
			{ tag: 'a1', command: cmd.verb, args: [...cmd.args] },
			(l) => lines.push(l as string)
		).completion;

		expect(sleep).not.toHaveBeenCalled();
		expect(convex.action).toHaveBeenCalledWith(expect.anything(), {
			address: 'alice@test',
			password: 'secret',
			scope: 'imap',
		});
		expect(convex.mutation).toHaveBeenCalledWith(expect.anything(), {
			appPasswordId: 'ap1',
			ip: '192.0.2.1',
			userAgent: 'Thunderbird',
		});
		expect(committed.at(-1)?.auth).toEqual({ ...good, address: 'alice@test' });
		expect(rateLimiter.recordFailure).not.toHaveBeenCalled();
		expect(lines).toEqual(['* OK [CAPABILITY IMAP4rev1] Authenticated', cmd.ok]);
	});

	it.each(commands)('$verb: a backend error counts as a failure', async ({ verb, args }) => {
		const { deps, rateLimiter, convex, committed } = makeDeps(false);
		convex.action.mockRejectedValueOnce(new Error('backend down'));
		const lines: string[] = [];
		await dispatch(deps, UNAUTHENTICATED, { tag: 'a1', command: verb, args: [...args] }, (l) =>
			lines.push(l as string)
		).completion;

		expect(rateLimiter.recordFailure).toHaveBeenCalledWith('192.0.2.1', 'alice@test');
		expect(committed).toEqual([]);
		expect(lines).toEqual(['a1 NO Authentication failed']);
	});
});
