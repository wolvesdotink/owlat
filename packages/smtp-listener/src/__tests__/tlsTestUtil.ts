/**
 * Shared harness for the listener integration tests: a runtime-generated
 * self-signed cert (via `openssl`, mirroring the MTA's bannerEhlo test), a tiny
 * line-buffering SMTP client that can drive a plaintext socket, upgrade it to
 * TLS in place (STARTTLS), or connect over implicit TLS, and a listener
 * start/stop helper shared by every suite.
 *
 * This is a helper module, not a test file (no `*.test.ts` suffix), so vitest's
 * `include` glob skips it.
 *
 * WAIT SEMANTICS. `waitCode` is CONSUMING: it tracks a read cursor and matches
 * only reply lines that arrive AFTER the last resolved `waitCode`, so a
 * `write('STARTTLS'); await waitCode(220)` cannot resolve instantly on the
 * stale greeting `220` (which would let the client begin its TLS handshake
 * before the server's `220 Ready` is on the wire — the race that corrupted the
 * handshake). `waitFor` stays NON-consuming (it sees the full cumulative
 * buffer), so predicates that count cumulative occurrences (`>= 2` of a code)
 * still work. `received` always returns the full buffer.
 */

import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSmtpListener, type SmtpListener } from '../server.js';
import type { SmtpListenerOptions } from '../types.js';

/** Generate a throwaway self-signed RSA cert/key pair for a loopback listener. */
export function generateCert(cn = 'mx.test'): { cert: string; key: string } {
	const dir = mkdtempSync(join(tmpdir(), 'owlat-smtp-l2-'));
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
			`/CN=${cn}`,
		]);
		return {
			cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
			key: readFileSync(join(dir, 'key.pem'), 'utf8'),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Base64-encode a SASL AUTH PLAIN token: `authzid NUL authcid NUL passwd`. */
export function plainToken(username: string, password: string, authzid = ''): string {
	return Buffer.from(`${authzid}\0${username}\0${password}`, 'utf8').toString('base64');
}

/** Base64-encode a single SASL LOGIN field. */
export function b64(value: string): string {
	return Buffer.from(value, 'utf8').toString('base64');
}

// ---------------------------------------------------------------------------
// Listener harness shared by every suite (one live-listener registry per test
// file — vitest isolates modules per file, so the registry never leaks across
// suites). Each suite registers `afterEach(closeAllListeners)`.
// ---------------------------------------------------------------------------

const activeListeners: SmtpListener[] = [];

/** Start a listener on an ephemeral loopback port and return its bound port. */
export async function startListener(
	opts: SmtpListenerOptions
): Promise<{ listener: SmtpListener; port: number }> {
	const listener = createSmtpListener(opts);
	activeListeners.push(listener);
	await listener.listen(0, '127.0.0.1');
	const addr = listener.address();
	if (!addr || typeof addr === 'string') throw new Error('no address');
	return { listener, port: addr.port };
}

/** Close every listener started in this file (idempotent). */
export async function closeAllListeners(): Promise<void> {
	while (activeListeners.length > 0) {
		const l = activeListeners.pop();
		try {
			await l?.close();
		} catch {
			/* already closed */
		}
	}
}

interface Waiter {
	/** Returns `true` once satisfied; may advance the read cursor as a side effect. */
	test: () => boolean;
	resolve: () => void;
}

/** Minimal line-buffering SMTP client for assertions over net or TLS. */
export class Client {
	private buffer = '';
	/** Read cursor for CONSUMING `waitCode` matches (see file header). */
	private cursor = 0;
	private waiters: Waiter[] = [];
	closed = false;
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
	waitFor(pred: (buf: string) => boolean, timeoutMs = 4000): Promise<void> {
		return this.enqueue(() => pred(this.buffer), timeoutMs, 'predicate');
	}

	/**
	 * Wait until a final reply line beginning with `code␣` appears AFTER the read
	 * cursor, then advance the cursor past it. Consuming, so repeated codes (two
	 * `220`s across a STARTTLS upgrade) are matched in order, never re-matched.
	 */
	waitCode(code: number, timeoutMs = 4000): Promise<void> {
		const test = (): boolean => {
			const next = this.matchFinalLine(code);
			if (next === -1) return false;
			this.cursor = next;
			return true;
		};
		return this.enqueue(test, timeoutMs, `code ${code}`);
	}

	waitClose(timeoutMs = 4000): Promise<void> {
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

	end(): void {
		this.socket.destroy();
	}
}
