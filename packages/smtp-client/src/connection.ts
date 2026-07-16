/**
 * The connection engine of the in-house SMTP client.
 *
 * {@link SmtpConnection.connect} walks a single connection through its opening
 * lifecycle — TCP connect (with optional `localAddress` binding), greeting,
 * EHLO (with HELO fallback), an optional STARTTLS upgrade, and a re-EHLO after
 * the upgrade — then hands back a live {@link SmtpConnection} whose `secured`
 * flag, negotiated TLS protocol, and parsed EHLO `capabilities` are first-class.
 *
 * The socket mechanics live in `transport.ts` (opening + TLS + source-level
 * failure classification) and `bootReader.ts` (the handshake reply reader);
 * this file is the orchestration and the live-connection wire primitives.
 *
 * Two TLS shapes: `implicit` (TLS from byte zero, e.g. 465) and `starttls`
 * (cleartext, then an in-band upgrade, e.g. 25/587). `requireTls` on a
 * `starttls` connection to a server that does not advertise STARTTLS fails
 * closed with `tlsCause` `starttls-unavailable` — a required floor is never
 * silently downgraded to cleartext.
 */

import type net from 'node:net';
import type tls from 'node:tls';

import { BootReader } from './bootReader';
import {
	serializeEhlo,
	serializeHelo,
	parseEhloCapabilities,
	type EhloCapabilities,
} from './commands';
import { SmtpError, type SmtpPhase } from './errors';
import { type ReplyParser, type SmtpReply, isPositiveCompletion } from './reply';
import { openPlainSocket, openTlsSocket, startTlsUpgrade } from './transport';
import { DEFAULT_TIMEOUTS, type SmtpConnectOptions, type SmtpTimeouts } from './connectionTypes';

export {
	type SmtpConnectOptions,
	type SmtpTlsOptions,
	type SmtpTlsMode,
	type SmtpTimeouts,
} from './connectionTypes';

/**
 * A live SMTP connection, opened and past EHLO. Owns the socket and a single
 * reply reader; `command()` writes a line and resolves the next complete reply.
 * Higher layers (AUTH, the send state machine) build on this — this piece only
 * establishes it and exposes the wire primitives.
 */
export class SmtpConnection {
	/** `true` iff the underlying socket is TLS (at EHLO-completion time). */
	readonly secured: boolean;
	/** Negotiated TLS protocol (e.g. `TLSv1.3`), or `undefined` in cleartext. */
	readonly tlsProtocol: string | undefined;
	/** The server's opening greeting reply. */
	readonly greeting: SmtpReply;
	/** The capabilities advertised in the (last) EHLO. */
	readonly capabilities: EhloCapabilities;

	private readonly socket: net.Socket;
	private readonly parser: ReplyParser;
	private readonly timeouts: SmtpTimeouts;
	private readonly queue: SmtpReply[] = [];
	private waiter: { resolve: (reply: SmtpReply) => void; reject: (err: Error) => void } | undefined;
	private waiterTimer: NodeJS.Timeout | undefined;
	private waiterPhase: SmtpPhase = 'greeting';
	private terminalError: Error | undefined;
	private closed = false;

	private constructor(init: {
		socket: net.Socket;
		parser: ReplyParser;
		timeouts: SmtpTimeouts;
		secured: boolean;
		tlsProtocol: string | undefined;
		greeting: SmtpReply;
		capabilities: EhloCapabilities;
	}) {
		this.socket = init.socket;
		this.parser = init.parser;
		this.timeouts = init.timeouts;
		this.secured = init.secured;
		this.tlsProtocol = init.tlsProtocol;
		this.greeting = init.greeting;
		this.capabilities = init.capabilities;
		this.attachReader(init.socket);
	}

	/** The active socket, for the layers that write the DATA payload. */
	get rawSocket(): net.Socket {
		return this.socket;
	}

	/**
	 * Write a command line and resolve the next complete reply. `phase` labels
	 * any resulting timeout / disconnect error; `expectData` uses the (longer)
	 * data-phase timeout instead of the per-command one.
	 */
	async command(line: string, phase: SmtpPhase, expectData = false): Promise<SmtpReply> {
		this.write(line, phase);
		return this.readReply(phase, expectData ? this.timeouts.data : this.timeouts.command);
	}

	/** Write raw bytes to the socket, failing loudly if it has gone away. */
	write(chunk: string | Buffer, phase: SmtpPhase): void {
		if (this.closed || this.terminalError !== undefined) {
			throw new SmtpError({
				phase,
				message: 'attempted to write to a closed SMTP connection',
				secured: this.secured,
				cause: this.terminalError,
			});
		}
		this.socket.write(chunk);
	}

	/** Read the next complete reply, or reject after `timeoutMs`. */
	readReply(phase: SmtpPhase, timeoutMs: number): Promise<SmtpReply> {
		const queued = this.queue.shift();
		if (queued !== undefined) {
			return Promise.resolve(queued);
		}
		if (this.terminalError !== undefined) {
			return Promise.reject(this.wrapTerminal(phase, this.terminalError));
		}
		return new Promise<SmtpReply>((resolve, reject) => {
			this.waiterPhase = phase;
			this.waiter = { resolve, reject };
			this.waiterTimer = setTimeout(() => {
				this.waiter = undefined;
				this.waiterTimer = undefined;
				reject(
					new SmtpError({
						phase,
						message: `timed out after ${timeoutMs}ms waiting for an SMTP reply`,
						secured: this.secured,
					})
				);
			}, timeoutMs);
		});
	}

	/** Close the socket and release the reader. Idempotent. */
	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		if (this.waiterTimer !== undefined) {
			clearTimeout(this.waiterTimer);
			this.waiterTimer = undefined;
		}
		this.socket.destroy();
	}

	private attachReader(socket: net.Socket): void {
		socket.on('data', (chunk: Buffer) => this.onData(chunk));
		socket.on('error', (err: Error) => this.onTerminal(err));
		socket.on('close', () => this.onTerminal(this.terminalError ?? new Error('socket closed')));
	}

	private onData(chunk: Buffer): void {
		let replies: SmtpReply[];
		try {
			replies = this.parser.push(chunk);
		} catch (err) {
			this.onTerminal(err instanceof Error ? err : new Error(String(err)));
			return;
		}
		for (const reply of replies) {
			const waiter = this.waiter;
			if (waiter !== undefined) {
				this.settleWaiter();
				waiter.resolve(reply);
			} else {
				this.queue.push(reply);
			}
		}
	}

	private onTerminal(err: Error): void {
		if (this.terminalError === undefined) {
			this.terminalError = err;
		}
		this.closed = true;
		const waiter = this.waiter;
		if (waiter !== undefined) {
			const phase = this.waiterPhase;
			this.settleWaiter();
			waiter.reject(this.wrapTerminal(phase, err));
		}
	}

	private settleWaiter(): void {
		if (this.waiterTimer !== undefined) {
			clearTimeout(this.waiterTimer);
			this.waiterTimer = undefined;
		}
		this.waiter = undefined;
	}

	private wrapTerminal(phase: SmtpPhase, cause: Error): SmtpError {
		return new SmtpError({
			phase,
			message: `SMTP connection failed: ${cause.message}`,
			secured: this.secured,
			cause,
		});
	}

	/**
	 * Open a connection: TCP connect, greeting, EHLO (HELO fallback), optional
	 * STARTTLS upgrade + re-EHLO. Resolves a ready {@link SmtpConnection} or
	 * throws a phase-tagged {@link SmtpError}.
	 */
	static async connect(options: SmtpConnectOptions): Promise<SmtpConnection> {
		const timeouts: SmtpTimeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
		const tlsOptions = options.tls ?? {};
		const servername = tlsOptions.servername ?? options.host;

		// 1) TCP (or implicit-TLS) connect.
		let socket: net.Socket;
		let secured: boolean;
		let tlsProtocol: string | undefined;
		if (options.tlsMode === 'implicit') {
			socket = await openTlsSocket(options, tlsOptions, servername, timeouts.connect);
			secured = true;
			tlsProtocol = (socket as tls.TLSSocket).getProtocol() ?? undefined;
		} else {
			socket = await openPlainSocket(options, timeouts.connect);
			secured = false;
		}

		// A bootstrap reader drives the opening handshake before the connection
		// object (and its persistent reader) exists.
		const boot = new BootReader(socket);
		try {
			// 2) Greeting.
			const greetingReply = await boot.read('greeting', timeouts.greeting, secured);
			assertPositive(greetingReply, 'greeting', secured);

			// 3) EHLO, with HELO fallback for pre-ESMTP servers.
			let capabilities = await ehlo(boot, socket, options.ehloName, timeouts.command, secured);

			// 4) STARTTLS upgrade (only when starting in cleartext and asked to).
			if (options.tlsMode === 'starttls') {
				if (capabilities.startTls) {
					socket = await startTlsUpgrade(boot, socket, tlsOptions, servername, timeouts);
					secured = true;
					tlsProtocol = (socket as tls.TLSSocket).getProtocol() ?? undefined;
					// 5) Re-EHLO over the secured channel — capabilities can change.
					capabilities = await ehlo(boot, socket, options.ehloName, timeouts.command, true);
				} else if (options.requireTls) {
					// Fail closed: a required TLS floor was not offered.
					throw new SmtpError({
						phase: 'starttls',
						message: 'server does not advertise STARTTLS but TLS is required',
						secured: false,
						tlsCause: 'starttls-unavailable',
					});
				}
			}

			// Hand the socket (and any buffered bytes) to the persistent reader.
			const parser = boot.detach();
			return new SmtpConnection({
				socket,
				parser,
				timeouts,
				secured,
				tlsProtocol,
				greeting: greetingReply,
				capabilities,
			});
		} catch (err) {
			boot.dispose();
			socket.destroy();
			throw err;
		}
	}
}

// ── EHLO / HELO ───────────────────────────────────────────────────────────

async function ehlo(
	boot: BootReader,
	socket: net.Socket,
	ehloName: string,
	timeoutMs: number,
	secured: boolean
): Promise<EhloCapabilities> {
	socket.write(serializeEhlo(ehloName));
	const reply = await boot.read('ehlo', timeoutMs, secured);
	if (isPositiveCompletion(reply.code)) {
		return parseEhloCapabilities(reply);
	}
	// Pre-ESMTP server (or EHLO refused): fall back to HELO. A HELO server
	// advertises no capabilities, so the table is empty (no STARTTLS/AUTH).
	socket.write(serializeHelo(ehloName));
	const heloReply = await boot.read('ehlo', timeoutMs, secured);
	assertPositive(heloReply, 'ehlo', secured);
	return parseEhloCapabilities({
		code: heloReply.code,
		lines: [heloReply.lines[0] ?? ''],
		text: '',
	});
}

function assertPositive(reply: SmtpReply, phase: SmtpPhase, secured: boolean): void {
	if (isPositiveCompletion(reply.code)) {
		return;
	}
	const init: {
		phase: SmtpPhase;
		message: string;
		secured: boolean;
		replyCode: number;
		enhancedCode?: string;
	} = {
		phase,
		message: `server rejected ${phase} with ${reply.code}: ${reply.text}`,
		secured,
		replyCode: reply.code,
	};
	if (reply.enhancedCode !== undefined) {
		init.enhancedCode = reply.enhancedCode;
	}
	throw new SmtpError(init);
}
