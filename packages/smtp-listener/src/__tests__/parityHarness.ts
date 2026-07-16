/**
 * Shared harness for the `smtp-server` parity differential (`parity.test.ts`).
 *
 * Provides:
 *  - {@link startOracle}: boot a real `smtp-server` (the parity ORACLE — I1: the
 *    four oracles stay forever as devDependencies; our code never verifies
 *    itself alone) on an ephemeral loopback port with caller-supplied handlers.
 *  - {@link converse}: run a scripted SMTP conversation over a raw TCP socket and
 *    return the ORDERED reply for every step, parsed into `{ code, enhanced?,
 *    line }`. The SAME runner drives both stacks, so a reply-sequence diff is a
 *    true behavioural diff, never a harness artefact.
 *
 * A raw socket (not `@owlat/smtp-client`) is used deliberately: parity scripts
 * must send exactly the bytes we choose — including the AUTH continuation lines
 * and malformed tokens the hostile/divergence cases need — which a conforming
 * client would refuse to emit.
 *
 * This is a helper module, not a test file (no `*.test.ts` suffix), so vitest's
 * `include` glob skips it and the package tsconfig excludes `__tests__`.
 */

import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import type { SMTPServerOptions } from 'smtp-server';

/** A parsed SMTP reply captured by {@link converse}. */
export interface WireReply {
	/** Three-digit reply code. */
	code: number;
	/** RFC 3463 enhanced status code, if the reply carried one. */
	enhanced?: string;
	/** The full final reply line (without CRLF). */
	line: string;
	/** Every line of the reply (continuation lines + final), e.g. the EHLO block. */
	lines: string[];
}

/** A running oracle `smtp-server` plus its bound port. */
export interface RunningOracle {
	server: SMTPServer;
	port: number;
}

/**
 * Start a real `smtp-server` on an ephemeral loopback port. `authOptional` is on
 * by default so scripts may skip AUTH; callers override any option.
 */
export async function startOracle(options: SMTPServerOptions): Promise<RunningOracle> {
	const server = new SMTPServer({ authOptional: true, ...options });
	// Swallow connection-reset noise from tests that hang up mid-dialogue.
	server.on('error', () => {});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
	const port = (server.server.address() as AddressInfo).port;
	return { server, port };
}

/** Stop a running oracle (idempotent). */
export function stopOracle(oracle: RunningOracle | undefined): Promise<void> {
	if (!oracle) return Promise.resolve();
	return new Promise((resolve) => oracle.server.close(() => resolve()));
}

/** Reject helper for `smtp-server` handler callbacks with a specific reply code. */
export function rejectWith(code: number, message: string): Error & { responseCode: number } {
	const err = new Error(message) as Error & { responseCode: number };
	err.responseCode = code;
	return err;
}

/** Parse one SMTP reply line into `{ code, enhanced? }`; returns null if not a reply. */
function parseReplyLine(line: string): { code: number; enhanced?: string } | null {
	const m = /^(\d{3})(?:[ -](.*))?$/.exec(line);
	if (!m) return null;
	const code = Number(m[1]);
	const text = m[2] ?? '';
	const enh = /^(\d\.\d{1,3}\.\d{1,3})\b/.exec(text);
	return enh ? { code, enhanced: enh[1] } : { code };
}

/**
 * A single scripted step. A plain string is sent verbatim (a trailing CRLF is
 * appended if absent) and exactly one reply is awaited. `expectClose` marks a
 * step after which the peer is expected to close instead of replying (e.g.
 * QUIT), so the runner resolves on close rather than timing out.
 */
export interface Step {
	send: string;
	expectClose?: boolean;
}

/**
 * Run a scripted conversation against `port`. Returns the greeting reply first,
 * then one {@link WireReply} per step. Throws on timeout so a hung dialogue
 * fails loudly rather than hanging the suite.
 */
export function converse(
	port: number,
	steps: readonly (string | Step)[],
	timeoutMs = 5000
): Promise<WireReply[]> {
	return new Promise<WireReply[]>((resolve, reject) => {
		const replies: WireReply[] = [];
		const socket = net.connect(port, '127.0.0.1');
		socket.setEncoding('utf8');
		let buffer = '';
		let closed = false;
		let stepIndex = -1; // -1 = awaiting greeting
		let awaitingClose = false;

		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`parity converse timeout at step ${stepIndex}; buffer:\n${buffer}`));
		}, timeoutMs);

		const finish = (): void => {
			clearTimeout(timer);
			socket.destroy();
			resolve(replies);
		};

		/**
		 * Pull one complete reply out of the buffer, or null. Does NOT consume the
		 * buffer until a FINAL line is found, so a partially-arrived multiline reply
		 * is never split across `data` events.
		 */
		const takeReply = (): WireReply | null => {
			let idx = 0;
			const lines: string[] = [];
			for (;;) {
				const nl = buffer.indexOf('\n', idx);
				if (nl === -1) return null;
				const raw = buffer.slice(idx, nl).replace(/\r$/, '');
				idx = nl + 1;
				if (/^\d{3}-/.test(raw)) {
					lines.push(raw); // continuation line — keep reading to the final
					continue;
				}
				const parsed = parseReplyLine(raw);
				if (!parsed) continue; // ignore stray non-reply lines
				lines.push(raw);
				buffer = buffer.slice(idx);
				return { code: parsed.code, enhanced: parsed.enhanced, line: raw, lines };
			}
		};

		const sendNext = (): void => {
			stepIndex++;
			const step = steps[stepIndex];
			if (step === undefined) {
				finish();
				return;
			}
			const norm: Step = typeof step === 'string' ? { send: step } : step;
			// After an `expectClose` step (e.g. QUIT) the peer may reply-then-close or
			// just close; either the pre-close reply or the close event advances us.
			awaitingClose = norm.expectClose === true;
			const payload = norm.send.endsWith('\r\n') ? norm.send : norm.send + '\r\n';
			socket.write(payload);
		};

		const pump = (): void => {
			for (;;) {
				const reply = takeReply();
				if (!reply) return;
				replies.push(reply);
				if (awaitingClose) {
					// Recorded the pre-close reply (e.g. 221); wait for the close.
					return;
				}
				sendNext();
				if (stepIndex >= steps.length) return;
			}
		};

		socket.on('data', (chunk: string) => {
			buffer += chunk;
			if (stepIndex === -1) {
				const greeting = takeReply();
				if (!greeting) return;
				replies.push(greeting);
				sendNext();
			}
			pump();
		});
		socket.on('close', () => {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			resolve(replies);
		});
		socket.on('error', () => {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			resolve(replies);
		});
	});
}
