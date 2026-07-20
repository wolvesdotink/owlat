/**
 * HOSTILE-CLIENT integration suite for the REAL port-25 MX / bounce listener
 * (I4: the byte budget is load-bearing; hostile input is bounded, never a crash
 * / DoS / forged accept).
 *
 * Unlike the generic `@owlat/smtp-listener` hostile suite (which drives a bare
 * listener with tuned knobs), this boots the ACTUAL production factory
 * `createBounceServer(config, redis)` on a loopback port — its real hostname,
 * banner, hooks and the production 10 MiB DATA byte budget — and asserts that
 * hostile input is bounded and the listener keeps serving. It proves the
 * MX-specific policy layered on the listener (SPF/TLS/RCPT hooks, the bounce
 * intake pipeline in `onData`) does not weaken the listener's hardening.
 *
 * Per-IP connection RATE limiting is out of scope here (I8: it lives in
 * inboundSecurity.ts, unit-tested separately). This suite pins the
 * per-connection command-loop bounds, the DATA byte budget, the idle timers, the
 * global `bounceMaxClients` concurrency cap, and STARTTLS-handshake abandonment
 * against the real production factory.
 */

import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import net from 'node:net';
import Redis from 'ioredis-mock';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { SmtpListener } from '@owlat/smtp-listener';
import { createBounceServer } from '../server.js';
import type { MtaConfig } from '../../config.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** The production 10 MiB DATA byte budget (mirrors `server.ts` `MAX_INBOUND_BYTES`). */
const MAX_INBOUND_BYTES = 10 * 1024 * 1024;

/**
 * The production-shaped MX config: real hostname/banner + the real byte budget.
 * `overrides` tune the load-bearing knobs a given adversarial case needs (idle
 * timeouts, the global client cap, STARTTLS material) without changing the
 * production factory / hooks under test.
 */
function makeConfig(overrides: Partial<MtaConfig> = {}): MtaConfig {
	return {
		ehloHostname: 'mx.owlat.test',
		bounceMaxClients: 200,
		bounceMaxConnectionsPerIp: 50,
		bounceTarpitEnabled: false,
		bounceTarpitDelayMs: 0,
		// Production defaults preserve smtp-server's 60 s socketTimeout; individual
		// idle-timer cases turn these down so the teardown is observable in-test.
		bounceSocketTimeoutMs: 60000,
		inboundSpfEnabled: false,
		inboundDkimEnabled: false,
		inboundDmarcEnabled: false,
		inboundArcEnabled: false,
		...overrides,
	} as unknown as MtaConfig;
}

const listeners: SmtpListener[] = [];

async function start(
	overrides: Partial<MtaConfig> = {}
): Promise<{ port: number; redis: InstanceType<typeof Redis> }> {
	const redis = new Redis();
	// Disable the dynamic inbound-TLS requirement so a clean plaintext transaction
	// can complete in the "still serves" probe (the gate itself is unit-tested).
	await redis.set('mta:inbound-tls-required', '0');
	const listener = createBounceServer(makeConfig(overrides), redis as never);
	await listener.listen(0, '127.0.0.1');
	listeners.push(listener);
	return { port: (listener.address() as AddressInfo).port, redis };
}

afterEach(async () => {
	while (listeners.length > 0) {
		const l = listeners.pop();
		if (l) await l.close();
	}
});

/** A minimal raw-socket SMTP client for adversarial drive-by tests. */
class Client {
	private buf = '';
	closed = false;
	private constructor(readonly socket: net.Socket) {
		socket.setEncoding('utf8');
		socket.on('data', (d: string) => {
			this.buf += d;
		});
		socket.on('close', () => {
			this.closed = true;
		});
		socket.on('error', () => {
			this.closed = true;
		});
	}

	static connect(port: number): Promise<Client> {
		return new Promise((resolve) => {
			const socket = net.connect(port, '127.0.0.1', () => resolve(new Client(socket)));
		});
	}

	write(s: string): void {
		this.socket.write(s);
	}

	end(): void {
		this.socket.end();
	}

	async waitFor(pred: (buf: string) => boolean, timeoutMs = 3000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (pred(this.buf)) return;
			if (Date.now() > deadline) throw new Error(`timed out; buffer so far:\n${this.buf}`);
			await new Promise((r) => setTimeout(r, 10));
		}
	}

	waitCode(code: number, timeoutMs = 3000): Promise<void> {
		return this.waitFor((b) => new RegExp(`(^|\\n)${code}[ -]`, 'm').test(b), timeoutMs);
	}

	async waitClose(timeoutMs = 3000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!this.closed) {
			if (Date.now() > deadline) throw new Error('timed out waiting for close');
			await new Promise((r) => setTimeout(r, 10));
		}
	}
}

/** Prove the listener still serves: greeting + EHLO advertising the real SIZE. */
async function expectStillServes(port: number): Promise<void> {
	const c = await Client.connect(port);
	await c.waitCode(220);
	c.write('EHLO probe.test\r\n');
	// The production 10 MiB DATA budget is advertised via EHLO SIZE.
	await c.waitFor((b) => b.includes('SIZE 10485760'));
	c.write('NOOP\r\n');
	await c.waitFor((b) => /250 2\.0\.0/.test(b));
	c.end();
}

describe('MX listener hostile input is bounded (production config)', () => {
	it('greets with the production banner and advertises the 10 MiB SIZE', async () => {
		const { port } = await start();
		const c = await Client.connect(port);
		await c.waitFor((b) => b.startsWith('220 mx.owlat.test Owlat MTA Bounce Processor'));
		c.write('EHLO probe.test\r\n');
		await c.waitFor((b) => b.includes('SIZE 10485760'));
		c.end();
	});

	it('drops an oversized command line with 500 and never buffers unboundedly', async () => {
		const { port } = await start();
		const c = await Client.connect(port);
		await c.waitCode(220);
		// A command far past the 4096-byte default cap, never terminated by CRLF.
		c.write('EHLO ' + 'x'.repeat(9000));
		await c.waitCode(500);
		await c.waitClose();
		expect(c.closed).toBe(true);
	});

	it('caps a bad-command flood with 421 (the default 25-command budget)', async () => {
		const { port } = await start();
		const c = await Client.connect(port);
		await c.waitCode(220);
		let flood = '';
		for (let i = 0; i < 40; i++) flood += 'WATBADVERB\r\n';
		c.write(flood);
		await c.waitCode(421);
		await c.waitClose();
		expect(c.closed).toBe(true);
	});

	it('treats a NUL-laden verb as unrecognized and keeps serving', async () => {
		const { port } = await start();
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('MAIL\x00FROM:<a@b.test>\r\n');
		await c.waitFor((b) => /(^|\n)5\d\d[ -]/m.test(b));
		c.write('NOOP\r\n');
		await c.waitFor((b) => /250 2\.0\.0/.test(b));
		c.end();
	});

	it('refuses DATA pipelined before MAIL/RCPT with 503 and answers the trailing NOOP in order', async () => {
		const { port } = await start();
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('DATA\r\nSubject: injected\r\nbody\r\n.\r\nNOOP\r\n');
		await c.waitCode(503);
		await c.waitFor((b) => /250 2\.0\.0/.test(b));
		c.end();
	});

	it('survives a FIN after the greeting and keeps serving', async () => {
		const { port } = await start();
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.end();
		await c.waitClose();
		await expectStillServes(port);
	});

	it('accepts a well-formed VERP bounce end-to-end (the onData pipeline ACKs)', async () => {
		const { port } = await start();
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('EHLO probe.test\r\n');
		await c.waitCode(250);
		c.write('MAIL FROM:<>\r\n');
		await c.waitCode(250);
		c.write('RCPT TO:<bounce+abc@bounces.owlat.test>\r\n');
		await c.waitCode(250);
		c.write('DATA\r\n');
		await c.waitCode(354);
		c.write(
			[
				'Subject: Delivery Status Notification (Failure)',
				'',
				'A minimal bounce body.',
				'.',
				'',
			].join('\r\n')
		);
		// The bounce intake pipeline classifies and ACKs the message (250).
		await c.waitFor((b) => /250 2\.0\.0/.test(b));
		c.end();
	});

	it('caps the production MX transaction at its single consumed recipient', async () => {
		const { port } = await start();
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('EHLO probe.test\r\n');
		await c.waitCode(250);
		c.write('MAIL FROM:<>\r\n');
		await c.waitCode(250);
		c.write('RCPT TO:<bounce+first@bounces.owlat.test>\r\n');
		await c.waitCode(250);
		c.write('RCPT TO:<bounce+ignored@bounces.owlat.test>\r\n');
		await c.waitCode(452);
		c.write('DATA\r\n');
		await c.waitCode(354);
		c.write('Subject: bounded recipient state\r\n\r\nbody\r\n.\r\n');
		await c.waitFor((b) => /250 2\.0\.0/.test(b));
		c.end();
	});
});

// The DATA-phase byte budget is the load-bearing hardening whose MTA-level test
// this piece deleted with `lib/__tests__/dataStream.test.ts`: advertising `SIZE`
// in EHLO is only a hint, so the listener MUST enforce the streamed byte count.
// These drive the REAL 10 MiB production budget (`MAX_INBOUND_BYTES`) end-to-end.
describe('MX listener enforces the 10 MiB DATA byte budget (production config)', () => {
	/** Establish an envelope and enter the DATA phase (354). */
	async function enterData(port: number): Promise<Client> {
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('EHLO probe.test\r\n');
		await c.waitCode(250);
		c.write('MAIL FROM:<>\r\n');
		await c.waitCode(250);
		c.write('RCPT TO:<bounce+abc@bounces.owlat.test>\r\n');
		await c.waitCode(250);
		c.write('DATA\r\n');
		await c.waitCode(354);
		return c;
	}

	it('refuses a message just over the 10 MiB budget with 552, drains it, and keeps the session usable', async () => {
		const { port } = await start();
		const c = await enterData(port);
		// One byte over the budget → the drain-past-limit path: buffer released,
		// bytes kept draining to the terminating dot, answered with a clean 552.
		c.write('x'.repeat(MAX_INBOUND_BYTES + 1024) + '\r\n.\r\n');
		await c.waitCode(552);
		// The transaction reset: the session is still usable for the next command.
		c.write('NOOP\r\n');
		await c.waitFor((b) => /250 2\.0\.0/.test(b));
		c.end();
	});

	it('destroys the socket once DATA crosses the 4× abort ceiling (bandwidth bound)', async () => {
		const { port } = await start();
		const c = await enterData(port);
		// Stream past maxBytes*4 (40 MiB) with no terminator: the budget aborts and
		// the listener destroys the socket rather than draining unbounded bandwidth.
		c.write('x'.repeat(MAX_INBOUND_BYTES * 4 + 64 * 1024));
		await c.waitClose(10000);
		expect(c.closed).toBe(true);
	});
});

// Slowloris: a peer that opens a connection (or a DATA phase) and then stalls
// must be torn down by the RIGHT idle timer, never held open indefinitely. The
// production timeouts are 60 s; these turn them down so the teardown is
// observable, but exercise the same real factory + command loop.
describe('MX listener idle timers tear down stalled peers (production config)', () => {
	it('closes a silent connection with 421 4.4.2 (command idle timer)', async () => {
		const { port } = await start({ bounceSocketTimeoutMs: 500 });
		const c = await Client.connect(port);
		await c.waitCode(220);
		// Say nothing: the command idle timer must fire a 421 4.4.2 and close.
		await c.waitFor((b) => /421 4\.4\.2/.test(b), 3000);
		await c.waitClose();
		expect(c.closed).toBe(true);
	});

	it('closes a stalled DATA phase with 421 (DATA idle timer)', async () => {
		const { port } = await start({ bounceSocketTimeoutMs: 500 });
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('EHLO probe.test\r\n');
		await c.waitCode(250);
		c.write('MAIL FROM:<>\r\n');
		await c.waitCode(250);
		c.write('RCPT TO:<bounce+abc@bounces.owlat.test>\r\n');
		await c.waitCode(250);
		c.write('DATA\r\n');
		await c.waitCode(354);
		// Send no body: the DATA idle timer must fire a 421 and tear down.
		await c.waitFor((b) => /(^|\n)421 /m.test(b), 3000);
		await c.waitClose();
		expect(c.closed).toBe(true);
	});
});

// Global concurrent-connection cap (`bounceMaxClients`): over the cap the
// listener answers a real 421 retry-later (a remote MTA re-queues on 421), NOT an
// abrupt accept-and-destroy — the divergence fixed in this round.
describe('MX listener bounds a connection flood with 421 (production config)', () => {
	it('refuses the over-cap connection with 421 while the in-cap ones keep serving', async () => {
		const { port } = await start({ bounceMaxClients: 2 });
		const held: Client[] = [];
		// Fill the 2 slots and keep them open (no QUIT) so the counter stays at cap.
		for (let i = 0; i < 2; i++) {
			const c = await Client.connect(port);
			await c.waitCode(220);
			held.push(c);
		}
		// The 3rd connection is over the cap: a 421, not a bare close.
		const over = await Client.connect(port);
		await over.waitCode(421);
		await over.waitFor((b) => /Too many connected clients/.test(b));
		await over.waitClose();
		expect(over.closed).toBe(true);
		for (const c of held) c.end();
	});
});

// TLS-handshake abandonment: production offers STARTTLS, so the listener must
// survive a peer that begins STARTTLS and then never completes (or feeds garbage
// into) the handshake — the socket dies, the listener keeps serving.
describe('MX listener survives STARTTLS abandonment (production config + real certs)', () => {
	let certPem: string;
	let keyPem: string;

	beforeAll(() => {
		const dir = mkdtempSync(join(tmpdir(), 'owlat-mx-tls-test-'));
		try {
			execFileSync('openssl', [
				'req',
				'-x509',
				'-newkey',
				'rsa:2048',
				'-keyout',
				join(dir, 'key.pem'),
				'-out',
				join(dir, 'cert.pem'),
				'-days',
				'1',
				'-nodes',
				'-subj',
				'/CN=mx.owlat.test',
			]);
			certPem = readFileSync(join(dir, 'cert.pem'), 'utf8');
			keyPem = readFileSync(join(dir, 'key.pem'), 'utf8');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const tlsConfig = (): Partial<MtaConfig> =>
		({ bounceServerTlsCert: certPem, bounceServerTlsKey: keyPem }) as Partial<MtaConfig>;

	it('advertises STARTTLS when cert+key are configured', async () => {
		const { port } = await start(tlsConfig());
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('EHLO probe.test\r\n');
		await c.waitFor((b) => /STARTTLS/.test(b));
		c.end();
	});

	it('STARTTLS then plaintext garbage: the handshake errors and the socket dies', async () => {
		const { port } = await start(tlsConfig());
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('EHLO probe.test\r\n');
		await c.waitFor((b) => /STARTTLS/.test(b));
		c.write('STARTTLS\r\n');
		await c.waitCode(220);
		// Not a ClientHello — the TLS upgrade errors and the socket is destroyed.
		c.write('this is not a tls client hello\r\n');
		await c.waitClose();
		expect(c.closed).toBe(true);
	});

	it('STARTTLS then total silence: the command idle timer tears it down with 421 4.4.2', async () => {
		const { port } = await start({ ...tlsConfig(), bounceSocketTimeoutMs: 500 });
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('EHLO probe.test\r\n');
		await c.waitFor((b) => /STARTTLS/.test(b));
		c.write('STARTTLS\r\n');
		await c.waitCode(220);
		// Read the 220 Ready but send no ClientHello: the idle timer fires 421 4.4.2.
		await c.waitFor((b) => /421 4\.4\.2/.test(b), 3000);
		await c.waitClose();
		expect(c.closed).toBe(true);
	});
});
