/**
 * Integration tests for PIPELINING (RFC 2920) — the X2 capability.
 *
 * When EHLO advertises PIPELINING, {@link sendEnvelope} writes MAIL FROM + every
 * RCPT TO + DATA in ONE socket write and reads their replies back as a batch; a
 * non-advertising server keeps the v1 sequential command/reply path. The whole
 * point is that pipelining changes only TIMING — the per-recipient verdicts and
 * the phase-tagged {@link SmtpError} taxonomy are indistinguishable from the
 * sequential path.
 *
 * These drive the client against raw `net` peers whose reply framing we control
 * exactly, because the divergences that matter here are framing divergences the
 * high-level `smtp-server` hides:
 *   (a) batched replies matched to commands, incl. a mixed accept/reject RCPT set
 *       and a rejected MAIL FROM that aborts the batch;
 *   (b) quirk framing — a server that advertises PIPELINING but writes one packet
 *       per reply line, and one that splits its reply bytes mid-batch/mid-line;
 *   (c) the classification parity gate: reject-at-MAIL (phase `mail`), an
 *       all-rejected RCPT set (phase `rcpt`), a mid-DATA drop (phase `data-final`)
 *       and a partial-accept verdict set are byte-for-byte identical with
 *       pipelining forced ON and OFF.
 */
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { SmtpConnection } from '../src/connection';
import { sendEnvelope, type PipeliningMode } from '../src/transaction';
import { isSmtpError } from '../src/errors';

const MESSAGE = [
	'From: sender@example.com',
	'To: rcpt@example.net',
	'Subject: pipelined',
	'',
	'.leading dot line must survive dot-stuffing',
	'ordinary line',
].join('\r\n');

/** How a peer frames the reply bytes it owes for a group of commands. */
type Framing = 'batched' | 'per-line' | 'split';

interface PipeServerOptions {
	/** The EHLO response — advertise PIPELINING here to enable the client path. */
	ehloReply: string;
	/** MAIL FROM reply (default `250`). A 5xx exercises the reject-at-MAIL abort. */
	mailReply?: string;
	/** Per-recipient RCPT reply, keyed by the mailbox (default `250`). */
	rcptReply?: (mailbox: string) => string;
	/** DATA handshake reply (default `354`). */
	dataReply?: string;
	/** Final reply after the body (default `250`). */
	finalReply?: string;
	/** Destroy the socket on the first body byte — the mid-DATA drop. */
	dropOnData?: boolean;
	/** How replies are written back onto the wire. */
	framing?: Framing;
}

interface RunningPeer {
	port: number;
	/** Every raw chunk the peer received — used to prove the client batched writes. */
	chunks: Buffer[];
}

const closers: Array<() => void> = [];

function writeReplies(socket: net.Socket, replies: readonly string[], framing: Framing): void {
	if (framing === 'per-line') {
		for (const reply of replies) {
			socket.write(reply);
		}
		return;
	}
	const bytes = Buffer.from(replies.join(''), 'utf8');
	if (framing === 'batched') {
		socket.write(bytes);
		return;
	}
	// 'split' — dribble the batch out in 3-byte slices on separate ticks, forcing
	// the client's reply reader to reassemble replies across chunk boundaries
	// (mid-line and mid-batch). The parser must buffer partial lines to survive it.
	let offset = 0;
	const step = (): void => {
		if (socket.destroyed || offset >= bytes.length) {
			return;
		}
		const end = Math.min(offset + 3, bytes.length);
		socket.write(bytes.subarray(offset, end));
		offset = end;
		setImmediate(step);
	};
	step();
}

/**
 * A raw cleartext SMTP peer with fully controllable reply framing. It answers the
 * envelope commands (MAIL/RCPT×N/DATA) from a scripted table and records every
 * incoming chunk so a test can prove whether the client pipelined (one chunk
 * carrying MAIL + RCPT + DATA) or ran sequentially (never).
 */
function startPipeServer(options: PipeServerOptions): Promise<RunningPeer> {
	const chunks: Buffer[] = [];
	const framing = options.framing ?? 'batched';
	const server = net.createServer((socket) => {
		socket.on('error', () => {});
		socket.write('220 pipe ready\r\n');
		let buffer = '';
		let inData = false;
		socket.on('data', (chunk: Buffer) => {
			chunks.push(Buffer.from(chunk));
			buffer += chunk.toString('utf8');
			if (inData) {
				if (options.dropOnData) {
					socket.destroy();
					return;
				}
				if (buffer.includes('\r\n.\r\n')) {
					inData = false;
					buffer = '';
					writeReplies(socket, [options.finalReply ?? '250 2.0.0 queued\r\n'], framing);
				}
				return;
			}
			const replies: string[] = [];
			let nl = buffer.indexOf('\n');
			while (nl !== -1) {
				const line = buffer.slice(0, nl).replace(/\r$/, '');
				buffer = buffer.slice(nl + 1);
				if (/^EHLO/i.test(line)) {
					replies.push(options.ehloReply);
				} else if (/^MAIL FROM/i.test(line)) {
					replies.push(options.mailReply ?? '250 2.1.0 sender ok\r\n');
				} else if (/^RCPT TO/i.test(line)) {
					const mailbox = /<([^>]*)>/.exec(line)?.[1] ?? '';
					replies.push(options.rcptReply ? options.rcptReply(mailbox) : '250 2.1.5 rcpt ok\r\n');
				} else if (/^DATA/i.test(line)) {
					replies.push(options.dataReply ?? '354 end with <CRLF>.<CRLF>\r\n');
					inData = true;
					break;
				} else if (/^QUIT/i.test(line)) {
					replies.push('221 2.0.0 bye\r\n');
				} else {
					replies.push('250 2.0.0 ok\r\n');
				}
				nl = buffer.indexOf('\n');
			}
			if (replies.length > 0) {
				writeReplies(socket, replies, framing);
			}
		});
	});
	server.on('error', () => {});
	closers.push(() => server.close());
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () =>
			resolve({ port: (server.address() as AddressInfo).port, chunks })
		);
	});
}

function connectPlain(port: number): Promise<SmtpConnection> {
	return SmtpConnection.connect({
		host: '127.0.0.1',
		port,
		ehloName: 'client.test',
		tlsMode: 'none',
	});
}

/** `true` iff a single received chunk carried MAIL, RCPT and DATA together. */
function chunkCarriedWholeEnvelope(chunks: readonly Buffer[]): boolean {
	return chunks.some((chunk) => {
		const text = chunk.toString('utf8');
		return /MAIL FROM/i.test(text) && /RCPT TO/i.test(text) && /DATA/i.test(text);
	});
}

const PIPELINING_EHLO = '250-pipe greets you\r\n250-PIPELINING\r\n250 SIZE 10485760\r\n';
const NO_PIPELINING_EHLO = '250-pipe greets you\r\n250 SIZE 10485760\r\n';

afterEach(() => {
	while (closers.length > 0) {
		try {
			closers.pop()?.();
		} catch {
			// best-effort teardown
		}
	}
});

// ── (a) batched replies matched to commands ──────────────────────────────────
describe('PIPELINING — batched replies matched to commands', () => {
	it('pipelines the envelope and matches a mixed accept/reject RCPT set to its commands', async () => {
		const peer = await startPipeServer({
			ehloReply: PIPELINING_EHLO,
			framing: 'batched',
			rcptReply: (mailbox) =>
				mailbox === 'reject@example.net' ? '550 5.1.1 no such user\r\n' : '250 2.1.5 rcpt ok\r\n',
		});

		const conn = await connectPlain(peer.port);
		expect(conn.capabilities.pipelining).toBe(true);
		const result = await sendEnvelope(conn, {
			from: 'sender@example.com',
			to: ['ok1@example.net', 'reject@example.net', 'ok2@example.net'],
			data: MESSAGE,
		});
		conn.close();

		// The verdicts are matched to the RIGHT commands even though all three RCPT
		// replies arrived in one batched packet.
		expect(result.accepted.map((v) => v.recipient)).toEqual(['ok1@example.net', 'ok2@example.net']);
		expect(result.rejected).toHaveLength(1);
		expect(result.rejected[0]?.recipient).toBe('reject@example.net');
		expect(result.rejected[0]?.replyCode).toBe(550);
		expect(result.rejected[0]?.enhancedCode).toBe('5.1.1');
		expect(result.response.code).toBe(250);
		// Load-bearing: prove the client actually pipelined — one chunk carried the
		// whole envelope. If auto-gating regressed to sequential this would be false.
		expect(chunkCarriedWholeEnvelope(peer.chunks)).toBe(true);
	});

	it('aborts the batch in phase `mail` when MAIL FROM is rejected, draining the trailing replies', async () => {
		const peer = await startPipeServer({
			ehloReply: PIPELINING_EHLO,
			framing: 'batched',
			mailReply: '550 5.7.1 sender rejected\r\n',
			// After a rejected MAIL a compliant server answers the pipelined RCPT/DATA
			// with 503 bad-sequence; the client must drain these, not desync on them.
			rcptReply: () => '503 5.5.1 bad sequence of commands\r\n',
			dataReply: '503 5.5.1 bad sequence of commands\r\n',
		});

		const conn = await connectPlain(peer.port);
		let caught: unknown;
		try {
			await sendEnvelope(conn, {
				from: 'sender@example.com',
				to: ['rcpt@example.net'],
				data: MESSAGE,
			});
		} catch (err) {
			caught = err;
		}
		conn.close();

		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('mail');
			expect(caught.replyCode).toBe(550);
		}
		expect(chunkCarriedWholeEnvelope(peer.chunks)).toBe(true);
	});

	it('stays strictly sequential in auto mode when the server does not advertise PIPELINING', async () => {
		// Strict capability gating: an identical send against a peer whose EHLO omits
		// PIPELINING must take the v1 sequential path — no chunk carries the whole
		// envelope — yet produce the same successful result.
		const peer = await startPipeServer({ ehloReply: NO_PIPELINING_EHLO, framing: 'batched' });
		const conn = await connectPlain(peer.port);
		expect(conn.capabilities.pipelining).toBe(false);
		const result = await sendEnvelope(conn, {
			from: 'sender@example.com',
			to: ['a@example.net', 'b@example.net'],
			data: MESSAGE,
		});
		conn.close();

		expect(result.accepted.map((v) => v.recipient)).toEqual(['a@example.net', 'b@example.net']);
		expect(result.response.code).toBe(250);
		expect(chunkCarriedWholeEnvelope(peer.chunks)).toBe(false);
	});
});

// ── (b) quirk framing ────────────────────────────────────────────────────────
describe('PIPELINING — reply framing quirks', () => {
	it('handles a server that advertises PIPELINING but writes one packet per reply line', async () => {
		const peer = await startPipeServer({ ehloReply: PIPELINING_EHLO, framing: 'per-line' });
		const conn = await connectPlain(peer.port);
		const result = await sendEnvelope(conn, {
			from: 'sender@example.com',
			to: ['a@example.net', 'b@example.net'],
			data: MESSAGE,
		});
		conn.close();

		expect(result.accepted.map((v) => v.recipient)).toEqual(['a@example.net', 'b@example.net']);
		expect(result.rejected).toEqual([]);
		expect(result.response.code).toBe(250);
		expect(chunkCarriedWholeEnvelope(peer.chunks)).toBe(true);
	});

	it('reassembles replies that the server splits mid-batch and mid-line', async () => {
		const peer = await startPipeServer({
			ehloReply: PIPELINING_EHLO,
			framing: 'split',
			rcptReply: (mailbox) =>
				mailbox === 'no@example.net' ? '551 5.1.1 relay denied\r\n' : '250 2.1.5 rcpt ok\r\n',
		});
		const conn = await connectPlain(peer.port);
		const result = await sendEnvelope(conn, {
			from: 'sender@example.com',
			to: ['yes@example.net', 'no@example.net'],
			data: MESSAGE,
		});
		conn.close();

		// Every reply landed on the right command despite arriving in 3-byte slices.
		expect(result.accepted.map((v) => v.recipient)).toEqual(['yes@example.net']);
		expect(result.rejected.map((v) => v.recipient)).toEqual(['no@example.net']);
		expect(result.rejected[0]?.replyCode).toBe(551);
		expect(result.response.code).toBe(250);
	});
});

// ── (c) classification parity: forced ON vs OFF are identical ─────────────────
describe('PIPELINING — classification is identical forced on and off', () => {
	// Both modes drive the SAME peer script; a PIPELINING-advertising EHLO lets the
	// forced-off run stay legal while the forced-on run actually batches.
	async function run(
		mode: PipeliningMode,
		server: PipeServerOptions,
		to: readonly string[]
	): Promise<{ result?: unknown; error?: unknown; batched: boolean }> {
		const peer = await startPipeServer(server);
		const conn = await connectPlain(peer.port);
		try {
			const result = await sendEnvelope(conn, {
				from: 'sender@example.com',
				to,
				data: MESSAGE,
				pipelining: mode,
			});
			return { result, batched: chunkCarriedWholeEnvelope(peer.chunks) };
		} catch (error) {
			return { error, batched: chunkCarriedWholeEnvelope(peer.chunks) };
		} finally {
			conn.close();
		}
	}

	it('reject-at-MAIL surfaces phase `mail` with the same reply code either way', async () => {
		const server: PipeServerOptions = {
			ehloReply: PIPELINING_EHLO,
			mailReply: '550 5.7.1 sender rejected\r\n',
			rcptReply: () => '503 5.5.1 bad sequence of commands\r\n',
			dataReply: '503 5.5.1 bad sequence of commands\r\n',
		};
		const on = await run('always', server, ['rcpt@example.net']);
		const off = await run('never', server, ['rcpt@example.net']);

		expect(on.batched).toBe(true);
		expect(off.batched).toBe(false);
		for (const outcome of [on, off]) {
			expect(isSmtpError(outcome.error)).toBe(true);
			if (isSmtpError(outcome.error)) {
				expect(outcome.error.phase).toBe('mail');
				expect(outcome.error.replyCode).toBe(550);
			}
		}
	});

	it('all-recipients-rejected surfaces phase `rcpt` with the last reply code either way', async () => {
		const server: PipeServerOptions = {
			ehloReply: PIPELINING_EHLO,
			rcptReply: () => '550 5.1.1 no such user\r\n',
			// After every RCPT is refused a server answers DATA with a 554; the pipelined
			// path reads it before reporting, the sequential path never sends DATA.
			dataReply: '554 5.5.1 no valid recipients\r\n',
		};
		const on = await run('always', server, ['a@example.net', 'b@example.net']);
		const off = await run('never', server, ['a@example.net', 'b@example.net']);

		for (const outcome of [on, off]) {
			expect(isSmtpError(outcome.error)).toBe(true);
			if (isSmtpError(outcome.error)) {
				expect(outcome.error.phase).toBe('rcpt');
				expect(outcome.error.replyCode).toBe(550);
			}
		}
	});

	it('a mid-DATA socket drop surfaces phase `data-final` either way', async () => {
		const server: PipeServerOptions = { ehloReply: PIPELINING_EHLO, dropOnData: true };
		const on = await run('always', server, ['rcpt@example.net']);
		const off = await run('never', server, ['rcpt@example.net']);

		for (const outcome of [on, off]) {
			expect(isSmtpError(outcome.error)).toBe(true);
			if (isSmtpError(outcome.error)) {
				expect(['data', 'data-final']).toContain(outcome.error.phase);
			}
		}
	});

	it('a partial-accept verdict set is byte-for-byte identical either way', async () => {
		const server: PipeServerOptions = {
			ehloReply: PIPELINING_EHLO,
			rcptReply: (mailbox) =>
				mailbox === 'mid@example.net' ? '550 5.1.1 no such user\r\n' : '250 2.1.5 rcpt ok\r\n',
		};
		const to = ['first@example.net', 'mid@example.net', 'last@example.net'];
		const on = await run('always', server, to);
		const off = await run('never', server, to);

		expect(on.batched).toBe(true);
		expect(off.batched).toBe(false);
		// Serialise the SendResult verdicts and compare — no field may differ.
		const shape = (r: unknown): unknown => {
			const res = r as { accepted: unknown[]; rejected: unknown[]; response: { code: number } };
			return {
				accepted: res.accepted,
				rejected: res.rejected,
				responseCode: res.response.code,
			};
		};
		expect(shape(on.result)).toEqual(shape(off.result));
	});
});
