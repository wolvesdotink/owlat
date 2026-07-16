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
	}

	/** The active socket, for the layers that write the DATA payload. */
	get rawSocket(): net.Socket {
		return this.reader.socket;
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
		this.write(line, phase);
		return this.reader.read(
			phase,
			expectData ? this.timeouts.data : this.timeouts.command,
			this.secured
		);
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
