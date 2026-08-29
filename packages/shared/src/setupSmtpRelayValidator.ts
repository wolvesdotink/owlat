/**
 * Generic SMTP relay validator.
 *
 * The one provider in the setup flow that cannot be checked with `fetch`: a
 * relay is proved usable by driving a real SMTP handshake + AUTH exchange over
 * Node's `net`/`tls` sockets (no message is ever sent). Split out of
 * `./setupValidators`, which re-exports `validateSmtpRelay` and
 * `SmtpRelayInput` so the `@owlat/shared/setupValidators` surface is unchanged.
 *
 * Server-side only (the Nitro setup/transport endpoints and the `owlat-setup`
 * CLI) — never bundled into the browser, so the Node built-ins below are safe.
 */

import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { isBlockedSsrfHost, resolvesToBlockedAddress } from './setupSsrfGuard';
import type { ValidationResult } from './setupValidationHttp';

/**
 * Instance-level SMTP relay connection to validate before it is written to the
 * `SMTP_RELAY_*` env. `secure: true` opens an implicit-TLS connection (usually
 * 465); `secure: false` connects in cleartext and upgrades via STARTTLS (587) —
 * matching the backend `smtp` send adapter's semantics exactly.
 */
export interface SmtpRelayInput {
	host: string;
	port: number;
	secure: boolean;
	username: string;
	password: string;
}

interface SmtpReply {
	code: number;
	/** Whole reply, lines joined by spaces — used only for error strings. */
	text: string;
	/** Raw reply lines (code prefix intact) — parsed for advertised AUTH mechs. */
	lines: string[];
}

// Per-step read/connect bound so a hung relay can't stall setup indefinitely.
const SMTP_PROBE_TIMEOUT_MS = 10_000;

/** Bound and strip control chars from a raw remote reply before echoing it, so a
 * hostile/non-SMTP server can't inject its unbounded banner into the setup reply. */
function sanitizeReplyText(text: string): string {
	let out = '';
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		out += code < 0x20 || code === 0x7f ? ' ' : ch;
	}
	out = out.trim();
	return out.length > 120 ? `${out.slice(0, 120)}…` : out;
}

/** A minimal SMTP client that drives just enough of the submission handshake to
 * prove a relay is usable (greeting/EHLO/STARTTLS/AUTH); it never sends a message. */
class SmtpProbe {
	private buffer = '';
	private pendingLines: string[] = [];
	private readonly replyQueue: SmtpReply[] = [];
	private waiter: { resolve: (r: SmtpReply) => void; reject: (e: Error) => void } | null = null;
	private failure: Error | null = null;

	private readonly onData = (chunk: Buffer): void => this.ingest(chunk.toString('utf8'));
	private readonly onError = (e: Error): void =>
		this.fail(e instanceof Error ? e : new Error(String(e)));
	private readonly onClose = (): void => this.fail(new Error('connection closed'));

	private constructor(private socket: Socket | TLSSocket) {
		this.bind(socket);
	}

	static open(host: string, port: number, secure: boolean): Promise<SmtpProbe> {
		return new Promise((resolve, reject) => {
			const socket = secure
				? tlsConnect({ host, port, servername: host })
				: netConnect({ host, port });
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error('timeout'));
			}, SMTP_PROBE_TIMEOUT_MS);
			const onErr = (e: Error): void => {
				clearTimeout(timer);
				socket.destroy();
				reject(e);
			};
			socket.once(secure ? 'secureConnect' : 'connect', () => {
				clearTimeout(timer);
				socket.removeListener('error', onErr);
				resolve(new SmtpProbe(socket));
			});
			socket.once('error', onErr);
		});
	}

	private bind(socket: Socket | TLSSocket): void {
		socket.on('data', this.onData);
		socket.on('error', this.onError);
		socket.on('close', this.onClose);
	}

	private unbind(socket: Socket | TLSSocket): void {
		socket.removeListener('data', this.onData);
		socket.removeListener('error', this.onError);
		socket.removeListener('close', this.onClose);
	}

	private ingest(chunk: string): void {
		this.buffer += chunk;
		let idx: number;
		while ((idx = this.buffer.indexOf('\n')) !== -1) {
			let line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 1);
			if (line.endsWith('\r')) line = line.slice(0, -1);
			this.pendingLines.push(line);
			// A reply is complete when a line has a space (not a hyphen) after the
			// 3-digit code, or is too short to be a continuation.
			if (line.length < 4 || line.charAt(3) === ' ') {
				const code = Number.parseInt(line.slice(0, 3), 10);
				const lines = this.pendingLines;
				this.pendingLines = [];
				this.deliver({ code: Number.isFinite(code) ? code : 0, text: lines.join(' '), lines });
			}
		}
	}

	private deliver(reply: SmtpReply): void {
		if (this.waiter) {
			const w = this.waiter;
			this.waiter = null;
			w.resolve(reply);
		} else {
			this.replyQueue.push(reply);
		}
	}

	private fail(e: Error): void {
		if (this.failure) return;
		this.failure = e;
		if (this.waiter) {
			const w = this.waiter;
			this.waiter = null;
			w.reject(e);
		}
	}

	private read(): Promise<SmtpReply> {
		const queued = this.replyQueue.shift();
		if (queued) return Promise.resolve(queued);
		if (this.failure) return Promise.reject(this.failure);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiter = null;
				reject(new Error('timeout'));
			}, SMTP_PROBE_TIMEOUT_MS);
			this.waiter = {
				resolve: (r) => {
					clearTimeout(timer);
					resolve(r);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			};
		});
	}

	private send(command: string): void {
		this.socket.write(`${command}\r\n`);
	}

	private async expect(ok: (code: number) => boolean, context: string): Promise<SmtpReply> {
		const reply = await this.read();
		if (!ok(reply.code)) {
			throw new Error(`${context}: ${reply.code} ${sanitizeReplyText(reply.text)}`.trim());
		}
		return reply;
	}

	/** Send EHLO and return the advertised AUTH mechanisms (upper-cased). */
	private async ehlo(): Promise<Set<string>> {
		this.send('EHLO owlat-setup');
		const reply = await this.expect((c) => c >= 200 && c < 300, 'SMTP relay rejected EHLO');
		const mechs = new Set<string>();
		for (const line of reply.lines) {
			const match = line.slice(4).match(/^AUTH\s+(.+)$/i);
			if (match?.[1]) {
				for (const mech of match[1].trim().split(/\s+/)) mechs.add(mech.toUpperCase());
			}
		}
		return mechs;
	}

	private async startTls(host: string): Promise<void> {
		this.unbind(this.socket);
		const raw = this.socket as Socket;
		const tlsSocket = await new Promise<TLSSocket>((resolve, reject) => {
			// Bound the upgrade: a relay that answers 220 to STARTTLS but never finishes
			// the TLS handshake would otherwise hang the setup endpoint / CLI forever.
			const timer = setTimeout(() => {
				s.destroy();
				reject(new Error('timeout'));
			}, SMTP_PROBE_TIMEOUT_MS);
			const onErr = (e: Error): void => {
				clearTimeout(timer);
				s.destroy();
				reject(e);
			};
			const s = tlsConnect({ socket: raw, servername: host }, () => {
				clearTimeout(timer);
				s.removeListener('error', onErr);
				resolve(s);
			});
			s.once('error', onErr);
		});
		this.socket = tlsSocket;
		this.buffer = '';
		this.pendingLines = [];
		this.bind(tlsSocket);
	}

	private async authenticate(mechs: Set<string>, input: SmtpRelayInput): Promise<ValidationResult> {
		if (mechs.has('PLAIN')) {
			const token = Buffer.from(`\0${input.username}\0${input.password}`).toString('base64');
			this.send(`AUTH PLAIN ${token}`);
		} else if (mechs.has('LOGIN')) {
			this.send('AUTH LOGIN');
			await this.expect((c) => c === 334, 'SMTP relay did not start AUTH LOGIN');
			this.send(Buffer.from(input.username).toString('base64'));
			await this.expect((c) => c === 334, 'SMTP relay rejected the username exchange');
			this.send(Buffer.from(input.password).toString('base64'));
		} else {
			return {
				ok: false,
				message:
					'The SMTP relay did not offer a supported AUTH mechanism (PLAIN or LOGIN). Double-check the host and port.',
			};
		}
		const reply = await this.read();
		if (reply.code === 235) {
			this.send('QUIT');
			return { ok: true, message: 'SMTP relay accepted the credentials.' };
		}
		if (reply.code === 530 || reply.code === 534 || reply.code === 535 || reply.code === 538) {
			return { ok: false, message: 'The SMTP relay rejected the username or password.' };
		}
		return {
			ok: false,
			message: `SMTP relay authentication failed: ${reply.code} ${sanitizeReplyText(reply.text)}`,
		};
	}

	async run(input: SmtpRelayInput): Promise<ValidationResult> {
		await this.expect((c) => c >= 200 && c < 400, 'SMTP relay did not send a greeting');
		await this.ehlo();
		if (!input.secure) {
			this.send('STARTTLS');
			await this.expect((c) => c >= 200 && c < 300, 'SMTP relay refused STARTTLS');
			await this.startTls(input.host);
		}
		const mechs = await this.ehlo();
		return this.authenticate(mechs, input);
	}

	close(): void {
		try {
			this.socket.destroy();
		} catch {
			/* already closed */
		}
	}
}

/** Turn a raw socket/timeout error into an operator-facing sentence. */
function describeSmtpError(e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	if (msg === 'timeout') return 'The SMTP relay did not respond in time. Check the host and port.';
	// `expect()` failures already read as full sentences; pass them through.
	if (msg.startsWith('SMTP relay')) return msg;
	const lower = msg.toLowerCase();
	if (lower.includes('econnrefused')) {
		return 'Connection refused by the SMTP relay. Check the host and port.';
	}
	if (lower.includes('enotfound') || lower.includes('eai_again')) {
		return 'Could not resolve the SMTP relay host. Check the hostname.';
	}
	if (lower.includes('certificate') || lower.includes('ssl') || lower.includes('tls')) {
		return `TLS handshake with the SMTP relay failed: ${msg}`;
	}
	return `Could not reach the SMTP relay: ${msg}`;
}

/** Validate a generic SMTP relay by driving a real handshake through AUTH (no
 * message sent). SSRF-guarded and time-bounded, so bad creds surface here. */
export async function validateSmtpRelay(input: SmtpRelayInput): Promise<ValidationResult> {
	if (!input.host.trim()) return { ok: false, message: 'SMTP relay host is required.' };
	if (isBlockedSsrfHost(input.host)) {
		return { ok: false, message: 'SMTP relay host must be a public address.' };
	}
	if (await resolvesToBlockedAddress(input.host)) {
		// A public name that resolves to an internal address (public-name → internal-IP).
		return { ok: false, message: 'SMTP relay host must be a public address.' };
	}
	if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
		return { ok: false, message: 'SMTP relay port must be a whole number between 1 and 65535.' };
	}
	if (!input.username || !input.password) {
		return { ok: false, message: 'SMTP relay username and password are required.' };
	}

	let probe: SmtpProbe | null = null;
	try {
		probe = await SmtpProbe.open(input.host, input.port, input.secure);
		return await probe.run(input);
	} catch (e) {
		return { ok: false, message: describeSmtpError(e) };
	} finally {
		probe?.close();
	}
}
