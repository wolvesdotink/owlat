/**
 * THE SMTP TEST CLIENT — one raw-socket client every listener suite drives.
 *
 * Test-only, but declared here rather than in a `__tests__` folder for the same
 * reason as `@owlat/mta-protocol/wireFixtures`: it is the only place BOTH this
 * package's suites and `apps/mta`'s MX suites can import ONE copy from. A copy
 * per app drifts, and the drift is not cosmetic — the `apps/mta` copy was a
 * fork of an older revision of this class, and it carried BOTH of the bugs
 * fixed below, which made its STARTTLS case fail ~58% of runs (measured over 12
 * isolated runs, 2026-09-17). "Test-only" is enforced, not just stated:
 * importing the `@owlat/smtp-listener/testClient` subpath outside a
 * `__tests__/` folder fails `scripts/check-cross-package-imports.sh`.
 *
 * TWO PROPERTIES ARE LOAD-BEARING, and both exist because their absence
 * produced a flaky suite rather than a failing one.
 *
 * 1. WAIT SEMANTICS. `waitCode` is CONSUMING: it tracks a read cursor and
 *    matches only FINAL reply lines (`250 `, never a `250-` continuation) that
 *    arrive AFTER the last resolved `waitCode`. A non-consuming version scans
 *    the cumulative buffer, so `write('STARTTLS'); await waitCode(220)`
 *    resolves INSTANTLY on the stale greeting `220` and the test races ahead of
 *    the server's `220 Ready to start TLS`. That race is not theoretical: bytes
 *    written before the server has processed STARTTLS land in the plaintext
 *    reader and are discarded by its RFC 3207 §6 injection guard
 *    (`SmtpCommandReader.release`), so the TLS handshake the test is trying to
 *    provoke never starts and the connection survives to the idle timer.
 *    `waitFor` stays NON-consuming (it sees the full cumulative buffer), so
 *    predicates that count cumulative occurrences (`>= 2` of a code) still work.
 *    `received` always returns the full buffer.
 *
 * 2. EVENT-DRIVEN WAITING. Every wait registers a waiter that the socket's own
 *    `data` / `close` / `error` handlers resolve, and races it against ONE
 *    timer. A poll loop (`while (!closed) { if (Date.now() > deadline) throw;
 *    await sleep(10) }`) measures wall-clock while the event it is waiting for
 *    sits unprocessed in a saturated event loop's queue, so it fails under
 *    machine load rather than on behavior. Here a slow event loop DELAYS the
 *    resolution; it cannot turn it into a failure, because the timer callback
 *    and the event are queued in the same loop and the event was queued first.
 */

import net from 'node:net';
import tls from 'node:tls';

interface Waiter {
	/** Returns `true` once satisfied; may advance the read cursor as a side effect. */
	test: () => boolean;
	resolve: () => void;
}

/**
 * Default per-wait budget. Deliberately below vitest's 5 s `testTimeout` so a
 * stuck wait reports WHICH reply never arrived (with the buffer so far) instead
 * of surfacing as an opaque test-level timeout. With event-driven waiting the
 * budget is no longer load-coupled, so a larger number buys nothing.
 */
const DEFAULT_WAIT_TIMEOUT_MS = 4000;

/** Minimal line-buffering SMTP client for assertions over net or TLS. */
export class Client {
	private buffer = '';
	/** Read cursor for CONSUMING `waitCode` matches (see file header). */
	private cursor = 0;
	private waiters: Waiter[] = [];
	closed = false;
	/** Last socket error, recorded so a server-initiated destroy never crashes the suite. */
	error: Error | undefined;
	socket: net.Socket | tls.TLSSocket;

	private constructor(socket: net.Socket | tls.TLSSocket) {
		this.socket = socket;
		this.attach(socket);
	}

	private attach(socket: net.Socket | tls.TLSSocket): void {
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			this.buffer += chunk;
			this.pump();
		});
		socket.on('close', () => {
			this.closed = true;
			for (const w of this.waiters.splice(0)) w.resolve();
		});
		// A server-initiated destroy (the 421 flood test, listener close() teardown)
		// surfaces as ECONNRESET here; record it and resolve waiters like close, so
		// an unhandled 'error' event never crashes the suite.
		socket.on('error', (err: Error) => {
			this.error = err;
			this.closed = true;
			for (const w of this.waiters.splice(0)) w.resolve();
		});
	}

	private pump(): void {
		this.waiters = this.waiters.filter((w) => {
			if (w.test()) {
				w.resolve();
				return false;
			}
			return true;
		});
	}

	static connect(port: number): Promise<Client> {
		return new Promise((resolve) => {
			const socket = net.connect(port, '127.0.0.1', () => resolve(new Client(socket)));
		});
	}

	static connectTls(
		port: number,
		servername = 'mx.test',
		maxVersion?: tls.SecureVersion
	): Promise<Client> {
		return new Promise((resolve, reject) => {
			const socket = tls.connect(
				{
					port,
					host: '127.0.0.1',
					servername,
					rejectUnauthorized: false,
					...(maxVersion && { maxVersion }),
				},
				() => resolve(new Client(socket))
			);
			socket.once('error', reject);
		});
	}

	/**
	 * Upgrade the current plaintext socket to a TLS client socket in place.
	 * `maxVersion` lets a test pin the handshake (e.g. `'TLSv1.2'`) so it can
	 * assert the negotiated suite against the server's TLS 1.2 cipher list.
	 */
	async startTls(servername = 'mx.test', maxVersion?: tls.SecureVersion): Promise<void> {
		const raw = this.socket;
		raw.removeAllListeners('data');
		raw.removeAllListeners('close');
		this.buffer = '';
		this.cursor = 0;
		const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
			const s = tls.connect(
				{
					socket: raw as net.Socket,
					servername,
					rejectUnauthorized: false,
					...(maxVersion && { maxVersion }),
				},
				() => resolve(s)
			);
			s.once('error', reject);
		});
		this.socket = tlsSocket;
		this.attach(tlsSocket);
	}

	get received(): string {
		return this.buffer;
	}

	get cipher(): tls.CipherNameAndProtocol | undefined {
		return this.socket instanceof tls.TLSSocket ? this.socket.getCipher() : undefined;
	}

	write(data: string): void {
		this.socket.write(data);
	}

	/**
	 * Wait until `pred` holds over the FULL cumulative buffer. Non-consuming: use
	 * for specific-pattern / cumulative-count assertions.
	 */
	waitFor(pred: (buf: string) => boolean, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<void> {
		return this.enqueue(() => pred(this.buffer), timeoutMs, 'predicate');
	}

	/**
	 * Wait until a final reply line beginning with `code␣` appears AFTER the read
	 * cursor, then advance the cursor past it. Consuming, so repeated codes (two
	 * `220`s across a STARTTLS upgrade) are matched in order, never re-matched.
	 */
	waitCode(code: number, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<void> {
		const test = (): boolean => {
			const next = this.matchFinalLine(code);
			if (next === -1) return false;
			this.cursor = next;
			return true;
		};
		return this.enqueue(test, timeoutMs, `code ${code}`);
	}

	waitClose(timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<void> {
		return this.enqueue(() => this.closed, timeoutMs, 'close');
	}

	/**
	 * Index just past the next final reply line for `code` at or after the cursor,
	 * or -1 if none is buffered yet. A final line is `code␣…` at buffer start or
	 * after a newline (SMTP continuation lines use `code-`).
	 */
	private matchFinalLine(code: number): number {
		const re = new RegExp(`(?:^|\\n)${code} [^\\n]*(?:\\n|$)`);
		const tail = this.buffer.slice(this.cursor);
		const m = re.exec(tail);
		if (!m) return -1;
		return this.cursor + m.index + m[0].length;
	}

	private enqueue(test: () => boolean, timeoutMs: number, label: string): Promise<void> {
		if (test()) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w !== waiter);
				reject(new Error(`timeout waiting for ${label}; buffer so far:\n${this.buffer}`));
			}, timeoutMs);
			const waiter: Waiter = {
				test,
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
			};
			this.waiters.push(waiter);
		});
	}

	/**
	 * Hard teardown of the client end (RST/close, no half-open wait). This is the
	 * "the test is done with this connection" primitive. A test that needs the
	 * peer to see a graceful FIN — because the FIN itself is what is under test —
	 * calls `client.socket.end()` explicitly.
	 */
	end(): void {
		this.socket.destroy();
	}
}
