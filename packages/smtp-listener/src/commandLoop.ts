/**
 * The SMTP command loop: a byte-oriented reader over a raw `net` socket plus the
 * MAIL / RCPT / DATA / RSET / NOOP / QUIT (+ HELO/EHLO/VRFY) state machine.
 *
 * No TLS and no AUTH live here — L2 layers those on. The loop is written against
 * a plain duplex socket so the same machine runs over `net.Socket` and (later)
 * `tls.TLSSocket`. DATA is bounded by {@link ByteBudget} (D5) and dot-decoded by
 * {@link dotDecode}; every stall is closed by the socket idle timeout.
 */

import type { Socket } from 'node:net';
import { ByteBudget } from './budget.js';
import { dotDecode } from './dotDecode.js';
import { Reply, replyBytes, SmtpReplyError } from './reply.js';
import type {
	SmtpAddress,
	SmtpHandlerResult,
	SmtpListenerOptions,
	SmtpReply,
	SmtpSession,
} from './types.js';

/** Fully-resolved listener configuration (defaults applied). */
export interface ResolvedListenerConfig<S, T> {
	hostname: string;
	banner: string;
	extensions: string[];
	maxMessageBytes: number;
	abortFactor: number;
	maxCommandBytes: number;
	maxBadCommands: number;
	commandMs: number;
	dataMs: number;
	opts: SmtpListenerOptions<S, T>;
}

const CR = 0x0d;
const LF = 0x0a;
const EMPTY = Buffer.alloc(0);
const TERMINATOR = Buffer.from('\r\n.\r\n');

/** Thrown internally when a command line exceeds the configured cap. */
class LineTooLongError extends Error {}

/**
 * Byte-oriented reader over a socket's async-iterable chunks. Buffers exactly
 * one chunk of look-ahead; never accumulates unboundedly. Exposes CRLF command
 * lines and a budgeted, terminator-aware DATA reader.
 */
export class SmtpCommandReader {
	private buf: Buffer = EMPTY;
	private readonly iter: AsyncIterator<Buffer>;
	private ended = false;

	constructor(source: AsyncIterable<Buffer>) {
		this.iter = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
	}

	private async pull(): Promise<boolean> {
		if (this.ended) return false;
		try {
			const next = await this.iter.next();
			if (next.done || next.value === undefined) {
				this.ended = true;
				return false;
			}
			const chunk = next.value;
			this.buf = this.buf.length > 0 ? Buffer.concat([this.buf, chunk]) : chunk;
			return true;
		} catch {
			this.ended = true;
			return false;
		}
	}

	/**
	 * Read one CRLF-terminated command line, WITHOUT the trailing CRLF. Returns
	 * `null` on EOF. Throws {@link LineTooLongError} if the line exceeds
	 * `maxBytes` before a terminator arrives (flood / slowloris bound).
	 */
	async readCommandLine(maxBytes: number): Promise<Buffer | null> {
		for (;;) {
			const lf = this.buf.indexOf(LF);
			if (lf !== -1) {
				const hasCr = lf > 0 && this.buf[lf - 1] === CR;
				const end = hasCr ? lf - 1 : lf;
				const line = this.buf.subarray(0, end);
				this.buf = this.buf.subarray(lf + 1);
				return line;
			}
			if (this.buf.length > maxBytes) {
				throw new LineTooLongError();
			}
			if (!(await this.pull())) {
				if (this.buf.length > 0) {
					const rest = this.buf;
					this.buf = EMPTY;
					return rest;
				}
				return null;
			}
		}
	}

	/**
	 * Read the DATA payload, feeding raw (still dot-stuffed) body bytes through
	 * `budget` and stopping at the `<CRLF>.<CRLF>` terminator. A leading
	 * `.<CRLF>` (empty message) is handled via a virtual CRLF sentinel so both
	 * cases share one search. Any bytes after the terminator (pipelined next
	 * command) are pushed back for the following {@link readCommandLine}.
	 *
	 *  - `ok`     — terminator reached within budget; `budget.result()` is the body.
	 *  - `over`   — terminator reached but the budget was crossed (reply 552).
	 *  - `abort`  — the abort ceiling was crossed; caller must destroy the socket.
	 *  - `closed` — EOF before any terminator (peer hung up mid-DATA).
	 */
	async readDataBody(budget: ByteBudget): Promise<'ok' | 'over' | 'abort' | 'closed'> {
		// `pending` holds not-yet-flushed trailing bytes that might begin a
		// terminator. It starts as a sentinel CRLF (never emitted) so a message
		// that is only `.<CRLF>` is recognized as an empty body.
		let pending = Buffer.from('\r\n');
		let sentinelActive = true;
		for (;;) {
			if (this.buf.length === 0 && !(await this.pull())) {
				return 'closed';
			}
			const chunk = this.buf;
			this.buf = EMPTY;
			const window = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
			const start = sentinelActive ? 2 : 0;
			const idx = window.indexOf(TERMINATOR);
			if (idx !== -1) {
				const body = window.subarray(start, idx + 2); // include closing CRLF of last line
				const verdict = body.length > 0 ? budget.push(body) : 'ok';
				const after = window.subarray(idx + TERMINATOR.length);
				if (after.length > 0) this.buf = after;
				if (verdict === 'abort') return 'abort';
				return budget.isExceeded ? 'over' : 'ok';
			}
			// No terminator yet: flush all but the last (TERMINATOR.length - 1)
			// bytes, which could be a partial terminator spanning the next chunk.
			const keep = Math.min(TERMINATOR.length - 1, window.length - start);
			const flushEnd = window.length - keep;
			if (flushEnd > start) {
				const emit = window.subarray(start, flushEnd);
				const verdict = budget.push(emit);
				sentinelActive = false;
				if (verdict === 'abort') return 'abort';
				pending = window.subarray(flushEnd);
			} else {
				pending = window;
			}
		}
	}
}

/** Split a command line into an uppercased verb and its (trimmed) argument. */
export function parseCommand(line: string): { verb: string; rest: string } {
	const sp = line.indexOf(' ');
	if (sp === -1) return { verb: line.toUpperCase(), rest: '' };
	return { verb: line.slice(0, sp).toUpperCase(), rest: line.slice(sp + 1).trim() };
}

/**
 * Parse a `FROM:<addr> PARAM=VALUE ...` / `TO:<addr> ...` argument. Returns
 * `null` on a syntax error (missing/broken angle-addr). A null reverse-path
 * `<>` yields `address: ''`.
 */
export function parseAddressCommand(rest: string, keyword: 'FROM' | 'TO'): SmtpAddress | null {
	const upper = rest.toUpperCase();
	const prefix = `${keyword}:`;
	if (!upper.startsWith(prefix)) return null;
	let idx = prefix.length;
	// Optional whitespace between the colon and the angle-addr is tolerated.
	while (idx < rest.length && rest[idx] === ' ') idx++;
	if (rest[idx] !== '<') return null;
	const close = rest.indexOf('>', idx);
	if (close === -1) return null;
	const address = rest.slice(idx + 1, close);
	const params: Record<string, string> = {};
	const tail = rest.slice(close + 1).trim();
	if (tail.length > 0) {
		for (const token of tail.split(/\s+/)) {
			const eq = token.indexOf('=');
			if (eq === -1) {
				params[token.toUpperCase()] = '';
			} else {
				params[token.slice(0, eq).toUpperCase()] = token.slice(eq + 1);
			}
		}
	}
	return { address, params };
}

/** Invoke a handler, normalizing its accept/reject outcome. */
async function invokeHandler<S, T, A>(
	handler:
		| ((arg: A, session: SmtpSession<S, T>) => Promise<SmtpHandlerResult> | SmtpHandlerResult)
		| undefined,
	arg: A,
	session: SmtpSession<S, T>,
	onError: ((err: Error) => void) | undefined
): Promise<{ accept: boolean; reply?: SmtpReply }> {
	if (!handler) return { accept: true };
	try {
		const result = (await handler(arg, session)) as SmtpReply | undefined;
		if (result && result.code >= 400) return { accept: false, reply: result };
		return { accept: true, reply: result ?? undefined };
	} catch (err) {
		if (err instanceof SmtpReplyError) return { accept: false, reply: err.reply };
		onError?.(err instanceof Error ? err : new Error(String(err)));
		return { accept: false, reply: Reply.localError() };
	}
}

/**
 * Drive one connection to completion. Resolves when the peer QUITs, the socket
 * closes, or a timeout / abort tears it down. Never throws to the caller.
 */
export async function runCommandLoop<S, T>(
	socket: Socket,
	session: SmtpSession<S, T>,
	config: ResolvedListenerConfig<S, T>
): Promise<void> {
	const { opts } = config;
	const write = (reply: SmtpReply): void => {
		if (!socket.writableEnded && !socket.destroyed) socket.write(replyBytes(reply));
	};
	// Emit one final reply and tear the socket down, but only AFTER the reply has
	// flushed to the kernel — a bare `destroy()` right after `write()` can drop
	// the reply. Destroying also ends the read side, unblocking the command loop.
	const writeThenDestroy = (reply: SmtpReply): void => {
		if (socket.destroyed || socket.writableEnded) {
			if (!socket.destroyed) socket.destroy();
			return;
		}
		socket.write(replyBytes(reply), () => {
			if (!socket.destroyed) socket.destroy();
		});
	};
	const resetTransaction = (): void => {
		session.mailFrom = undefined;
		session.rcptTo = [];
		session.transaction = undefined;
	};

	// One idle timer governs every stall. Its duration is switched between the
	// command phase and the DATA phase; on fire we emit 421 and destroy.
	socket.setTimeout(config.commandMs);
	socket.on('timeout', () => {
		writeThenDestroy(Reply.shuttingDown(config.hostname));
	});

	const reader = new SmtpCommandReader(socket);
	let badCommands = 0;

	// Greeting + optional connect hook. onConnect takes only the session, so it
	// is adapted to the (arg, session) shape invokeHandler expects.
	write(Reply.greeting(config.banner));
	const onConnect = opts.onConnect;
	const connect = onConnect
		? await invokeHandler((_arg: undefined, s) => onConnect(s), undefined, session, opts.onError)
		: { accept: true as const };
	if (!connect.accept) {
		if (connect.reply) write(connect.reply);
		socket.end();
		return;
	}

	for (;;) {
		socket.setTimeout(config.commandMs);
		let line: Buffer | null;
		try {
			line = await reader.readCommandLine(config.maxCommandBytes);
		} catch {
			writeThenDestroy(Reply.syntaxError('Line too long'));
			return;
		}
		if (line === null) return; // EOF / socket gone

		const { verb, rest } = parseCommand(line.toString('utf8'));

		if (verb === 'QUIT') {
			write(Reply.bye(config.hostname));
			socket.end();
			return;
		}
		if (verb === 'NOOP') {
			write(Reply.ok());
			continue;
		}
		if (verb === 'RSET') {
			resetTransaction();
			write(Reply.ok());
			continue;
		}
		if (verb === 'HELO' || verb === 'EHLO') {
			session.esmtp = verb === 'EHLO';
			session.clientHostname = rest || undefined;
			resetTransaction();
			const hello = await invokeHandler(opts.onHelo, rest, session, opts.onError);
			if (!hello.accept) {
				write(hello.reply ?? Reply.paramError());
				badCommands++;
			} else if (hello.reply) {
				write(hello.reply);
			} else if (verb === 'EHLO') {
				write(Reply.helloOk([`${config.hostname} greets ${rest || 'you'}`, ...ehloLines(config)]));
			} else {
				write(Reply.helloOk([`${config.hostname} at your service`]));
			}
			continue;
		}
		if (verb === 'MAIL') {
			if (session.mailFrom) {
				write(Reply.badSequence('Sender already specified'));
				continue;
			}
			const parsed = parseAddressCommand(rest, 'FROM');
			if (!parsed) {
				write(Reply.paramError());
				badCommands++;
				if (badCommands >= config.maxBadCommands) {
					writeThenDestroy(Reply.tooManyErrors());
					return;
				}
				continue;
			}
			const res = await invokeHandler(opts.onMailFrom, parsed, session, opts.onError);
			if (!res.accept) {
				write(res.reply ?? Reply.localError());
				continue;
			}
			session.mailFrom = parsed;
			write(res.reply ?? Reply.senderOk());
			continue;
		}
		if (verb === 'RCPT') {
			if (!session.mailFrom) {
				write(Reply.badSequence('Need MAIL command'));
				continue;
			}
			const parsed = parseAddressCommand(rest, 'TO');
			if (!parsed) {
				write(Reply.paramError());
				badCommands++;
				if (badCommands >= config.maxBadCommands) {
					writeThenDestroy(Reply.tooManyErrors());
					return;
				}
				continue;
			}
			const res = await invokeHandler(opts.onRcptTo, parsed, session, opts.onError);
			if (!res.accept) {
				write(res.reply ?? Reply.localError());
				continue;
			}
			session.rcptTo.push(parsed);
			write(res.reply ?? Reply.recipientOk());
			continue;
		}
		if (verb === 'DATA') {
			if (!session.mailFrom || session.rcptTo.length === 0) {
				write(Reply.badSequence('Need MAIL and RCPT before DATA'));
				continue;
			}
			write(Reply.startMailInput());
			socket.setTimeout(config.dataMs);
			const budget = new ByteBudget(config.maxMessageBytes, config.abortFactor);
			const outcome = await reader.readDataBody(budget);
			socket.setTimeout(config.commandMs);
			if (outcome === 'closed') return;
			if (outcome === 'abort') {
				socket.destroy();
				return;
			}
			if (outcome === 'over') {
				write(Reply.messageTooLarge(config.maxMessageBytes));
				resetTransaction();
				continue;
			}
			const message = dotDecode(budget.result());
			const res = await invokeHandler(opts.onData, message, session, opts.onError);
			write(res.accept ? (res.reply ?? Reply.dataAccepted()) : (res.reply ?? Reply.localError()));
			resetTransaction();
			continue;
		}
		if (verb === 'VRFY' || verb === 'EXPN') {
			// Do not confirm or deny address existence (no enumeration oracle).
			write({ code: 252, enhanced: '2.5.2', text: 'Cannot VRFY user' });
			continue;
		}
		if (verb === 'HELP') {
			write({ code: 214, enhanced: '2.0.0', text: 'See RFC 5321' });
			continue;
		}
		// STARTTLS / AUTH are added in L2; everything else is unimplemented.
		write(Reply.notImplemented());
		badCommands++;
		if (badCommands >= config.maxBadCommands) {
			writeThenDestroy(Reply.tooManyErrors());
			return;
		}
	}
}

/** EHLO capability lines: caller extensions plus the derived SIZE advertisement. */
function ehloLines<S, T>(config: ResolvedListenerConfig<S, T>): string[] {
	return [...config.extensions, `SIZE ${config.maxMessageBytes}`];
}
