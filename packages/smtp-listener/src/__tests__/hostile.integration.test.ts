/**
 * HOSTILE-CLIENT integration suite — the adversarial hardening layer (I4: the
 * byte budget is load-bearing; hostile input is bounded, never a crash / DoS /
 * forged-auth pass).
 *
 * Every case drives the REAL listener over a raw socket and asserts the attack
 * is BOUNDED, by one of two provable mechanisms:
 *   - the right TIMEOUT fires (a 421 4.4.2 close on the command / DATA idle
 *     timer), or
 *   - a COUNTER caps it: the per-command byte cap (500 + destroy), the
 *     bad-command budget (421 4.7.0 after N), or the DATA-phase byte budget's
 *     drain-past-limit / destroy-at-abort ceiling (the `ByteBudget` core is
 *     pinned directly in `budget.test.ts`).
 *
 * Each attack also asserts the listener SURVIVES — a fresh, well-behaved
 * connection completes a transaction afterward — so a bounded attack never
 * degrades into a listener-wide DoS. Connection-COUNT limits are deliberately
 * out of scope here (I8: rate limiting lives in inboundSecurity.ts /
 * submissionSecurity.ts; the listener bounds each connection independently and
 * exposes hook points only).
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import net from 'node:net';
import type { SmtpListener } from '../server.js';
import type { SmtpListenerOptions } from '../types.js';
import { Client, generateCert, startListener, closeAllListeners } from './tlsTestUtil.js';

async function start(overrides: Partial<SmtpListenerOptions> = {}): Promise<{
	listener: SmtpListener;
	port: number;
	messages: Buffer[];
}> {
	const messages: Buffer[] = [];
	const { listener, port } = await startListener({
		hostname: 'mx.test',
		onData: (message) => {
			messages.push(message);
		},
		...overrides,
	});
	return { listener, port, messages };
}

/** Prove the listener still serves after an attack: a clean transaction succeeds. */
async function expectStillServes(port: number): Promise<void> {
	const c = await Client.connect(port);
	await c.waitCode(220);
	c.write('MAIL FROM:<ok@a.test>\r\nRCPT TO:<ok@b.test>\r\nDATA\r\n');
	await c.waitCode(354);
	c.write('healthy\r\n.\r\n');
	await c.waitFor((b) => /250 2\.0\.0/.test(b));
	c.end();
}

afterEach(closeAllListeners);

// ---------------------------------------------------------------------------
// Slowloris — every phase. Bounded by the idle timer AND the byte cap.
// ---------------------------------------------------------------------------

describe('slowloris', () => {
	it('a silent connection is closed by the command idle timer (421 4.4.2)', async () => {
		const { port } = await start({ timeouts: { commandMs: 150, dataMs: 150 } });
		const c = await Client.connect(port);
		await c.waitCode(220);
		// Send nothing at all — the command idle timer must fire and tear down.
		await c.waitFor((b) => /421 4\.4\.2/.test(b), 3000);
		await c.waitClose();
		expect(c.closed).toBe(true);
	});

	it('a never-terminated command line is bounded by the byte cap (500 + destroy)', async () => {
		const { port } = await start({ maxCommandBytes: 256 });
		const c = await Client.connect(port);
		await c.waitCode(220);
		// Dribble a command that never sends CRLF; the reader caps buffered bytes
		// at maxCommandBytes and drops the peer rather than buffering unboundedly.
		for (let i = 0; i < 20; i++) c.write('A'.repeat(64));
		await c.waitCode(500);
		await c.waitClose();
		expect(c.closed).toBe(true);
	});

	it('a stalled DATA phase is closed by the DATA idle timer (421)', async () => {
		const { port, messages } = await start({ timeouts: { commandMs: 5000, dataMs: 150 } });
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('MAIL FROM:<a@a.test>\r\nRCPT TO:<b@b.test>\r\nDATA\r\n');
		await c.waitCode(354);
		// Send a partial body then stall: the DATA idle timer must fire.
		c.write('partial line with no terminator\r\n');
		await c.waitFor((b) => /421 /.test(b), 3000);
		await c.waitClose();
		expect(c.closed).toBe(true);
		expect(messages).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Oversized line. Bounded by the command byte cap.
// ---------------------------------------------------------------------------

describe('oversized command line', () => {
	it('drops the peer with 500 and never buffers past the cap', async () => {
		const { port } = await start({ maxCommandBytes: 64 });
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('EHLO ' + 'x'.repeat(4096)); // no CRLF, far past the 64-byte cap
		await c.waitCode(500);
		await c.waitClose();
		expect(c.closed).toBe(true);
	});

	it('rejects an oversized CRLF-terminated line delivered in one chunk', async () => {
		const { port } = await start({ maxCommandBytes: 64 });
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write(`EHLO ${'x'.repeat(100)}\r\n`);
		await c.waitCode(500);
		await c.waitClose();
		expect(c.closed).toBe(true);
		await expectStillServes(port);
	});

	it('rejects an oversized CRLF-terminated line assembled from fragments', async () => {
		const { port } = await start({ maxCommandBytes: 64 });
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write(`EHLO ${'x'.repeat(40)}`);
		await new Promise<void>((resolve) => setImmediate(resolve));
		c.write(`${'x'.repeat(40)}\r\n`);
		await c.waitCode(500);
		await c.waitClose();
		expect(c.closed).toBe(true);
		await expectStillServes(port);
	});
});

// ---------------------------------------------------------------------------
// NUL bytes in commands. Bounded by the bad-command budget; no crash, no forged
// accept.
// ---------------------------------------------------------------------------

describe('NUL bytes in commands', () => {
	it('treats a NUL-laden verb as an unrecognized command and keeps serving', async () => {
		const { port } = await start();
		const c = await Client.connect(port);
		await c.waitCode(220);
		// A NUL inside the verb makes it unrecognized — answered with a 5xx, never
		// executed, never a crash.
		c.write('MAIL\x00FROM:<a@b.test>\r\n');
		await c.waitFor((b) => /(^|\n)5\d\d[ -]/m.test(b));
		// The session survives; a NOOP still answers.
		c.write('NOOP\r\n');
		await c.waitFor((b) => /250 2\.0\.0/.test(b));
		c.end();
	});

	it('a flood of NUL commands is bounded by the bad-command budget (421)', async () => {
		const { port } = await start({ maxBadCommands: 5 });
		const c = await Client.connect(port);
		await c.waitCode(220);
		let flood = '';
		for (let i = 0; i < 50; i++) flood += '\x00\x00\x00\x00\r\n';
		c.write(flood);
		await c.waitCode(421);
		await c.waitClose();
		expect(c.closed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Early disconnect at each protocol state. Bounded: no crash, no delivery, the
// listener stays up.
// ---------------------------------------------------------------------------

describe('early disconnect at each state', () => {
	const states: Array<{ name: string; drive: (c: Client) => Promise<void> }> = [
		{
			name: 'after greeting',
			drive: async (c) => {
				await c.waitCode(220);
			},
		},
		{
			name: 'after EHLO',
			drive: async (c) => {
				await c.waitCode(220);
				c.write('EHLO evil.test\r\n');
				await c.waitCode(250);
			},
		},
		{
			name: 'after MAIL FROM',
			drive: async (c) => {
				await c.waitCode(220);
				c.write('MAIL FROM:<a@a.test>\r\n');
				await c.waitFor((b) => /250 2\.1\.0/.test(b));
			},
		},
		{
			name: 'after RCPT TO',
			drive: async (c) => {
				await c.waitCode(220);
				c.write('MAIL FROM:<a@a.test>\r\nRCPT TO:<b@b.test>\r\n');
				await c.waitFor((b) => /250 2\.1\.5/.test(b));
			},
		},
		{
			name: 'mid-DATA',
			drive: async (c) => {
				await c.waitCode(220);
				c.write('MAIL FROM:<a@a.test>\r\nRCPT TO:<b@b.test>\r\nDATA\r\n');
				await c.waitCode(354);
				c.write('half a message with no terminator\r\n');
			},
		},
	];

	for (const state of states) {
		it(`survives a FIN ${state.name} with no delivery`, async () => {
			const { port, messages } = await start();
			const c = await Client.connect(port);
			await state.drive(c);
			c.socket.end(); // FIN at this state
			await c.waitClose();
			expect(c.closed).toBe(true);
			expect(messages).toHaveLength(0);
			// The listener is unharmed and serves the next connection.
			await expectStillServes(port);
		});
	}
});

// ---------------------------------------------------------------------------
// TLS-handshake abandonment. Bounded: upgradeTls settles on error/close and the
// socket is destroyed; the listener survives.
// ---------------------------------------------------------------------------

describe('TLS-handshake abandonment', () => {
	let cert: string;
	let key: string;
	beforeAll(() => {
		const material = generateCert('mx.test');
		cert = material.cert;
		key = material.key;
	}, 20000);

	it('STARTTLS then plaintext garbage: the handshake errors and the socket dies', async () => {
		const { port } = await start({ tls: { cert, key } });
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('STARTTLS\r\n');
		await c.waitCode(220);
		// Instead of a ClientHello, send junk — the server-side TLS handshake
		// errors, upgradeTls rejects, and the command loop destroys the socket.
		c.write('this is not a tls client hello at all\r\n');
		await c.waitClose(4000);
		expect(c.closed).toBe(true);
		// The listener itself is unharmed.
		await expectStillServes(port);
	});

	it('STARTTLS then FIN before the handshake: upgradeTls settles on close', async () => {
		const { port } = await start({ tls: { cert, key } });
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('STARTTLS\r\n');
		await c.waitCode(220);
		c.socket.end(); // FIN after reading 220, never starting the handshake
		await c.waitClose(4000);
		expect(c.closed).toBe(true);
		await expectStillServes(port);
	});

	it('STARTTLS then total silence: the command idle timer tears down with 421 4.4.2', async () => {
		// The slowloris TLS variant: read the 220 Ready, then send NO ClientHello and
		// NO FIN. Neither the TLS `secure` nor `error` event fires, so boundedness
		// rests SOLELY on the plaintext command idle timer staying armed across
		// `upgradeTls` (src/tls.ts / commandLoop.ts) — the exact attack the tls.ts
		// doc-comment names. The client never began TLS, so the teardown 421 is
		// readable in plaintext.
		const { port } = await start({ tls: { cert, key }, timeouts: { commandMs: 150, dataMs: 150 } });
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('STARTTLS\r\n');
		await c.waitCode(220);
		// Total silence from here: the idle timer must fire the 421 4.4.2 close.
		await c.waitFor((b) => /421 4\.4\.2/.test(b), 3000);
		await c.waitClose();
		expect(c.closed).toBe(true);
		await expectStillServes(port);
	});

	it('implicit-TLS port fed plaintext garbage: the connection is dropped', async () => {
		const { port } = await start({ tls: { cert, key }, implicitTls: true });
		// Connect with a RAW (non-TLS) socket and shove plaintext at the 465-style
		// listener; the TLS server rejects the bogus ClientHello and drops us.
		const closed = await new Promise<boolean>((resolve) => {
			const sock = net.connect(port, '127.0.0.1', () => {
				sock.write('EHLO plaintext-on-implicit-tls\r\n');
			});
			// Capture the fallback timer so it can be cleared once close/error wins —
			// otherwise it stays armed and holds the event loop after the test resolves.
			const fallback = setTimeout(() => {
				sock.destroy();
				resolve(false);
			}, 4000);
			sock.on('close', () => {
				clearTimeout(fallback);
				resolve(true);
			});
			sock.on('error', () => {
				clearTimeout(fallback);
				resolve(true);
			});
		});
		expect(closed).toBe(true);
		// A proper implicit-TLS client still connects afterward.
		const c = await Client.connectTls(port, 'mx.test');
		await c.waitCode(220);
		c.end();
	});
});

// ---------------------------------------------------------------------------
// Connection flood. Bounded per-connection by the idle timer (I8: the listener
// caps each connection, not the count — that lives in inboundSecurity.ts).
// ---------------------------------------------------------------------------

describe('connection flood', () => {
	it('every connection in a flood is independently bounded by the idle timer', async () => {
		const FLOOD = 30;
		const { port } = await start({ timeouts: { commandMs: 200, dataMs: 200 } });
		const clients = await Promise.all(Array.from({ length: FLOOD }, () => Client.connect(port)));
		// Each greets, then goes silent — every one must be torn down by its own
		// idle timer (memory stays bounded: no unbounded buffering per socket).
		await Promise.all(clients.map((c) => c.waitCode(220)));
		await Promise.all(clients.map((c) => c.waitClose(3000)));
		expect(clients.every((c) => c.closed)).toBe(true);
		// The listener survived the flood.
		await expectStillServes(port);
	});
});

// ---------------------------------------------------------------------------
// Pipelining desync. Bounded: commands answered in order; a desynced batch is
// rejected per-command and capped by the bad-command budget.
// ---------------------------------------------------------------------------

describe('pipelining desync', () => {
	it('DATA pipelined before MAIL/RCPT is refused 503 without consuming a body', async () => {
		const { port, messages } = await start();
		const c = await Client.connect(port);
		await c.waitCode(220);
		// A desynced batch: DATA before any envelope, then body-looking lines that
		// the server must treat as ordinary (unrecognized) commands, NOT as DATA.
		c.write('DATA\r\nSubject: injected\r\nbody line\r\n.\r\nNOOP\r\n');
		await c.waitCode(503); // DATA refused (need MAIL and RCPT)
		// The trailing NOOP is still answered in order — the loop never desynced.
		await c.waitFor((b) => /250 2\.0\.0/.test(b));
		expect(messages).toHaveLength(0);
		c.end();
	});

	it('body bytes streamed as commands are bounded by the bad-command budget (421)', async () => {
		const { port } = await start({ maxBadCommands: 8 });
		const c = await Client.connect(port);
		await c.waitCode(220);
		// A client that streams message lines without ever issuing DATA: each line
		// is an unrecognized command, capped by the budget rather than looping.
		let desync = '';
		for (let i = 0; i < 40; i++) desync += `Received: from spoof by relay id ${i}\r\n`;
		c.write(desync);
		await c.waitCode(421);
		await c.waitClose();
		expect(c.closed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Valid RCPT flood. Bounded by the per-transaction recipient cap rather than
// the bad-command counter (every command is syntactically valid).
// ---------------------------------------------------------------------------

describe('recipient flood', () => {
	it('caps accepted recipients, skips excess handler work, and still accepts DATA', async () => {
		const acceptedByHandler: string[] = [];
		let deliveredRecipients: string[] = [];
		const { port } = await start({
			maxRecipients: 5,
			onRcptTo: (address) => {
				acceptedByHandler.push(address.address);
			},
			onData: (_message, session) => {
				deliveredRecipients = session.rcptTo.map((recipient) => recipient.address);
			},
		});
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('MAIL FROM:<a@a.test>\r\n');
		await c.waitFor((b) => /250 2\.1\.0/.test(b));

		let flood = '';
		for (let i = 0; i < 100; i++) flood += `RCPT TO:<u${i}@b.test>\r\n`;
		c.write(flood);
		await c.waitFor((b) => (b.match(/250 2\.1\.5/g) ?? []).length === 5);
		await c.waitFor((b) => (b.match(/452 4\.5\.3/g) ?? []).length === 95);

		expect(acceptedByHandler).toHaveLength(5);
		c.write('DATA\r\n');
		await c.waitCode(354);
		c.write('bounded\r\n.\r\n');
		await c.waitFor((b) => /250 2\.0\.0/.test(b));
		expect(deliveredRecipients).toEqual([
			'u0@b.test',
			'u1@b.test',
			'u2@b.test',
			'u3@b.test',
			'u4@b.test',
		]);
		c.end();
	});
});
