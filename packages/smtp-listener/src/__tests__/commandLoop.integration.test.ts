import { describe, it, expect, afterEach } from 'vitest';
import type { SmtpListener } from '../server.js';
import type { SmtpListenerOptions } from '../types.js';
import { SmtpReplyError } from '../reply.js';
import { Client, startListener, closeAllListeners } from './tlsTestUtil.js';

// ---------------------------------------------------------------------------
// Test harness: start a real listener on an ephemeral port and drive it over a
// raw TCP socket via the shared {@link Client}. No smtp-server, no mock — this
// exercises the actual command loop, byte budget, dot decode and timeouts
// end-to-end.
// ---------------------------------------------------------------------------

interface Harness {
	listener: SmtpListener;
	port: number;
	messages: Buffer[];
}

async function start(overrides: Partial<SmtpListenerOptions> = {}): Promise<Harness> {
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

afterEach(closeAllListeners);

describe('command loop over a raw socket', () => {
	it('completes a full MAIL/RCPT/DATA/QUIT transaction', async () => {
		const h = await start();
		const c = await Client.connect(h.port);
		await c.waitCode(220);
		c.write('EHLO client.test\r\n');
		await c.waitCode(250);
		expect(c.received).toContain('250-mx.test greets client.test');
		expect(c.received).toContain('SIZE ');

		c.write('MAIL FROM:<sender@a.test> SIZE=42\r\n');
		await c.waitFor((b) => /250 2\.1\.0/.test(b));
		c.write('RCPT TO:<rcpt@b.test>\r\n');
		await c.waitFor((b) => /250 2\.1\.5/.test(b));
		c.write('DATA\r\n');
		await c.waitCode(354);
		c.write('Subject: hi\r\n\r\nHello world\r\n.\r\n');
		await c.waitFor((b) => /250 2\.0\.0/.test(b));
		c.write('QUIT\r\n');
		await c.waitCode(221);
		await c.waitClose();

		expect(h.messages).toHaveLength(1);
		expect(h.messages[0]?.toString()).toBe('Subject: hi\r\n\r\nHello world\r\n');
		c.end();
	});

	it('un-stuffs leading dots in the DATA body', async () => {
		const h = await start();
		const c = await Client.connect(h.port);
		await c.waitCode(220);
		c.write('MAIL FROM:<a@a.test>\r\nRCPT TO:<b@b.test>\r\nDATA\r\n');
		await c.waitCode(354);
		// Wire "..dotted" must decode to ".dotted".
		c.write('line one\r\n..dotted\r\n.\r\n');
		await c.waitCode(250);
		expect(h.messages[0]?.toString()).toBe('line one\r\n.dotted\r\n');
		c.end();
	});

	it('accepts a pipelined batch of commands in one segment', async () => {
		const h = await start();
		const c = await Client.connect(h.port);
		await c.waitCode(220);
		// All commands in a single write — the loop must answer each in order.
		c.write(
			'EHLO batch.test\r\nMAIL FROM:<a@a.test>\r\nRCPT TO:<b@b.test>\r\nRCPT TO:<c@c.test>\r\nNOOP\r\n'
		);
		await c.waitFor((b) => (b.match(/(^|\n)250 /gm) ?? []).length >= 4, 3000);
		const finals = c.received.match(/(^|\n)250 /gm) ?? [];
		// EHLO(1) + MAIL(1) + 2×RCPT + NOOP = 5 final 250 lines.
		expect(finals.length).toBeGreaterThanOrEqual(5);
		c.end();
	});

	it('RSET mid-transaction clears the envelope', async () => {
		const h = await start();
		const c = await Client.connect(h.port);
		await c.waitCode(220);
		c.write('MAIL FROM:<a@a.test>\r\n');
		await c.waitFor((b) => /250 2\.1\.0/.test(b));
		c.write('RCPT TO:<b@b.test>\r\n');
		await c.waitFor((b) => /250 2\.1\.5/.test(b));
		c.write('RSET\r\n');
		await c.waitFor((b) => /250 2\.0\.0/.test(b));
		// After RSET, DATA must be refused (no MAIL/RCPT).
		c.write('DATA\r\n');
		await c.waitCode(503);
		// And a fresh MAIL FROM must work again.
		c.write('MAIL FROM:<fresh@a.test>\r\n');
		await c.waitFor((b) => (b.match(/250 2\.1\.0/g) ?? []).length >= 2);
		c.end();
	});

	it('bounds a command flood with 421 and closes the connection', async () => {
		const h = await start({ maxBadCommands: 5 });
		const c = await Client.connect(h.port);
		await c.waitCode(220);
		let flood = '';
		for (let i = 0; i < 50; i++) flood += 'ZZUNKNOWN\r\n';
		c.write(flood);
		await c.waitCode(421);
		await c.waitClose();
		expect(c.closed).toBe(true);
	});

	it('drops a peer that overruns the command-line byte cap', async () => {
		const h = await start({ maxCommandBytes: 64 });
		const c = await Client.connect(h.port);
		await c.waitCode(220);
		c.write('EHLO ' + 'x'.repeat(500)); // no CRLF, exceeds cap
		await c.waitCode(500);
		await c.waitClose();
		expect(c.closed).toBe(true);
		c.end();
	});

	it('rejects an oversized message with 552 but keeps the session usable', async () => {
		const h = await start({ maxMessageBytes: 64, abortFactor: 1000 });
		const c = await Client.connect(h.port);
		await c.waitCode(220);
		c.write('MAIL FROM:<a@a.test>\r\nRCPT TO:<b@b.test>\r\nDATA\r\n');
		await c.waitCode(354);
		c.write('x'.repeat(500) + '\r\n.\r\n');
		await c.waitCode(552);
		expect(h.messages).toHaveLength(0);
		// Session survives; a NOOP still answers.
		c.write('NOOP\r\n');
		await c.waitFor((b) => /250 2\.0\.0/.test(b));
		c.end();
	});

	it('closes an idle connection with 421 once the command timeout fires', async () => {
		const h = await start({ timeouts: { commandMs: 150, dataMs: 150 } });
		const c = await Client.connect(h.port);
		await c.waitCode(220);
		// Send nothing; the idle timer must fire and tear the connection down.
		await c.waitCode(421, 3000);
		await c.waitClose();
		expect(c.closed).toBe(true);
	});

	it('assembles a DATA body delivered across multiple TCP segments', async () => {
		// Each segment arrives as its own chunk with NO terminator, forcing the
		// reader's no-terminator flush/keep path (partial-terminator carry) before
		// the final `.<CRLF>` completes the body.
		const h = await start();
		const c = await Client.connect(h.port);
		await c.waitCode(220);
		c.write('MAIL FROM:<a@a.test>\r\nRCPT TO:<b@b.test>\r\nDATA\r\n');
		await c.waitCode(354);
		c.write('first line of the body\r\n');
		await new Promise((r) => setTimeout(r, 50));
		c.write('second line of the body\r\n');
		await new Promise((r) => setTimeout(r, 50));
		c.write('.\r\n');
		await c.waitCode(250);
		expect(h.messages[0]?.toString()).toBe('first line of the body\r\nsecond line of the body\r\n');
		c.end();
	});

	it('returns cleanly when the peer hangs up mid-DATA (no delivery)', async () => {
		// EOF before the `<CRLF>.<CRLF>` terminator: the DATA reader must report
		// `closed`, the loop must exit, and nothing is delivered.
		const h = await start();
		const c = await Client.connect(h.port);
		await c.waitCode(220);
		c.write('MAIL FROM:<a@a.test>\r\nRCPT TO:<b@b.test>\r\nDATA\r\n');
		await c.waitCode(354);
		c.write('partial body with no terminator\r\n');
		await new Promise((r) => setTimeout(r, 50));
		c.socket.end(); // FIN mid-DATA
		await c.waitClose();
		expect(c.closed).toBe(true);
		expect(h.messages).toHaveLength(0);
	});

	it('accepts a MAIL parameter supplied as a bare flag (no value)', async () => {
		// A tail token with no `=` exercises the value-less parameter branch of the
		// address-command parser (`params[TOKEN] = ''`).
		const h = await start();
		const c = await Client.connect(h.port);
		await c.waitCode(220);
		c.write('MAIL FROM:<a@a.test> BODY\r\n');
		await c.waitFor((b) => /250 2\.1\.0/.test(b));
		c.write('RCPT TO:<b@b.test>\r\n');
		await c.waitFor((b) => /250 2\.1\.5/.test(b));
		c.end();
	});

	it('refuses DATA before MAIL/RCPT and STARTTLS/AUTH are not implemented yet', async () => {
		const h = await start();
		const c = await Client.connect(h.port);
		await c.waitCode(220);
		c.write('DATA\r\n');
		await c.waitCode(503);
		c.write('AUTH LOGIN\r\n');
		await c.waitCode(502);
		c.write('STARTTLS\r\n');
		await c.waitFor((b) => (b.match(/(^|\n)502 /gm) ?? []).length >= 2);
		c.end();
	});

	it('answers VRFY, EXPN and HELP without confirming addresses', async () => {
		const h = await start();
		const c = await Client.connect(h.port);
		await c.waitCode(220);
		c.write('VRFY someone@x.test\r\n');
		await c.waitCode(252);
		c.write('EXPN a-list\r\n');
		await c.waitFor((b) => (b.match(/(^|\n)252 /gm) ?? []).length >= 2);
		c.write('HELP\r\n');
		await c.waitCode(214);
		c.end();
	});

	it('rejects a duplicate MAIL FROM with 503', async () => {
		const h = await start();
		const c = await Client.connect(h.port);
		await c.waitCode(220);
		c.write('MAIL FROM:<a@a.test>\r\n');
		await c.waitFor((b) => /250 2\.1\.0/.test(b));
		c.write('MAIL FROM:<b@b.test>\r\n');
		await c.waitCode(503);
		expect(c.received).toMatch(/Sender already specified/);
		c.end();
	});
});

describe('handler rejection paths', () => {
	it('ends the connection when onConnect rejects', async () => {
		const { port } = await startListener({
			hostname: 'mx.test',
			onConnect: () => ({ code: 554, text: 'go away' }),
		});
		const c = await Client.connect(port);
		await c.waitCode(220);
		await c.waitCode(554);
		await c.waitClose();
		expect(c.closed).toBe(true);
		c.end();
	});

	it('rejects HELO via a handler reply and counts it against the budget', async () => {
		const { port } = await startListener({
			hostname: 'mx.test',
			onHelo: () => ({ code: 550, text: 'bad host' }),
		});
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('EHLO nope.test\r\n');
		await c.waitCode(550);
		c.end();
	});

	it('uses the reply a rejecting onMailFrom / onRcptTo returns', async () => {
		const { port } = await startListener({
			hostname: 'mx.test',
			onMailFrom: (addr) =>
				addr.address === 'blocked@x.test' ? { code: 550, text: 'no' } : undefined,
			onRcptTo: (addr) =>
				addr.address === 'blocked@y.test' ? { code: 551, text: 'no' } : undefined,
		});
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('MAIL FROM:<blocked@x.test>\r\n');
		await c.waitCode(550);
		c.write('MAIL FROM:<a@a.test>\r\n');
		await c.waitFor((b) => /250 2\.1\.0/.test(b));
		c.write('RCPT TO:<blocked@y.test>\r\n');
		await c.waitCode(551);
		c.end();
	});

	it('maps a thrown SmtpReplyError to its reply and a generic throw to 451', async () => {
		const { port } = await startListener({
			hostname: 'mx.test',
			onMailFrom: (addr) => {
				if (addr.address === 'reply@x.test') throw new SmtpReplyError({ code: 552, text: 'quota' });
				if (addr.address === 'boom@x.test') throw new Error('handler exploded');
				return undefined;
			},
		});
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('MAIL FROM:<reply@x.test>\r\n');
		await c.waitCode(552);
		c.write('MAIL FROM:<boom@x.test>\r\n');
		await c.waitCode(451);
		c.end();
	});

	it('writes the reply a rejecting onData returns and keeps the session usable', async () => {
		const { port } = await startListener({
			hostname: 'mx.test',
			onData: () => ({ code: 550, text: 'content rejected' }),
		});
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('MAIL FROM:<a@a.test>\r\nRCPT TO:<b@b.test>\r\nDATA\r\n');
		await c.waitCode(354);
		c.write('body\r\n.\r\n');
		await c.waitCode(550);
		// Session survives a rejected message.
		c.write('NOOP\r\n');
		await c.waitFor((b) => /250 2\.0\.0/.test(b));
		c.end();
	});

	it('destroys the socket when DATA overruns the abort ceiling', async () => {
		const { port } = await startListener({
			hostname: 'mx.test',
			maxMessageBytes: 64,
			abortFactor: 2, // destroy past 128 bytes
		});
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('MAIL FROM:<a@a.test>\r\nRCPT TO:<b@b.test>\r\nDATA\r\n');
		await c.waitCode(354);
		// 500 bytes with no terminator blows past the 128-byte abort ceiling.
		c.write('x'.repeat(500));
		await c.waitClose();
		expect(c.closed).toBe(true);
		c.end();
	});
});
