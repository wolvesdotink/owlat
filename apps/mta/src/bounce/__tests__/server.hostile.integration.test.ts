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
 * Connection-count limiting is out of scope here (I8: it lives in
 * inboundSecurity.ts); this suite pins the per-connection command-loop bounds.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'node:net';
import Redis from 'ioredis-mock';
import type { AddressInfo } from 'node:net';
import type { SmtpListener } from '@owlat/smtp-listener';
import { createBounceServer } from '../server.js';
import type { MtaConfig } from '../../config.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** The production-shaped MX config: real hostname/banner + the real byte budget. */
function makeConfig(): MtaConfig {
	return {
		ehloHostname: 'mx.owlat.test',
		bounceMaxClients: 200,
		bounceMaxConnectionsPerIp: 50,
		bounceTarpitEnabled: false,
		bounceTarpitDelayMs: 0,
		inboundSpfEnabled: false,
		inboundDkimEnabled: false,
		inboundDmarcEnabled: false,
		inboundArcEnabled: false,
	} as unknown as MtaConfig;
}

const listeners: SmtpListener[] = [];

async function start(): Promise<{ port: number; redis: InstanceType<typeof Redis> }> {
	const redis = new Redis();
	// Disable the dynamic inbound-TLS requirement so a clean plaintext transaction
	// can complete in the "still serves" probe (the gate itself is unit-tested).
	await redis.set('mta:inbound-tls-required', '0');
	const listener = createBounceServer(makeConfig(), redis as never);
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
});
