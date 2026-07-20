/**
 * The byte-oriented SMTP wire reader and command parsers.
 *
 * {@link SmtpCommandReader} turns a socket's async-iterable chunks into CRLF
 * command lines and a budgeted, terminator-aware DATA reader, buffering exactly
 * one chunk of look-ahead so it never accumulates unboundedly. It is
 * transport-agnostic (runs over `net.Socket` and `tls.TLSSocket`) and can be
 * detached from a live socket via {@link SmtpCommandReader.release} so a
 * STARTTLS upgrade can rebind the same connection to TLS.
 */

import { ByteBudget } from './budget.js';
import type { SmtpAddress } from './types.js';

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
		// A Node stream (`net.Socket`) exposes `.iterator({ destroyOnReturn })`.
		// We iterate with `destroyOnReturn: false` so {@link release} can detach
		// the iterator's listeners WITHOUT tearing down the underlying socket —
		// required to hand the live socket to TLS on a STARTTLS upgrade. Plain
		// async-iterables (test fixtures) fall back to the default iterator.
		const streamSource = source as {
			iterator?: (opts: { destroyOnReturn: boolean }) => AsyncIterator<Buffer>;
		};
		this.iter =
			typeof streamSource.iterator === 'function'
				? streamSource.iterator({ destroyOnReturn: false })
				: (source[Symbol.asyncIterator]() as AsyncIterator<Buffer>);
	}

	/**
	 * Stop consuming the source and detach its listeners WITHOUT destroying it,
	 * so the caller can rebind the still-open socket (STARTTLS). Any residual
	 * buffered bytes are dropped — a plaintext-injection guard (RFC 3207 §6).
	 */
	async release(): Promise<void> {
		this.ended = true;
		this.buf = EMPTY;
		await this.iter.return?.(undefined);
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
				if (end > maxBytes) {
					throw new LineTooLongError();
				}
				const line = this.buf.subarray(0, end);
				this.buf = this.buf.subarray(lf + 1);
				return line;
			}
			// Permit one trailing CR beyond the content cap while waiting for its LF;
			// every other byte beyond maxBytes is already an oversized command.
			if (
				this.buf.length > maxBytes &&
				!(this.buf.length === maxBytes + 1 && this.buf[this.buf.length - 1] === CR)
			) {
				throw new LineTooLongError();
			}
			if (!(await this.pull())) {
				// EOF. Any residual bytes are an unterminated command fragment
				// (SMTP commands require CRLF); drop it rather than executing a
				// non-conformant partial line.
				this.buf = EMPTY;
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
		let pending: Buffer = Buffer.from('\r\n');
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
