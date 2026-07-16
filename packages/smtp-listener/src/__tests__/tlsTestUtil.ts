/**
 * Shared harness for the L2 TLS/AUTH integration tests: a runtime-generated
 * self-signed cert (via `openssl`, mirroring the MTA's bannerEhlo test) and a
 * tiny line-buffering SMTP client that can drive a plaintext socket, upgrade it
 * to TLS in place (STARTTLS), or connect over implicit TLS.
 *
 * This is a helper module, not a test file (no `*.test.ts` suffix), so vitest's
 * `include` glob skips it.
 */

import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

interface Waiter {
	pred: (buf: string) => boolean;
	resolve: () => void;
}

/** Minimal line-buffering SMTP client for assertions over net or TLS. */
export class Client {
	private buffer = '';
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
			this.waiters = this.waiters.filter((w) => {
				if (w.pred(this.buffer)) {
					w.resolve();
					return false;
				}
				return true;
			});
		});
		socket.on('close', () => {
			this.closed = true;
			for (const w of this.waiters.splice(0)) w.resolve();
		});
	}

	static connect(port: number): Promise<Client> {
		return new Promise((resolve) => {
			const socket = net.connect(port, '127.0.0.1', () => resolve(new Client(socket)));
		});
	}

	static connectTls(port: number, servername = 'mx.test'): Promise<Client> {
		return new Promise((resolve, reject) => {
			const socket = tls.connect(
				{ port, host: '127.0.0.1', servername, rejectUnauthorized: false },
				() => resolve(new Client(socket))
			);
			socket.once('error', reject);
		});
	}

	/** Upgrade the current plaintext socket to a TLS client socket in place. */
	async startTls(servername = 'mx.test'): Promise<void> {
		const raw = this.socket;
		raw.removeAllListeners('data');
		raw.removeAllListeners('close');
		this.buffer = '';
		const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
			const s = tls.connect(
				{ socket: raw as net.Socket, servername, rejectUnauthorized: false },
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

	waitFor(pred: (buf: string) => boolean, timeoutMs = 4000): Promise<void> {
		if (pred(this.buffer)) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`timeout waiting; buffer so far:\n${this.buffer}`));
			}, timeoutMs);
			this.waiters.push({
				pred,
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
			});
		});
	}

	/** Wait until a final reply line beginning with `code␣` appears. */
	waitCode(code: number, timeoutMs = 4000): Promise<void> {
		return this.waitFor((buf) => new RegExp(`(^|\\n)${code} `, 'm').test(buf), timeoutMs);
	}

	waitClose(timeoutMs = 4000): Promise<void> {
		return this.waitFor(() => this.closed, timeoutMs);
	}

	end(): void {
		this.socket.destroy();
	}
}
