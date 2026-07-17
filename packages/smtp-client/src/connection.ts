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
 * failure classification) and the reply-reader mechanics in `replyReader.ts`.
 * `connect()` builds ONE {@link ReplyReader}, drives the whole handshake through
 * it, and hands that same instance to the {@link SmtpConnection} it constructs —
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

import {
	serializeEhlo,
	serializeHelo,
	parseEhloCapabilities,
	type EhloCapabilities,
} from './commands';
import { SmtpError, type SmtpPhase } from './errors';
import { ReplyReader } from './replyReader';
import { type SmtpReply, isPositiveCompletion } from './reply';
import { openPlainSocket, openTlsSocket, startTlsUpgrade } from './transport';
import { DEFAULT_TIMEOUTS, type SmtpConnectOptions, type SmtpTimeouts } from './connectionTypes';

export {
	type SmtpConnectOptions,
	type SmtpTlsOptions,
	type SmtpTlsMode,
	type SmtpTimeouts,
} from './connectionTypes';

/**
 * A live SMTP connection, opened and past EHLO. Owns the socket (via its
 * {@link ReplyReader}) and a single reply reader; `command()` writes a line and
 * resolves the next complete reply. Higher layers (AUTH, the send state machine)
 * build on this — this piece only establishes it and exposes the wire primitives.
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
	/**
	 * Epoch millis when the connection became ready (TCP + greeting + EHLO +
	 * optional STARTTLS all complete). The MTA pool measures a reused socket's
	 * max lifetime from here — the socket's real open time, not the moment it was
	 * first parked for reuse.
	 */
	readonly openedAt: number;

	private readonly reader: ReplyReader;
	private readonly timeouts: SmtpTimeouts;
	private closed = false;

	private constructor(init: {
		reader: ReplyReader;
		timeouts: SmtpTimeouts;
		secured: boolean;
		tlsProtocol: string | undefined;
		greeting: SmtpReply;
		capabilities: EhloCapabilities;
	}) {
		this.reader = init.reader;
		this.timeouts = init.timeouts;
		this.secured = init.secured;
		this.tlsProtocol = init.tlsProtocol;
		this.greeting = init.greeting;
		this.capabilities = init.capabilities;
		this.openedAt = Date.now();
	}

	/** The active socket, for the rare layer that needs the raw handle. */
	get rawSocket(): net.Socket {
		return this.reader.socket;
	}

	/**
	 * The peer's remote address (e.g. `127.0.0.1`, `::1`), or `undefined` once the
	 * socket has been destroyed. The transaction layer reads this to decide whether
	 * a cleartext AUTH is permitted (loopback exception) without touching the socket.
	 */
	get remoteAddress(): string | undefined {
		return this.reader.socket.remoteAddress;
	}

	/**
	 * The data-phase timeout (ms) — the budget for the reply that acknowledges the
	 * whole message. The transaction layer waits on this after streaming the body.
	 */
	get dataTimeoutMs(): number {
		return this.timeouts.data;
	}

	/**
	 * The per-command timeout (ms) — the budget for a single command's reply. The
	 * pipelining path reads each batched reply on this budget, exactly as the
	 * sequential {@link command} would have.
	 */
	get commandTimeoutMs(): number {
		return this.timeouts.command;
	}

	/**
	 * `true` when the reader is still holding reply data no command consumed — a
	 * fully-parsed reply queued, or bytes mid-line in the parser. After a clean
	 * transaction this is `false`; a `true` here before reusing the socket means a
	 * leftover/unsolicited reply would desync the next command, so the reuse layer
	 * (X1 `resetTransaction`) refuses to reuse the connection.
	 */
	get hasPendingData(): boolean {
		return this.reader.hasBufferedData;
	}

	/**
	 * Write a command line and resolve the next complete reply. `phase` labels
	 * any resulting timeout / disconnect error; `expectData` uses the (longer)
	 * data-phase timeout instead of the per-command one.
	 */
	async command(line: string, phase: SmtpPhase, expectData = false): Promise<SmtpReply> {
		if (this.reader.busy) {
			// D5 is sequential command/reply. Refuse a second command BEFORE its
			// bytes reach the wire — writing first (then letting reader.read reject)
			// would leave an orphan line whose reply desyncs the next read.
			throw new SmtpError({
				phase,
				message: 'concurrent SMTP command: a reply is already awaited',
				secured: this.secured,
			});
		}
		// Final-hop framing guard: this is public package API, so enforce
		// exactly-one-command framing here even though the S1 serializers already
		// guard their fields. A line with an interior CR/LF would inject a second
		// command; a line missing its CRLF terminator would silently hang until the
		// command timeout. A future call site that hand-builds a line (skipping the
		// serializers) is caught structurally rather than on the wire.
		if (!line.endsWith('\r\n') || /[\r\n]/.test(line.slice(0, -2))) {
			throw new SmtpError({
				phase,
				message:
					'malformed SMTP command line: must end with exactly one CRLF and contain no interior CR/LF',
				secured: this.secured,
			});
		}
		this.write(line, phase);
		return this.reader.read(
			phase,
			expectData ? this.timeouts.data : this.timeouts.command,
			this.secured
		);
	}

	/**
	 * Write a batch of pre-serialized command lines in ONE socket write — RFC 2920
	 * command pipelining. Every line is framing-checked exactly as {@link command}
	 * checks a single line (exactly one trailing CRLF, no interior CR/LF), so a
	 * hand-built or attacker-influenced line can never smuggle a second command into
	 * the batch. The caller then reads one reply per line, in order, via
	 * {@link readReply}: the D5 sequential-READ invariant is untouched — pipelining
	 * batches the WRITE side only, and the reply reader still hands out exactly one
	 * reply per read regardless of how the peer frames them on the wire.
	 *
	 * Refuses (before any bytes reach the wire) if a reply is already awaited, so a
	 * batch can never be interleaved with an outstanding sequential read.
	 */
	writePipeline(lines: readonly string[], phase: SmtpPhase): void {
		if (this.reader.busy) {
			throw new SmtpError({
				phase,
				message: 'concurrent SMTP command: a reply is already awaited',
				secured: this.secured,
			});
		}
		for (const line of lines) {
			if (!line.endsWith('\r\n') || /[\r\n]/.test(line.slice(0, -2))) {
				throw new SmtpError({
					phase,
					message:
						'malformed SMTP command line: must end with exactly one CRLF and contain no interior CR/LF',
					secured: this.secured,
				});
			}
		}
		this.write(lines.join(''), phase);
	}

	/**
	 * Write raw bytes to the socket, failing loudly if it has gone away. Returns
	 * `socket.write`'s backpressure boolean: `false` means the kernel buffer is
	 * full and the caller must wait for the socket's `'drain'` event before
	 * writing more. Command lines are tiny so `command()` ignores it, but the
	 * DATA writer that streams a whole message body over `rawSocket` MUST honor it.
	 */
	write(chunk: string | Buffer, phase: SmtpPhase): boolean {
		if (this.closed || this.reader.failed) {
			throw new SmtpError({
				phase,
				message: 'attempted to write to a closed SMTP connection',
				secured: this.secured,
			});
		}
		return this.reader.socket.write(chunk);
	}

	/** Read the next complete reply, or reject after `timeoutMs`. */
	readReply(phase: SmtpPhase, timeoutMs: number): Promise<SmtpReply> {
		return this.reader.read(phase, timeoutMs, this.secured);
	}

	/**
	 * Write a payload buffer (the dot-stuffed DATA body) to the socket, honoring
	 * backpressure: a `false` from `write()` means the kernel buffer is full, so
	 * this resolves only after the socket's `'drain'`. A socket `error`/`close`
	 * mid-write rejects with a phase-tagged {@link SmtpError}. This method owns the
	 * socket lifecycle so higher layers never touch {@link rawSocket} directly.
	 */
	writePayload(payload: Buffer, phase: SmtpPhase): Promise<void> {
		const socket = this.reader.socket;
		return new Promise<void>((resolve, reject) => {
			const cleanup = (): void => {
				socket.removeListener('error', onError);
				socket.removeListener('close', onClose);
				socket.removeListener('drain', onDrain);
			};
			const fail = (cause: unknown, message: string): void => {
				cleanup();
				reject(new SmtpError({ phase, message, secured: this.secured, cause }));
			};
			const onError = (err: Error): void => fail(err, 'socket error while writing the payload');
			const onClose = (): void => fail(undefined, 'socket closed while writing the payload');
			const onDrain = (): void => {
				cleanup();
				resolve();
			};
			socket.once('error', onError);
			socket.once('close', onClose);
			let drained: boolean;
			try {
				drained = this.write(payload, phase);
			} catch (err) {
				cleanup();
				reject(err);
				return;
			}
			if (drained) {
				cleanup();
				resolve();
				return;
			}
			// Kernel buffer full: wait for 'drain' before the caller reads the reply.
			socket.once('drain', onDrain);
		});
	}

	/** Close the socket and release the reader. Idempotent. */
	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.reader.dispose();
		this.reader.socket.destroy();
	}

	/**
	 * Open a connection: TCP connect, greeting, EHLO (HELO fallback), optional
	 * STARTTLS upgrade + re-EHLO. Resolves a ready {@link SmtpConnection} or
	 * throws a phase-tagged {@link SmtpError}.
	 */
	static async connect(options: SmtpConnectOptions): Promise<SmtpConnection> {
		// Fail closed on a contradictory floor: `none` never reaches TLS, so a
		// caller that also set `requireTls` (e.g. a config-driven flag combined
		// with a loopback-computed `'none'` mode) would otherwise silently proceed
		// in cleartext — a fail-open trap for the cutover pieces. `implicit`
		// trivially satisfies the floor, so only `none` is a contradiction here.
		if (options.tlsMode === 'none' && options.requireTls === true) {
			throw new SmtpError({
				phase: 'connect',
				message:
					"tlsMode 'none' contradicts requireTls: a cleartext connection cannot satisfy a required TLS floor",
				secured: false,
			});
		}

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

		// One reader drives the whole handshake AND the live connection that
		// follows — the same instance is handed to the SmtpConnection below.
		const reader = new ReplyReader(socket);
		try {
			// 2) Greeting.
			const greetingReply = await reader.read('greeting', timeouts.greeting, secured);
			assertPositive(greetingReply, 'greeting', secured);

			// 3) EHLO, with HELO fallback for pre-ESMTP servers.
			let capabilities = await ehlo(reader, options.ehloName, timeouts.command, secured);

			// 4) STARTTLS upgrade (only when starting in cleartext and asked to).
			if (options.tlsMode === 'starttls') {
				if (capabilities.startTls) {
					socket = await startTlsUpgrade(reader, socket, tlsOptions, servername, timeouts);
					secured = true;
					tlsProtocol = (socket as tls.TLSSocket).getProtocol() ?? undefined;
					// 5) Re-EHLO over the secured channel — capabilities can change.
					capabilities = await ehlo(reader, options.ehloName, timeouts.command, true);
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

			return new SmtpConnection({
				reader,
				timeouts,
				secured,
				tlsProtocol,
				greeting: greetingReply,
				capabilities,
			});
		} catch (err) {
			reader.dispose();
			socket.destroy();
			throw err;
		}
	}
}

// ── EHLO / HELO ───────────────────────────────────────────────────────────

async function ehlo(
	reader: ReplyReader,
	ehloName: string,
	timeoutMs: number,
	secured: boolean
): Promise<EhloCapabilities> {
	// Write through reader.socket so the writer and reader target the same socket
	// by construction — after a STARTTLS upgrade rebind() has already repointed the
	// reader, and any other socket reference would desync the two.
	reader.socket.write(serializeEhlo(ehloName));
	const reply = await reader.read('ehlo', timeoutMs, secured);
	if (isPositiveCompletion(reply.code)) {
		return parseEhloCapabilities(reply);
	}
	// Pre-ESMTP server (or EHLO refused): fall back to HELO. A HELO server
	// advertises no capabilities, so the table is empty (no STARTTLS/AUTH).
	reader.socket.write(serializeHelo(ehloName));
	const heloReply = await reader.read('ehlo', timeoutMs, secured);
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
