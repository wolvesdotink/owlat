/**
 * Tests for ImapConnection — the per-socket IMAP4rev1 state machine.
 *
 * Uses a mock duplex socket that captures `write` calls and lets tests
 * inject incoming data via the registered 'data' handler. The Convex
 * client is stubbed per test to return canned query/action results.
 *
 * Coverage focuses on the protocol surface that's hardest to verify by
 * eye in the 1,100-LOC handler:
 *   - Greeting + CAPABILITY shape
 *   - Pre-auth state guards (LIST/SELECT before LOGIN must reject)
 *   - LOGIN happy path + invalid-credentials path
 *   - LIST after LOGIN
 *   - SELECT response + state transitions
 *   - UNSELECT / CLOSE / LOGOUT cleanup
 *   - Plain-text protocol commands: NOOP, ID, NAMESPACE, ENABLE, CHECK
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { Socket } from 'net';
import { ImapConnection } from '../connection.js';
import type { ImapConfig } from '../config.js';
import type { ConvexClient } from '../convex.js';
import { AuthRateLimiter } from '../rateLimit.js';
import { CAPABILITY_LINE } from '../commands/walker.js';

vi.mock('../logger.js', () => ({
	logger: {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

class MockSocket extends EventEmitter {
	readonly written: string[] = [];
	ended = false;

	setEncoding(_encoding: string): void {
		// no-op for tests
	}

	write(data: string): boolean {
		this.written.push(data);
		return true;
	}

	end(): void {
		this.ended = true;
		this.emit('close');
	}

	/** Push raw bytes into the connection as if the client sent them. */
	receive(data: string): void {
		this.emit('data', data);
	}

	/** Flatten written buffers and split on CRLF for assertion convenience. */
	lines(): string[] {
		return this.written.join('').split('\r\n').filter(Boolean);
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

interface MockConvex {
	query: ReturnType<typeof vi.fn>;
	mutation: ReturnType<typeof vi.fn>;
	action: ReturnType<typeof vi.fn>;
}

function makeMocks(tls = true): {
	socket: MockSocket;
	convex: MockConvex;
	limiter: AuthRateLimiter;
	connection: ImapConnection;
} {
	const socket = new MockSocket();
	const convex: MockConvex = {
		query: vi.fn(),
		mutation: vi.fn().mockResolvedValue(undefined),
		action: vi.fn(),
	};
	const limiter = new AuthRateLimiter(null, config.authRateLimit);
	const connection = new ImapConnection(
		socket as unknown as Socket,
		config,
		convex as unknown as ConvexClient,
		limiter,
		'10.0.0.1',
		tls,
	);
	return { socket, convex, limiter, connection };
}

/** Tiny helper: send a tagged command and wait one microtask for the handler. */
async function exec(socket: MockSocket, line: string): Promise<void> {
	socket.receive(`${line}\r\n`);
	await Promise.resolve();
	await Promise.resolve();
}

/**
 * Like `exec`, but flushes enough microtasks for commands that chain
 * several sequential Convex calls (SELECT does listFolders → selectFolder;
 * STORE does resolveMessageIdsByUid → storeFlags).
 */
async function execMulti(socket: MockSocket, line: string): Promise<void> {
	socket.receive(`${line}\r\n`);
	for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe('ImapConnection — greeting', () => {
	it('writes the IMAP4rev1 greeting with capabilities', () => {
		const { socket } = makeMocks();
		const greeting = socket.lines()[0]!;
		expect(greeting).toMatch(/^\* OK \[CAPABILITY/);
		expect(greeting).toContain('IMAP4rev1');
		expect(greeting).toContain('AUTH=PLAIN');
		expect(greeting).toContain('imap.test');
	});
});

/**
 * PR-62 regression-lock (2): the greeting, the post-LOGIN banner, and the
 * `* CAPABILITY` response must all carry the *same* assembled
 * CAPABILITY_LINE byte-for-byte. A drift between them is the classic IMAP
 * interop bug (client trusts the greeting cap-list, server later disagrees).
 */
describe('ImapConnection — one CAPABILITY_LINE feeds greeting + banner + CAPABILITY', () => {
	const good = {
		mailboxId: 'mb1',
		appPasswordId: 'ap1',
		userId: 'u1',
		organizationId: 'org1',
	};

	it('the greeting wraps the exact CAPABILITY_LINE', () => {
		const { socket } = makeMocks();
		const greeting = socket.lines()[0]!;
		expect(greeting).toBe(`* OK [${CAPABILITY_LINE}] imap.test Owlat IMAP ready`);
	});

	it('the * CAPABILITY response is the exact CAPABILITY_LINE', async () => {
		const { socket } = makeMocks();
		socket.written.length = 0;
		await exec(socket, 'a001 CAPABILITY');
		expect(socket.lines()[0]).toBe(`* ${CAPABILITY_LINE}`);
	});

	it('the post-LOGIN banner wraps the exact CAPABILITY_LINE', async () => {
		const { socket, convex } = makeMocks();
		convex.action.mockResolvedValue(good);
		socket.written.length = 0;
		await exec(socket, 'a001 LOGIN "alice@test" "good"');
		expect(socket.lines()).toContain(`* OK [${CAPABILITY_LINE}] Authenticated`);
	});

	it('greeting, banner, and CAPABILITY agree on the bracketed/untagged cap set', async () => {
		const { socket, convex } = makeMocks();
		convex.action.mockResolvedValue(good);

		const greetingCap = socket.lines()[0]!.match(/\[CAPABILITY ([^\]]+)\]/)![1];
		socket.written.length = 0;

		await exec(socket, 'a001 CAPABILITY');
		const cmdCap = socket.lines()[0]!.replace(/^\* CAPABILITY /, '');
		socket.written.length = 0;

		await exec(socket, 'a002 LOGIN "alice@test" "good"');
		const bannerCap = socket
			.lines()
			.find((l) => /^\* OK \[CAPABILITY/.test(l))!
			.match(/\[CAPABILITY ([^\]]+)\]/)![1];

		expect(cmdCap).toBe(greetingCap);
		expect(bannerCap).toBe(greetingCap);
	});
});

/**
 * PR-62 regression-lock (3): the server is implicit-TLS-only (RFC 8314).
 * It must never offer STARTTLS — not in CAPABILITY, and the verb itself is
 * unknown, so `STARTTLS` is rejected BAD rather than entering a TLS upgrade.
 */
describe('ImapConnection — no STARTTLS (RFC 8314 implicit TLS)', () => {
	it('CAPABILITY never lists STARTTLS', async () => {
		const { socket } = makeMocks();
		socket.written.length = 0;
		await exec(socket, 'a001 CAPABILITY');
		expect(socket.lines()[0]).not.toContain('STARTTLS');
	});

	it("'a1 STARTTLS' is rejected with BAD (unknown verb, no upgrade)", async () => {
		const { socket } = makeMocks();
		socket.written.length = 0;
		await exec(socket, 'a1 STARTTLS');
		expect(socket.lines().pop()).toBe('a1 BAD Command "STARTTLS" not supported');
	});

	it('STARTTLS over the plaintext dev socket is ALSO just BAD (never an upgrade)', async () => {
		const { socket } = makeMocks(false);
		socket.written.length = 0;
		await exec(socket, 'a1 STARTTLS');
		expect(socket.lines().pop()).toBe('a1 BAD Command "STARTTLS" not supported');
	});
});

/**
 * PR-62 regression-lock (4): the NAMESPACE response is byte-exact. We
 * advertise a single personal namespace with `/` hierarchy and no shared /
 * other-users namespaces (RFC 2342).
 */
describe('ImapConnection — NAMESPACE byte-exact (RFC 2342)', () => {
	it('emits exactly `* NAMESPACE (("" "/")) NIL NIL`', async () => {
		const { socket } = makeMocks();
		socket.written.length = 0;
		await exec(socket, 'a001 NAMESPACE');
		const lines = socket.lines();
		expect(lines[0]).toBe('* NAMESPACE (("" "/")) NIL NIL');
		expect(lines[1]).toBe('a001 OK NAMESPACE completed');
	});
});

describe('ImapConnection — unauthenticated commands', () => {
	let mocks: ReturnType<typeof makeMocks>;
	beforeEach(() => {
		mocks = makeMocks();
		mocks.socket.written.length = 0;
	});

	it('CAPABILITY returns the capability list and OK', async () => {
		await exec(mocks.socket, 'a001 CAPABILITY');
		const lines = mocks.socket.lines();
		expect(lines[0]).toMatch(/^\* CAPABILITY IMAP4rev1/);
		expect(lines[1]).toMatch(/^a001 OK CAPABILITY completed$/);
	});

	it('NOOP responds OK', async () => {
		await exec(mocks.socket, 'a001 NOOP');
		expect(mocks.socket.lines().pop()).toBe('a001 OK NOOP completed');
	});

	it('ID returns server identifier and OK', async () => {
		await exec(mocks.socket, 'a001 ID NIL');
		const lines = mocks.socket.lines();
		expect(lines[0]).toMatch(/^\* ID \("name" "owlat-imap"/);
		expect(lines[1]).toBe('a001 OK ID completed');
	});

	it('NAMESPACE returns the personal namespace', async () => {
		await exec(mocks.socket, 'a001 NAMESPACE');
		const lines = mocks.socket.lines();
		expect(lines[0]).toBe('* NAMESPACE (("" "/")) NIL NIL');
		expect(lines[1]).toBe('a001 OK NAMESPACE completed');
	});

	it('ENABLE echoes * ENABLED with the intersection of requested + advertised caps', async () => {
		// CONDSTORE is advertised (store module); QRESYNC is not, so it must
		// be dropped from the echo. RFC 5161 §3.2.
		await exec(mocks.socket, 'a001 ENABLE CONDSTORE QRESYNC');
		const lines = mocks.socket.lines();
		expect(lines).toContain('* ENABLED CONDSTORE');
		expect(lines.some((l) => l.includes('QRESYNC'))).toBe(false);
		// Untagged ENABLED precedes the tagged OK.
		expect(lines.indexOf('* ENABLED CONDSTORE')).toBeLessThan(
			lines.indexOf('a001 OK ENABLE completed'),
		);
		expect(lines.pop()).toBe('a001 OK ENABLE completed');
	});

	it('ENABLE with no advertised caps still emits a bare * ENABLED', async () => {
		await exec(mocks.socket, 'a001 ENABLE QRESYNC');
		const lines = mocks.socket.lines();
		expect(lines).toContain('* ENABLED');
		expect(lines.pop()).toBe('a001 OK ENABLE completed');
	});

	it('LIST before LOGIN is rejected with BAD', async () => {
		await exec(mocks.socket, 'a001 LIST "" "*"');
		expect(mocks.socket.lines().pop()).toBe('a001 BAD Not authenticated');
	});

	it('SELECT before LOGIN is rejected with BAD', async () => {
		await exec(mocks.socket, 'a001 SELECT INBOX');
		expect(mocks.socket.lines().pop()).toBe('a001 BAD Not authenticated');
	});

	it('UNSELECT does not crash before SELECT', async () => {
		await exec(mocks.socket, 'a001 UNSELECT');
		expect(mocks.socket.lines().pop()).toBe('a001 OK UNSELECT completed');
	});

	it('CLOSE does not crash before SELECT', async () => {
		await exec(mocks.socket, 'a001 CLOSE');
		expect(mocks.socket.lines().pop()).toBe('a001 OK CLOSE completed');
	});

	it('rejects unknown commands with BAD', async () => {
		await exec(mocks.socket, 'a001 BOGUSCMD');
		expect(mocks.socket.lines().pop()).toMatch(
			/^a001 BAD Command "BOGUSCMD" not supported$/,
		);
	});
});

describe('ImapConnection — LOGIN', () => {
	it('rejects LOGIN with no args (BAD, no Convex call)', async () => {
		const { socket, convex } = makeMocks();
		socket.written.length = 0;
		await exec(socket, 'a001 LOGIN');
		expect(socket.lines().pop()).toMatch(/^a001 BAD/);
		expect(convex.action).not.toHaveBeenCalled();
	});

	it('returns NO when Convex verifyAppPassword resolves null', async () => {
		const { socket, convex } = makeMocks();
		socket.written.length = 0;
		convex.action.mockResolvedValue(null);
		await exec(socket, 'a001 LOGIN "alice@test" "wrong"');
		const tail = socket.lines().pop()!;
		expect(tail).toBe('a001 NO Authentication failed');
	});

	it('emits Authenticated capability + OK on successful LOGIN', async () => {
		const { socket, convex } = makeMocks();
		socket.written.length = 0;
		convex.action.mockResolvedValue({
			mailboxId: 'mb1',
			appPasswordId: 'ap1',
			userId: 'u1',
			organizationId: 'org1',
		});
		await exec(socket, 'a001 LOGIN "alice@test" "good"');
		const lines = socket.lines();
		// Untagged Authenticated banner first
		expect(lines.some((l) => /^\* OK \[CAPABILITY.*\] Authenticated$/.test(l))).toBe(true);
		// Tagged OK at the end
		expect(lines.pop()).toBe('a001 OK LOGIN completed');
	});

	it('lowercases the address before passing to Convex (case-insensitive)', async () => {
		const { socket, convex } = makeMocks();
		convex.action.mockResolvedValue(null);
		await exec(socket, 'a001 LOGIN "ALICE@TEST.COM" "x"');
		expect(convex.action).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ address: 'alice@test.com', password: 'x', scope: 'imap' }),
		);
	});

	it('rejects a second LOGIN once authenticated', async () => {
		const { socket, convex } = makeMocks();
		convex.action.mockResolvedValue({
			mailboxId: 'mb1',
			appPasswordId: 'ap1',
			userId: 'u1',
			organizationId: 'org1',
		});
		await exec(socket, 'a001 LOGIN "alice@test" "good"');
		socket.written.length = 0;
		await exec(socket, 'a002 LOGIN "alice@test" "good"');
		expect(socket.lines().pop()).toBe('a002 BAD Already authenticated');
	});

	it('touches the app password with the ip but no userAgent when no ID was sent', async () => {
		const { socket, convex } = makeMocks();
		convex.action.mockResolvedValue({
			mailboxId: 'mb1',
			appPasswordId: 'ap1',
			userId: 'u1',
			organizationId: 'org1',
		});
		await exec(socket, 'a001 LOGIN "alice@test" "good"');
		expect(convex.mutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ appPasswordId: 'ap1', ip: '10.0.0.1' }),
		);
		const touchArgs = convex.mutation.mock.calls[0]![1] as Record<string, unknown>;
		expect(touchArgs).not.toHaveProperty('userAgent');
	});

	it('threads the ID client name into the LOGIN touch userAgent', async () => {
		const { socket, convex } = makeMocks();
		convex.action.mockResolvedValue({
			mailboxId: 'mb1',
			appPasswordId: 'ap1',
			userId: 'u1',
			organizationId: 'org1',
		});
		await exec(socket, 'a001 ID ("name" "Thunderbird" "version" "115.0")');
		await exec(socket, 'a002 LOGIN "alice@test" "good"');
		expect(convex.mutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				appPasswordId: 'ap1',
				ip: '10.0.0.1',
				userAgent: 'Thunderbird',
			}),
		);
	});

	it('ignores a NIL ID parameter list (no userAgent threaded)', async () => {
		const { socket, convex } = makeMocks();
		convex.action.mockResolvedValue({
			mailboxId: 'mb1',
			appPasswordId: 'ap1',
			userId: 'u1',
			organizationId: 'org1',
		});
		await exec(socket, 'a001 ID NIL');
		await exec(socket, 'a002 LOGIN "alice@test" "good"');
		const touchArgs = convex.mutation.mock.calls[0]![1] as Record<string, unknown>;
		expect(touchArgs).not.toHaveProperty('userAgent');
	});
});

describe('ImapConnection — LOGOUT', () => {
	it('emits BYE + OK and ends the socket', async () => {
		const { socket } = makeMocks();
		socket.written.length = 0;
		await exec(socket, 'a001 LOGOUT');
		const lines = socket.lines();
		expect(lines[0]).toBe('* BYE Owlat IMAP signing off');
		expect(lines[1]).toBe('a001 OK LOGOUT completed');
		expect(socket.ended).toBe(true);
	});
});

describe('ImapConnection — LIST after LOGIN', () => {
	async function login(
		mocks: ReturnType<typeof makeMocks>,
		mailboxId = 'mb1',
	): Promise<void> {
		mocks.convex.action.mockResolvedValue({
			mailboxId,
			appPasswordId: 'ap1',
			userId: 'u1',
			organizationId: 'org1',
		});
		await exec(mocks.socket, 'a000 LOGIN "alice@test" "good"');
		mocks.socket.written.length = 0;
	}

	it('queries Convex listFolders with the authenticated mailboxId', async () => {
		const mocks = makeMocks();
		await login(mocks);
		mocks.convex.query.mockResolvedValue([
			{ id: 'f1', name: 'INBOX', role: 'inbox', uidNext: 1, totalCount: 0 },
		]);
		await exec(mocks.socket, 'a001 LIST "" "*"');
		expect(mocks.convex.query).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ mailboxId: 'mb1' }),
		);
		const tagged = mocks.socket.lines().pop()!;
		expect(tagged).toMatch(/^a001 OK LIST completed$/);
	});

	it('LSUB is handled identically to LIST (subscribed = all)', async () => {
		const mocks = makeMocks();
		await login(mocks);
		mocks.convex.query.mockResolvedValue([
			{ id: 'f1', name: 'INBOX', role: 'inbox', uidNext: 1, totalCount: 0 },
		]);
		await exec(mocks.socket, 'a001 LSUB "" "*"');
		expect(mocks.socket.lines().pop()).toBe('a001 OK LSUB completed');
	});
});

describe('ImapConnection — CHECK', () => {
	it('CHECK returns OK without doing any work', async () => {
		const { socket, convex } = makeMocks();
		socket.written.length = 0;
		await exec(socket, 'a001 CHECK');
		expect(socket.lines().pop()).toBe('a001 OK CHECK completed');
		expect(convex.query).not.toHaveBeenCalled();
		expect(convex.mutation).not.toHaveBeenCalled();
	});
});

describe('ImapConnection — AUTHENTICATE PLAIN', () => {
	const goodResult = {
		mailboxId: 'mb1',
		appPasswordId: 'ap1',
		userId: 'u1',
		organizationId: 'org1',
	};

	/** base64( authzid \0 authcid \0 passwd ) per RFC 4616. */
	function saslPlain(authcid: string, password: string, authzid = ''): string {
		return Buffer.from(`${authzid}\0${authcid}\0${password}`, 'utf-8').toString('base64');
	}

	it('greeting advertises AUTH=PLAIN so AUTHENTICATE PLAIN must be honoured (no longer false advertising)', () => {
		const { socket } = makeMocks();
		const greeting = socket.lines()[0]!;
		expect(greeting).toContain('AUTH=PLAIN');
	});

	it('replies with a continuation request to AUTHENTICATE PLAIN', async () => {
		const { socket } = makeMocks();
		socket.written.length = 0;
		await exec(socket, 'a1 AUTHENTICATE PLAIN');
		expect(socket.lines()).toContain('+ ');
	});

	it('authenticates: + then base64 SASL response → verifyAppPassword called + OK', async () => {
		const { socket, convex } = makeMocks();
		convex.action.mockResolvedValue(goodResult);
		socket.written.length = 0;

		await exec(socket, 'a1 AUTHENTICATE PLAIN');
		expect(socket.lines()).toContain('+ ');

		await exec(socket, saslPlain('alice@test', 'good'));

		expect(convex.action).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ address: 'alice@test', password: 'good', scope: 'imap' }),
		);
		const lines = socket.lines();
		expect(lines.some((l) => /^\* OK \[CAPABILITY.*\] Authenticated$/.test(l))).toBe(true);
		expect(lines.pop()).toBe('a1 OK AUTHENTICATE completed');
	});

	it('lowercases the authcid before verifyAppPassword (case-insensitive)', async () => {
		const { socket, convex } = makeMocks();
		convex.action.mockResolvedValue(null);
		socket.written.length = 0;
		await exec(socket, 'a1 AUTHENTICATE PLAIN');
		await exec(socket, saslPlain('ALICE@TEST.COM', 'x'));
		expect(convex.action).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ address: 'alice@test.com', password: 'x', scope: 'imap' }),
		);
	});

	it('returns NO when verifyAppPassword resolves null', async () => {
		const { socket, convex } = makeMocks();
		convex.action.mockResolvedValue(null);
		socket.written.length = 0;
		await exec(socket, 'a1 AUTHENTICATE PLAIN');
		await exec(socket, saslPlain('alice@test', 'wrong'));
		expect(socket.lines().pop()).toBe('a1 NO Authentication failed');
	});

	it('rejects invalid base64 with BAD and never calls verifyAppPassword', async () => {
		const { socket, convex } = makeMocks();
		socket.written.length = 0;
		await exec(socket, 'a1 AUTHENTICATE PLAIN');
		await exec(socket, 'not valid base64!!!');
		expect(socket.lines().pop()).toBe('a1 BAD Invalid SASL PLAIN response');
		expect(convex.action).not.toHaveBeenCalled();
	});

	it('rejects a malformed SASL field layout (wrong number of NUL fields) with BAD', async () => {
		const { socket, convex } = makeMocks();
		socket.written.length = 0;
		await exec(socket, 'a1 AUTHENTICATE PLAIN');
		// Only one NUL separator → 2 fields, not the required 3.
		await exec(socket, Buffer.from('alice@test\0good', 'utf-8').toString('base64'));
		expect(socket.lines().pop()).toBe('a1 BAD Invalid SASL PLAIN response');
		expect(convex.action).not.toHaveBeenCalled();
	});

	it('supports RFC 4959 SASL-IR (initial response folded onto the command line)', async () => {
		const { socket, convex } = makeMocks();
		convex.action.mockResolvedValue(goodResult);
		socket.written.length = 0;
		await exec(socket, `a1 AUTHENTICATE PLAIN ${saslPlain('alice@test', 'good')}`);
		expect(convex.action).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ address: 'alice@test', password: 'good', scope: 'imap' }),
		);
		expect(socket.lines().pop()).toBe('a1 OK AUTHENTICATE completed');
		// No continuation needed when the IR is supplied.
		expect(socket.lines()).not.toContain('+ ');
	});

	it('rejects an unsupported mechanism with NO and no Convex call', async () => {
		const { socket, convex } = makeMocks();
		socket.written.length = 0;
		await exec(socket, 'a1 AUTHENTICATE LOGIN');
		expect(socket.lines().pop()).toMatch(/^a1 NO \[CANNOT\]/);
		expect(convex.action).not.toHaveBeenCalled();
	});

	it('lets the client cancel the exchange with a bare *', async () => {
		const { socket, convex } = makeMocks();
		socket.written.length = 0;
		await exec(socket, 'a1 AUTHENTICATE PLAIN');
		await exec(socket, '*');
		expect(socket.lines().pop()).toBe('a1 BAD AUTHENTICATE cancelled');
		expect(convex.action).not.toHaveBeenCalled();
	});

	it('rejects AUTHENTICATE once already authenticated', async () => {
		const { socket, convex } = makeMocks();
		convex.action.mockResolvedValue(goodResult);
		await exec(socket, 'a1 AUTHENTICATE PLAIN');
		await exec(socket, saslPlain('alice@test', 'good'));
		socket.written.length = 0;
		await exec(socket, 'a2 AUTHENTICATE PLAIN');
		expect(socket.lines().pop()).toBe('a2 BAD Already authenticated');
	});
});

describe('ImapConnection — plaintext (non-TLS dev fallback)', () => {
	it('greeting advertises LOGINDISABLED and drops AUTH=PLAIN', () => {
		const { socket } = makeMocks(false);
		const greeting = socket.lines()[0]!;
		expect(greeting).toContain('LOGINDISABLED');
		expect(greeting).not.toContain('AUTH=PLAIN');
	});

	it('CAPABILITY over a plaintext socket lists LOGINDISABLED, not AUTH=PLAIN', async () => {
		const { socket } = makeMocks(false);
		socket.written.length = 0;
		await exec(socket, 'a001 CAPABILITY');
		const capLine = socket.lines()[0]!;
		expect(capLine).toContain('LOGINDISABLED');
		expect(capLine).not.toContain('AUTH=PLAIN');
	});

	it('LOGIN over a plaintext socket returns NO [PRIVACYREQUIRED] and never calls verifyAppPassword', async () => {
		const { socket, convex } = makeMocks(false);
		socket.written.length = 0;
		await exec(socket, 'a001 LOGIN "alice@test" "good"');
		expect(socket.lines().pop()).toMatch(/^a001 NO \[PRIVACYREQUIRED\]/);
		expect(convex.action).not.toHaveBeenCalled();
	});

	it('AUTHENTICATE PLAIN over a plaintext socket returns NO [PRIVACYREQUIRED] and never calls verifyAppPassword', async () => {
		const { socket, convex } = makeMocks(false);
		socket.written.length = 0;
		await exec(socket, 'a001 AUTHENTICATE PLAIN');
		expect(socket.lines().pop()).toMatch(/^a001 NO \[PRIVACYREQUIRED\]/);
		// No continuation requested, no credential round-trip.
		expect(socket.lines()).not.toContain('+ ');
		expect(convex.action).not.toHaveBeenCalled();
	});

	it('LOGIN over a TLS socket proceeds to verifyAppPassword', async () => {
		const { socket, convex } = makeMocks(true);
		convex.action.mockResolvedValue(null);
		socket.written.length = 0;
		await exec(socket, 'a001 LOGIN "alice@test" "good"');
		expect(convex.action).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ address: 'alice@test', password: 'good', scope: 'imap' }),
		);
	});
});

describe('ImapConnection — SELECT / EXAMINE PERMANENTFLAGS', () => {
	async function login(mocks: ReturnType<typeof makeMocks>): Promise<void> {
		mocks.convex.action.mockResolvedValue({
			mailboxId: 'mb1',
			appPasswordId: 'ap1',
			userId: 'u1',
			organizationId: 'org1',
		});
		await exec(mocks.socket, 'a000 LOGIN "alice@test" "good"');
		mocks.socket.written.length = 0;
	}

	const INBOX_FOLDER = {
		_id: 'f1',
		name: 'INBOX',
		role: 'inbox',
		uidValidity: 1,
		uidNext: 5,
		highestModseq: 7,
		totalCount: 3,
		unseenCount: 0,
	};

	/** listFolders → selectFolder, in that call order. */
	function stubSelect(convex: MockConvex): void {
		convex.query
			.mockResolvedValueOnce([INBOX_FOLDER]) // resolveFolderByName → listFolders
			.mockResolvedValueOnce({ folder: INBOX_FOLDER }); // selectFolder
	}

	it('SELECT (read-write) advertises the writable system flags + \\*', async () => {
		const mocks = makeMocks();
		await login(mocks);
		stubSelect(mocks.convex);
		await execMulti(mocks.socket, 'a001 SELECT INBOX');
		const lines = mocks.socket.lines();
		expect(lines).toContain(
			'* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\*)] Limited',
		);
		// No empty PERMANENTFLAGS and no READ-ONLY for a writable SELECT.
		expect(lines.some((l) => l.includes('[PERMANENTFLAGS ()]'))).toBe(false);
		expect(lines.pop()).toBe('a001 OK [READ-WRITE] SELECT completed');
	});

	it('EXAMINE (read-only) advertises empty PERMANENTFLAGS', async () => {
		const mocks = makeMocks();
		await login(mocks);
		stubSelect(mocks.convex);
		await execMulti(mocks.socket, 'a001 EXAMINE INBOX');
		const lines = mocks.socket.lines();
		expect(lines).toContain('* OK [PERMANENTFLAGS ()] No permanent flags (read-only)');
		expect(lines.pop()).toBe('a001 OK [READ-ONLY] EXAMINE completed');
	});

	it('after a writable SELECT, STORE +FLAGS succeeds and FETCH shows \\Flagged', async () => {
		const mocks = makeMocks();
		await login(mocks);
		stubSelect(mocks.convex);
		await execMulti(mocks.socket, 'a001 SELECT INBOX');
		mocks.socket.written.length = 0;
		mocks.convex.query.mockReset();
		mocks.convex.mutation.mockReset();

		// STORE 1 +FLAGS (\Flagged): listFolderUids (seq↔UID map) →
		// collectMessageIds → resolveMessageIdsByUid, then storeFlags mutation
		// returns the updated row. Sequence 1 maps to UID 1.
		mocks.convex.query.mockResolvedValueOnce([1]); // listFolderUids
		mocks.convex.query.mockResolvedValueOnce([{ _id: 'm1', uid: 1 }]); // resolveMessageIdsByUid
		mocks.convex.mutation.mockResolvedValueOnce({
			updated: [{ uid: 1, modseq: 8, flags: ['\\Flagged'] }],
			unchanged: [],
		});
		await execMulti(mocks.socket, 'a002 STORE 1 +FLAGS (\\Flagged)');
		const storeLines = mocks.socket.lines();
		expect(mocks.convex.mutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ flags: ['\\Flagged'], mode: 'add' }),
		);
		expect(
			storeLines.some((l) => /^\* 1 FETCH .*FLAGS \(\\Flagged\)/.test(l)),
		).toBe(true);
		expect(storeLines.pop()).toBe('a002 OK STORE completed');

		// FETCH 1 (FLAGS) now reflects the stored flag. The module first reads
		// listFolderUids to build the seq↔UID map (sequence 1 → UID 1), then
		// fetchEnvelopes for the resolved UID.
		mocks.socket.written.length = 0;
		mocks.convex.query.mockReset();
		mocks.convex.query.mockResolvedValueOnce([1]); // listFolderUids
		mocks.convex.query.mockResolvedValueOnce([
			{
				uid: 1,
				flagSeen: false,
				flagFlagged: true,
				flagAnswered: false,
				flagDraft: false,
				flagDeleted: false,
				customFlags: [],
			},
		]);
		await execMulti(mocks.socket, 'a003 FETCH 1 (FLAGS)');
		const fetchLines = mocks.socket.lines();
		expect(fetchLines).toContain('* 1 FETCH (FLAGS (\\Flagged))');
		expect(fetchLines.pop()).toBe('a003 OK FETCH completed');
	});
});

describe('ImapConnection — literal octet framing (RFC 3501 §4.3)', () => {
	async function loginOk(mocks: ReturnType<typeof makeMocks>): Promise<void> {
		mocks.convex.action.mockResolvedValue({
			mailboxId: 'mb1',
			appPasswordId: 'ap1',
			userId: 'u1',
			organizationId: 'org1',
		});
		await exec(mocks.socket, 'a000 LOGIN "alice@test" "good"');
		mocks.socket.written.length = 0;
	}

	it('APPEND frames a {6} literal by OCTETS not characters, and preserves the next command boundary', async () => {
		const mocks = makeMocks();
		await loginOk(mocks);

		// 'ééé' is 3 characters but 6 UTF-8 octets — the failure mode of the
		// old setEncoding('utf-8') pump: it would absorb 6 *characters* and
		// misframe both the literal and the following command.
		const body = 'ééé';
		expect(Buffer.byteLength(body, 'utf-8')).toBe(6);
		expect(body.length).toBe(3);

		let appendArgs: Record<string, unknown> | undefined;
		mocks.convex.query.mockResolvedValue([
			{ _id: 'f1', name: 'INBOX', role: 'inbox', uidNext: 1, totalCount: 0 },
		]);
		mocks.convex.mutation.mockImplementation((ref: string, args: unknown) => {
			if (ref === 'mail/imap:generateRawUploadUrl') {
				return Promise.resolve('https://upload.test/blob');
			}
			if (ref === 'mail/imap:appendMessage') {
				appendArgs = args as Record<string, unknown>;
				return Promise.resolve({ uid: 7, uidValidity: 100, modseq: 1 });
			}
			return Promise.resolve(undefined);
		});

		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ storageId: 'sid1' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
			);

		try {
			// Declare a 6-octet literal, then send exactly 6 octets, then a
			// trailing CRLF, then a NOOP. The boundary must land precisely
			// after the 6th octet so the NOOP parses.
			mocks.socket.receive('a001 APPEND INBOX {6}\r\n');
			// '+ Ready for literal data' is sent synchronously by APPEND.start.
			expect(mocks.socket.lines().some((l) => l.startsWith('+ '))).toBe(true);
			mocks.socket.receive(`${body}\r\na002 NOOP\r\n`);
			// Let the async upload + append mutation settle (the upload path
			// awaits fetch + Response.json(), so drain macrotasks too).
			await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 0));

			// The stored blob is exactly 6 bytes (octet-framed), not 3.
			expect(appendArgs).toBeDefined();
			expect(appendArgs!['rawSize']).toBe(6);

			// The body sent to storage is the 6-octet buffer, not a 3-char string.
			const sentBody = fetchMock.mock.calls[0]![1]!.body as Buffer;
			expect(Buffer.isBuffer(sentBody)).toBe(true);
			expect(sentBody.length).toBe(6);
			expect(sentBody.equals(Buffer.from(body, 'utf-8'))).toBe(true);

			// Boundary preserved: the NOOP after the literal was parsed + answered.
			expect(mocks.socket.lines()).toContain('a002 OK NOOP completed');
		} finally {
			fetchMock.mockRestore();
		}
	});
});

describe('ImapConnection — LOGIN literal continuation (RFC 3501 §4.3 / RFC 7888)', () => {
	it('a LOGIN {4}\\r\\n sends a "+ " continuation then authenticates from {N} literals', async () => {
		const { socket, convex } = makeMocks();
		socket.written.length = 0;
		convex.action.mockResolvedValue({
			mailboxId: 'mb1',
			appPasswordId: 'ap1',
			userId: 'u1',
			organizationId: 'org1',
		});

		// First literal: user {4}. Server must invite data with '+ '.
		socket.receive('a LOGIN {4}\r\n');
		await Promise.resolve();
		expect(socket.written.join('')).toContain('+ ');

		// 4 octets of user, then the password as a second {8} literal.
		socket.receive('user {8}\r\n');
		await Promise.resolve();
		// Second '+ ' continuation for the password literal.
		expect(socket.written.filter((w) => w.startsWith('+ ')).length).toBe(2);

		socket.receive('password\r\n');
		for (let i = 0; i < 6; i += 1) await Promise.resolve();

		// The assembled command parsed to user='user' / password='password'.
		expect(convex.action).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ address: 'user', password: 'password', scope: 'imap' }),
		);
		expect(socket.lines().pop()).toBe('a OK LOGIN completed');
	});

	it('LITERAL+ ({N+}) inline LOGIN authenticates with no continuation prompt', async () => {
		const { socket, convex } = makeMocks();
		socket.written.length = 0;
		convex.action.mockResolvedValue({
			mailboxId: 'mb1',
			appPasswordId: 'ap1',
			userId: 'u1',
			organizationId: 'org1',
		});

		// Everything inline — non-synchronizing LITERAL+ means the server must
		// NOT send a '+ ' continuation; the literal octets follow immediately.
		socket.receive('b LOGIN {4+}\r\nuser {8+}\r\npassword\r\n');
		for (let i = 0; i < 6; i += 1) await Promise.resolve();

		expect(socket.written.some((w) => w.startsWith('+ '))).toBe(false);
		expect(convex.action).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ address: 'user', password: 'password', scope: 'imap' }),
		);
		expect(socket.lines().pop()).toBe('b OK LOGIN completed');
	});

	it('counts LOGIN literal length by octets (8-bit password)', async () => {
		const { socket, convex } = makeMocks();
		socket.written.length = 0;
		convex.action.mockResolvedValue(null);

		// 'pä' is 2 chars / 3 octets — declared {3}. A char-counting pump would
		// frame it wrong; octet framing parses the full password and the NOOP.
		socket.receive('c LOGIN {2}\r\n');
		await Promise.resolve();
		socket.receive('us {3}\r\n');
		await Promise.resolve();
		socket.receive('pä\r\nc2 NOOP\r\n');
		for (let i = 0; i < 6; i += 1) await Promise.resolve();

		expect(convex.action).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ address: 'us', password: 'pä', scope: 'imap' }),
		);
		// Boundary preserved: the NOOP after the literal command was parsed.
		expect(socket.lines()).toContain('c2 OK NOOP completed');
	});

	it('rejects a pre-auth literal larger than the pre-auth ceiling instead of buffering it', () => {
		const { socket } = makeMocks();
		socket.written.length = 0;

		// Unauthenticated peer declares a 1 MiB literal for LOGIN. The only
		// legitimate pre-auth literal is credentials (tens of bytes), so the pump
		// must refuse — never buffer up to maxLiteralBytes (50 MiB) before dispatch.
		socket.receive('x LOGIN {1048576}\r\n');

		// Aborted with a BYE notice and torn down; no '+ ' continuation was sent
		// (the literal body is never invited / absorbed).
		expect(socket.written.join('')).toContain('* BYE Literal too large');
		expect(socket.written.some((w) => w.startsWith('+ '))).toBe(false);
		expect(socket.ended).toBe(true);
	});

	it('rejects an oversized pre-auth literal on a non-LOGIN verb', () => {
		const { socket } = makeMocks();
		socket.written.length = 0;

		// Any verb's {N} literal pre-auth is bounded to the pre-auth ceiling.
		socket.receive('y FOO {1048576}\r\n');

		expect(socket.written.join('')).toContain('* BYE Literal too large');
		expect(socket.written.some((w) => w.startsWith('+ '))).toBe(false);
		expect(socket.ended).toBe(true);
	});

	it('does not overflow the stack on thousands of chained tiny {N+} literals in one buffer', async () => {
		const { socket, convex } = makeMocks();
		socket.written.length = 0;
		convex.action.mockResolvedValue(null);

		// Pre-auth DoS regression: a single TCP segment can pack thousands of
		// tiny non-synchronizing ({1+}) literals — each 1 octet (under the
		// pre-auth ceiling) with CRLFs present (line guard never trips). The pump
		// must absorb them iteratively (O(1) stack), not self-recurse one frame
		// per literal, which previously overflowed the V8 stack and crashed the
		// shared process. We feed ~10k chained literals as one buffer; the test
		// reaching its assertions at all proves no RangeError was thrown.
		const count = 10_000;
		let payload = 'z LOGIN {1+}\r\n';
		for (let i = 0; i < count; i += 1) {
			payload += 'x{1+}\r\n';
		}
		// Terminate the chained command with a final non-literal segment, then a
		// fresh NOOP so we can prove the pump still parses subsequent commands.
		payload += 'x\r\nz2 NOOP\r\n';

		// Must not throw (no stack overflow) regardless of literal count.
		expect(() => socket.receive(payload)).not.toThrow();
		for (let i = 0; i < 8; i += 1) await Promise.resolve();

		// Boundary preserved: the NOOP after the giant chained command still
		// parsed and was answered (the connection is alive, not crashed).
		expect(socket.lines()).toContain('z2 OK NOOP completed');
	});
});
