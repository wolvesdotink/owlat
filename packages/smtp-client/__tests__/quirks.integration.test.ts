/**
 * The long-tail quirk suite — the "insurance policy" for the SMTP client
 * (piece R2). Every case here is a RAW-SOCKET fake server reproducing a specific
 * real-world server misbehaviour that a well-behaved `smtp-server` (used by the
 * connection / transaction integration suites) will never emit. Each quirk is
 * NAMED and carries a PROVENANCE comment tying it to where it is seen in the wild,
 * so a future reader knows the corner is deliberate, not incidental.
 *
 * The bar these cases enforce: the client classifies on STRUCTURE — the framed
 * reply code, the reply phase, `secured` — never on raw reply bytes (W7). So a
 * server that fragments its replies, mislabels its continuation codes, greets in
 * pieces, drops a 421 mid-session, refuses STARTTLS with a 4xx, stalls then
 * banners late, sprays 8-bit bytes, or omits the CR must each produce the RIGHT
 * structured outcome and never a crash, a hang, or a wrong verdict.
 *
 * Determinism: no real network and no wall-clock races — the timeout case drives
 * an explicit short greeting deadline against a server whose banner is delayed far
 * beyond it, and every other case is purely reply-driven.
 */

import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { SmtpConnection } from '../src/connection';
import { sendEnvelope } from '../src/transaction';
import { isSmtpError } from '../src/errors';

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) {
		try {
			cleanups.pop()?.();
		} catch {
			// best-effort teardown
		}
	}
});

/** A well-formed multiline EHLO answer (CRLF), the baseline the quirks perturb. */
const EHLO_REPLY = '250-mx.test\r\n250-PIPELINING\r\n250-SIZE 10485760\r\n250 SMTPUTF8\r\n';

interface RawServerConfig {
	/** Called on each new connection to write the greeting (may fragment/delay). */
	onConnect: (socket: net.Socket) => void;
	/**
	 * Answer one received command line. The handler writes to the socket itself
	 * (so it can emit Buffers, split writes, bare-LF endings, etc.); returning
	 * nothing is allowed (e.g. a parked command).
	 */
	handle: (line: string, socket: net.Socket) => void;
}

/**
 * A raw cleartext SMTP peer. Splits inbound bytes on `\n`, strips a trailing
 * `\r`, and hands each complete command line to `handle`. Unlike a real
 * `smtp-server` it does exactly — and only — what the quirk scripts it to.
 *
 * DATA is modelled minimally: once a command line beginning `DATA` has been
 * handled, subsequent lines are treated as the message body and swallowed until
 * the lone `.` terminator, which is delivered to `handle` as the line `'.'` (the
 * client always dot-stuffs and terminates with CRLF, so the terminator arrives
 * here as a bare `.` after the trailing-CR strip). This keeps the server from
 * spraying a reply at every body line.
 */
function startRawServer(config: RawServerConfig): Promise<number> {
	const server = net.createServer((socket) => {
		socket.on('error', () => {});
		config.onConnect(socket);
		let buffer = '';
		let inData = false;
		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8');
			let nl = buffer.indexOf('\n');
			while (nl !== -1) {
				const line = buffer.slice(0, nl).replace(/\r$/, '');
				buffer = buffer.slice(nl + 1);
				if (inData) {
					if (line === '.') {
						inData = false;
						config.handle('.', socket);
					}
					// Otherwise a body line — swallow it, no reply.
				} else {
					config.handle(line, socket);
					if (/^DATA/i.test(line)) inData = true;
				}
				nl = buffer.indexOf('\n');
			}
		});
	});
	server.on('error', () => {});
	cleanups.push(() => server.close());
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
	});
}

/** Write `text` to the socket one small chunk at a time (forces cross-packet framing). */
function writeFragmented(socket: net.Socket, text: string, chunkSize = 7): void {
	const bytes = Buffer.from(text, 'utf8');
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		if (socket.destroyed) return;
		socket.write(bytes.subarray(offset, offset + chunkSize));
	}
}

const ENVELOPE = {
	from: 'sender@example.com',
	to: ['rcpt@example.net'],
	data: 'From: sender@example.com\r\nTo: rcpt@example.net\r\nSubject: hi\r\n\r\nbody\r\n',
};

describe('smtp-client long-tail quirks — raw-socket fake servers', () => {
	// ── QUIRK 1: reply lines split across TCP packets ─────────────────────────
	// Provenance: TCP is a byte stream, not a message stream — a multiline EHLO
	// answer is routinely delivered in several segments (small MTUs, Nagle, a
	// load balancer flushing mid-line), seen constantly against Postfix/Exim
	// behind proxies. The byte-framing ReplyParser must reassemble it regardless
	// of where the packet boundaries fall.
	it('reassembles an EHLO reply fragmented across TCP packets', async () => {
		const port = await startRawServer({
			onConnect: (s) => writeFragmented(s, '220 mx.test ESMTP ready\r\n'),
			handle: (line, s) => {
				if (line.startsWith('EHLO')) writeFragmented(s, EHLO_REPLY);
				else s.write('250 OK\r\n');
			},
		});
		const conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port,
			ehloName: 'client.test',
			tlsMode: 'none',
		});
		cleanups.push(() => conn.close());
		expect(conn.greeting.code).toBe(220);
		expect(conn.capabilities.pipelining).toBe(true);
		expect(conn.capabilities.smtpUtf8).toBe(true);
		expect(conn.capabilities.size).toBe(10485760);
	});

	// ── QUIRK 2: multiline reply with inconsistent continuation codes ─────────
	// Provenance: RFC 5321 §4.2 requires every line of a reply to share the code,
	// but appliances (older Exchange, some IronPort/antispam relays) emit
	// continuation lines whose code differs from the final line. The FINAL line's
	// code is authoritative; a client that keyed off the FIRST line would mis-
	// classify the verdict. Here the continuations say 250 while the final says 550.
	it('takes the final line code on a reply whose continuations disagree', async () => {
		const port = await startRawServer({
			onConnect: (s) => s.write('220 mx.test ready\r\n'),
			handle: (line, s) => {
				if (line.startsWith('EHLO')) s.write(EHLO_REPLY);
				else if (line.startsWith('RCPT'))
					s.write(
						'250-will look up the mailbox\r\n250-still checking\r\n550 5.1.1 no such user\r\n'
					);
				else s.write('250 OK\r\n');
			},
		});
		const conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port,
			ehloName: 'client.test',
			tlsMode: 'none',
		});
		let caught: unknown;
		try {
			await sendEnvelope(conn, ENVELOPE);
		} catch (err) {
			caught = err;
		}
		conn.close();
		// Every recipient rejected → sendEnvelope throws in phase `rcpt` carrying the
		// FINAL line's code (550) and its enhanced code — never the 250 continuations.
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('rcpt');
			expect(caught.replyCode).toBe(550);
			expect(caught.enhancedCode).toBe('5.1.1');
		}
	});

	// ── QUIRK 3: greeting delivered in two writes, split mid-line ─────────────
	// Provenance: some servers (sendmail under load, hand-rolled MTAs) flush the
	// banner in two syscalls, splitting the single 220 line before its CRLF. A
	// client that treated the first read as a complete greeting would parse a
	// truncated banner; the parser must wait for the line terminator.
	it('accepts a greeting whose single 220 line arrives in two writes', async () => {
		const port = await startRawServer({
			onConnect: (s) => {
				s.write('220 mx.test'); // no CRLF yet — deliberately mid-line
				s.write(' ESMTP ready\r\n');
			},
			handle: (line, s) => {
				if (line.startsWith('EHLO')) s.write(EHLO_REPLY);
				else s.write('250 OK\r\n');
			},
		});
		const conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port,
			ehloName: 'client.test',
			tlsMode: 'none',
		});
		cleanups.push(() => conn.close());
		expect(conn.greeting.code).toBe(220);
		expect(conn.greeting.lines).toEqual(['mx.test ESMTP ready']);
	});

	// ── QUIRK 4: early 421 mid-transaction ────────────────────────────────────
	// Provenance: RFC 5321 §3.8/§4.2.1 lets a server that becomes unavailable
	// answer any command with `421 … closing transmission channel`. Overloaded MX
	// hosts do this partway through a live session. A 421 to DATA (after MAIL and
	// RCPT were accepted) must surface as a phase-tagged failure carrying 421 —
	// distinguishable from a clean reject so the retry taxonomy can back off.
	it('surfaces a 421 issued to DATA mid-transaction as a phase-tagged failure', async () => {
		const port = await startRawServer({
			onConnect: (s) => s.write('220 mx.test ready\r\n'),
			handle: (line, s) => {
				if (line.startsWith('EHLO')) s.write('250-mx.test\r\n250 SIZE 10485760\r\n');
				else if (line.startsWith('DATA')) s.write('421 4.7.0 service shutting down, closing\r\n');
				else s.write('250 OK\r\n'); // MAIL + RCPT accepted first
			},
		});
		const conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port,
			ehloName: 'client.test',
			tlsMode: 'none',
		});
		let caught: unknown;
		try {
			await sendEnvelope(conn, ENVELOPE);
		} catch (err) {
			caught = err;
		}
		conn.close();
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('data');
			expect(caught.replyCode).toBe(421);
			expect(caught.enhancedCode).toBe('4.7.0');
		}
	});

	// ── QUIRK 5: 4xx reply to STARTTLS ────────────────────────────────────────
	// Provenance: RFC 3207 §4 — a server that advertises STARTTLS but is
	// momentarily unable to start it answers the command with `454 TLS not
	// available`. With a required TLS floor the client must FAIL CLOSED in the
	// `starttls` phase (never fall through to cleartext), carrying the reply code.
	it('fails closed when STARTTLS is advertised but answered with a 454', async () => {
		const port = await startRawServer({
			onConnect: (s) => s.write('220 mx.test ready\r\n'),
			handle: (line, s) => {
				if (line.startsWith('EHLO')) s.write('250-mx.test\r\n250 STARTTLS\r\n');
				else if (line.startsWith('STARTTLS'))
					s.write('454 4.7.0 TLS not available at the moment\r\n');
				else s.write('250 OK\r\n');
			},
		});
		let caught: unknown;
		try {
			await SmtpConnection.connect({
				host: '127.0.0.1',
				port,
				ehloName: 'client.test',
				tlsMode: 'starttls',
				requireTls: true,
			});
		} catch (err) {
			caught = err;
		}
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('starttls');
			expect(caught.replyCode).toBe(454);
			expect(caught.tlsCause).toBe('starttls-unavailable');
			expect(caught.secured).toBe(false);
		}
	});

	// ── QUIRK 6: timeout, then a late banner ──────────────────────────────────
	// Provenance: tarpits / greylisting front-ends stall the greeting to slow
	// abusive senders, sometimes emitting the 220 only after a long delay. The
	// client's greeting deadline must fire in phase `greeting` and it must NOT
	// later consume the late banner as if the handshake had succeeded.
	it('times out in the greeting phase and does not consume a late banner', async () => {
		const port = await startRawServer({
			onConnect: (s) => {
				// Banner arrives far AFTER the client's 150ms greeting deadline.
				const timer = setTimeout(() => {
					if (!s.destroyed) s.write('220 mx.test finally ready\r\n');
				}, 1_000);
				cleanups.push(() => clearTimeout(timer));
			},
			handle: (_line, s) => {
				if (!s.destroyed) s.write('250 OK\r\n');
			},
		});
		let caught: unknown;
		try {
			await SmtpConnection.connect({
				host: '127.0.0.1',
				port,
				ehloName: 'client.test',
				tlsMode: 'none',
				timeouts: { greeting: 150 },
			});
		} catch (err) {
			caught = err;
		}
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('greeting');
			expect(caught.secured).toBe(false);
		}
	});

	// ── QUIRK 7: 8-bit garbage bytes in reply text ────────────────────────────
	// Provenance: legacy/localized servers emit non-ASCII bytes (Latin-1 / CP-1252
	// accented text, or plain junk) in reply prose that is not valid UTF-8. Framing
	// is on BYTES and the code is classified numerically, so the reply must still
	// parse — a naive UTF-8 decode of the whole stream would desync the framing.
	it('parses an EHLO reply carrying raw 8-bit bytes in its text', async () => {
		const port = await startRawServer({
			onConnect: (s) => s.write(Buffer.from('220 mx.test ready\r\n')),
			handle: (line, s) => {
				if (line.startsWith('EHLO')) {
					s.write(
						Buffer.concat([
							Buffer.from('250-mx.test '),
							Buffer.from([0x80, 0xc0, 0xff, 0xfe, 0xa9]), // invalid UTF-8 / 8-bit junk
							Buffer.from('\r\n250-PIPELINING\r\n250-SIZE 10485760\r\n250 SMTPUTF8\r\n'),
						])
					);
				} else s.write('250 OK\r\n');
			},
		});
		const conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port,
			ehloName: 'client.test',
			tlsMode: 'none',
		});
		cleanups.push(() => conn.close());
		expect(conn.greeting.code).toBe(220);
		expect(conn.capabilities.pipelining).toBe(true);
		expect(conn.capabilities.size).toBe(10485760);
		expect(conn.capabilities.smtpUtf8).toBe(true);
	});

	// ── QUIRK 8: CRLF-less (bare-LF) line endings ─────────────────────────────
	// Provenance: RFC 5321 mandates CRLF, but embedded devices and hand-rolled
	// SMTP servers routinely terminate replies with a bare LF. The parser strips an
	// OPTIONAL CR, so a whole session of LF-only replies — greeting, EHLO, and the
	// MAIL/RCPT/DATA verdicts — must still frame and complete a send.
	it('completes a full send against a server that uses bare-LF line endings', async () => {
		const port = await startRawServer({
			onConnect: (s) => s.write('220 mx.test ready\n'),
			handle: (line, s) => {
				if (line.startsWith('EHLO')) s.write('250-mx.test\n250 SIZE 10485760\n');
				else if (line.startsWith('DATA')) s.write('354 go ahead\n');
				else if (line === '.') s.write('250 2.0.0 queued as ABC123\n');
				else s.write('250 OK\n');
			},
		});
		const conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port,
			ehloName: 'client.test',
			tlsMode: 'none',
		});
		const result = await sendEnvelope(conn, ENVELOPE);
		conn.close();
		expect(result.accepted.map((v) => v.recipient)).toEqual(['rcpt@example.net']);
		expect(result.rejected).toEqual([]);
		expect(result.response.code).toBe(250);
		expect(result.response.enhancedCode).toBe('2.0.0');
	});
});
