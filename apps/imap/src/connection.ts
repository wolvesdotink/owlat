/**
 * The **IMAP pump** — socket lifecycle, line buffering, literal
 * absorption, and active-session tracking. Knows nothing about IMAP
 * verbs; that lives in `commands/<verb>/index.ts` dispatched through
 * `commands/walker.ts`.
 *
 * Read CONTEXT.md → IMAP section and docs/adr/0016-imap-command-modules.md
 * before changing this file.
 *
 * The pump buffers raw OCTETS in a `Buffer` (the socket is left in its
 * default binary mode — no `setEncoding`). Literal absorption (RFC 3501
 * §4.3) counts bytes, not decoded characters, so 8-bit/binary MIME bodies
 * and `{N}` octet declarations frame correctly. Command text is decoded
 * as UTF-8 only once a full CRLF-terminated line has been sliced off.
 */

import type { Socket } from 'net';
import type { TLSSocket } from 'tls';
import type { ImapConfig } from './config.js';
import type { ConvexClient } from './convex.js';
import { logger } from './logger.js';
import {
	parseLine,
	parseCommandWithLiterals,
	matchTrailingLiteral,
} from './parser.js';
import type { AuthRateLimiter } from './rateLimit.js';
import { dispatch, assembleCapabilityLine } from './commands/walker.js';
import type {
	CommandDeps,
	CommandSession,
	ConnectionState,
} from './commands/types.js';

const DEFAULT_MAX_LINE_BYTES = 64 * 1024;
const DEFAULT_MAX_LITERAL_BYTES = 50 * 1024 * 1024;
const DEFAULT_PRE_AUTH_DEADLINE_MS = 30 * 1000;
/**
 * Pre-auth literal ceiling. Before LOGIN succeeds the only legitimate `{N}`
 * literal a client sends is its credentials (a username / password — tens of
 * bytes), so an unauthenticated peer never needs more than a few KiB. Capping
 * the command-literal path here keeps the pre-auth per-connection memory ceiling
 * bounded (~this many bytes) instead of letting it rise to `maxLiteralBytes`
 * (50 MiB) — closing a pre-auth memory-amplification DoS where a peer declares a
 * huge `{N}` for any verb and forces the pump to buffer it before dispatch.
 */
const PRE_AUTH_LITERAL_BYTES = 4 * 1024;
const CRLF = Buffer.from('\r\n');

/**
 * A multi-line command being assembled across literal continuations
 * (e.g. `LOGIN {4}\r\nuser {8}\r\npassword`). `segments` are the decoded
 * text pieces with their trailing `{N}` token stripped; `literals` are
 * the absorbed literal values, interleaved so
 * `segments.length === literals.length + 1` once complete. APPEND does
 * NOT use this path — it streams its body via the session `awaitingLiteral`
 * mechanism instead.
 */
interface PendingCommand {
	readonly segments: string[];
	readonly literals: string[];
}

export class ImapConnection {
	private buffer: Buffer = Buffer.alloc(0);
	private state: ConnectionState = { auth: null, selected: null, clientId: null };
	private activeSession: CommandSession | null = null;
	private literalRemaining = 0;
	/** Non-APPEND command being assembled across `{N}` continuations. */
	private pendingCommand: PendingCommand | null = null;
	/** Octets still to absorb for the in-flight command literal. */
	private commandLiteralRemaining = 0;
	/** Accumulated octets of the in-flight command literal. */
	private commandLiteralChunks: Buffer[] = [];
	private readonly deps: CommandDeps;
	private readonly maxLineBytes: number;
	private readonly maxLiteralBytes: number;
	private preAuthTimer: ReturnType<typeof setTimeout> | null = null;
	private closed = false;

	constructor(
		private socket: Socket | TLSSocket,
		config: ImapConfig,
		convex: ConvexClient,
		rateLimiter: AuthRateLimiter,
		remoteIp: string,
		/**
		 * Whether this socket is TLS-encrypted. `false` only on the dev
		 * plaintext-TCP fallback. Drives the TLS-aware capability line
		 * (LOGINDISABLED + no AUTH=PLAIN when plaintext) and gates the
		 * credential-bearing LOGIN / AUTHENTICATE commands.
		 */
		tls = true,
	) {
		this.maxLineBytes = config.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
		this.maxLiteralBytes = config.maxLiteralBytes ?? DEFAULT_MAX_LITERAL_BYTES;

		const capabilityLine = assembleCapabilityLine(tls);

		// Leave the socket in binary mode: `data` events deliver Buffers, so
		// literal framing counts octets not decoded characters (RFC 3501 §4.3).
		socket.on('data', (chunk: Buffer | string) => this.onData(chunk));
		socket.on('error', (err) =>
			logger.warn({ err, ip: remoteIp }, 'socket error'),
		);
		socket.on('close', () => this.onClose());

		// Drop connections that go silent: an inactivity timeout bounds idle/
		// slowloris squatters, so unauthenticated sockets cannot hold global
		// connection slots forever. `setTimeout` is absent on the test mock
		// socket, so guard the call.
		if (typeof socket.setTimeout === 'function') {
			socket.setTimeout(config.idleTimeoutMs);
			socket.on('timeout', () => this.destroyConnection('Idle timeout'));
		}

		// Shorter deadline to complete LOGIN — an accepted but never-authenticated
		// connection is dropped so it can't occupy a slot indefinitely.
		const preAuthMs = config.preAuthDeadlineMs ?? DEFAULT_PRE_AUTH_DEADLINE_MS;
		this.preAuthTimer = setTimeout(() => {
			this.preAuthTimer = null;
			if (this.state.auth === null) {
				this.destroyConnection('Authentication timeout');
			}
		}, preAuthMs);
		// Don't let the deadline timer keep the process alive on its own.
		this.preAuthTimer.unref?.();

		this.deps = {
			convex,
			config,
			rateLimiter,
			remoteIp,
			capabilityLine,
			tls,
			closeConnection: () => this.socket.end(),
			commit: (next) => {
				this.state = next;
			},
		};

		this.send(
			`* OK [${capabilityLine}] ${config.greetingHost} Owlat IMAP ready`,
		);
	}

	private send(line: string): void {
		try {
			this.socket.write(`${line}\r\n`);
		} catch (err) {
			logger.debug({ err }, 'write failed');
		}
	}

	private onClose(): void {
		this.closed = true;
		if (this.preAuthTimer) {
			clearTimeout(this.preAuthTimer);
			this.preAuthTimer = null;
		}
		const session = this.activeSession;
		this.activeSession = null;
		this.literalRemaining = 0;
		this.pendingCommand = null;
		this.commandLiteralRemaining = 0;
		this.commandLiteralChunks = [];
		session?.cancel();
	}

	/**
	 * Abort the connection with a `* BYE` notice. Prefers `socket.destroy()` so a
	 * misbehaving/abusive peer is severed immediately; falls back to `end()` for
	 * the test mock socket which has no `destroy`.
	 */
	private destroyConnection(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.send(`* BYE ${reason}`);
		} catch {
			// best-effort notice; tear down regardless
		}
		const sock = this.socket as { destroy?: () => void; end: () => void };
		if (typeof sock.destroy === 'function') sock.destroy();
		else sock.end();
	}

	private onData(chunk: Buffer | string): void {
		if (this.closed) return;
		const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf-8');
		this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming]);

		// Drain the buffer iteratively. Each pass runs the literal-absorption
		// phases (1/1b) then drains whole command lines (Phase 2); when a line
		// arms a new literal whose body is already buffered, we loop back to the
		// top to absorb it instead of recursing. Keeping this O(1) in stack depth
		// matters: an unauthenticated peer can chain thousands of tiny `{N+}`
		// literals in a single TCP segment, and self-recursion (one frame per
		// literal) would overflow the V8 stack and crash the shared process.
		while (true) {
			if (this.closed) return;

			// Phase 1 — absorb session literal bytes routed to the active session
			// (APPEND streams its body here). Byte-accurate: counts octets.
			if (this.activeSession?.awaitingLiteral && this.literalRemaining > 0) {
				const take = Math.min(this.literalRemaining, this.buffer.length);
				if (take > 0) {
					const slice = this.buffer.subarray(0, take);
					this.buffer = this.buffer.subarray(take);
					this.activeSession.onLiteralBytes?.(Buffer.from(slice));
					this.literalRemaining -= take;
				}
				if (this.literalRemaining > 0) {
					// Still waiting for more bytes — leave the buffer for the next chunk.
					return;
				}
				// Literal satisfied — clients optionally trail a CRLF after the body.
				this.stripLeadingNewline();
			}

			// Phase 1b — absorb a command literal ({N} continuation for a non-APPEND
			// command such as LOGIN). Octet-counted; the bytes become a single token.
			if (this.commandLiteralRemaining > 0) {
				const take = Math.min(this.commandLiteralRemaining, this.buffer.length);
				if (take > 0) {
					this.commandLiteralChunks.push(Buffer.from(this.buffer.subarray(0, take)));
					this.buffer = this.buffer.subarray(take);
					this.commandLiteralRemaining -= take;
				}
				if (this.commandLiteralRemaining > 0) {
					// Still waiting for more literal octets.
					return;
				}
				// Literal complete — record its value and resume draining the rest of
				// the command line that follows the literal octets.
				const value = Buffer.concat(this.commandLiteralChunks).toString('utf-8');
				this.commandLiteralChunks = [];
				this.pendingCommand?.literals.push(value);
			}

			// Guard — cap the length of an un-terminated command line. When we are
			// NOT mid-literal and the buffer has grown past the line ceiling with no
			// CRLF in sight, the peer is streaming an endless line: abort instead of
			// letting `this.buffer` grow without bound (pre-auth memory/CPU DoS).
			if (
				this.literalRemaining === 0 &&
				this.commandLiteralRemaining === 0 &&
				this.buffer.length > this.maxLineBytes &&
				this.buffer.indexOf(CRLF) < 0
			) {
				this.destroyConnection('Command line too long');
				return;
			}

			// Phase 2 — drain whole lines. `restartPump` is set when a line arms a
			// new literal (command-literal continuation or APPEND session body) whose
			// octets may already be buffered: break out and loop the outer `while` so
			// Phase 1/1b absorb them, instead of self-recursing per literal.
			let restartPump = false;
			let newlineIdx: number;
			while ((newlineIdx = this.buffer.indexOf(CRLF)) >= 0) {
				const line = this.buffer.subarray(0, newlineIdx).toString('utf-8');
				this.buffer = this.buffer.subarray(newlineIdx + 2);

				// 2a — active long-running session can absorb the line (IDLE → DONE).
				// A command being assembled across literal continuations is never
				// also an active session, so this only fires for IDLE/DONE.
				if (
					this.pendingCommand === null &&
					this.activeSession?.onClientLine &&
					this.activeSession.onClientLine(line) === 'absorbed'
				) {
					continue;
				}

				// 2b — does this line/segment end in a `{N}` / `{N+}` literal that we
				// must absorb before the command is complete?
				if (this.startCommandLiteralIfPresent(line)) {
					// Octet absorption begins next; loop back so Phase 1b consumes any
					// already-buffered literal body (without growing the call stack).
					restartPump = true;
					break;
				}

				// 2c — a fresh command, or the final segment of a literal command.
				this.dispatchAssembled(line);

				// If that command armed a session literal (APPEND), the remaining
				// buffer is its raw body, not more lines — loop back via Phase 1 so
				// the bytes are absorbed instead of mis-drained as command lines.
				if (this.literalRemaining > 0 && !this.closed) {
					restartPump = true;
					break;
				}
			}

			if (restartPump && !this.closed) continue;
			return;
		}
	}

	/** Strip an optional leading CRLF/LF the client trails after a literal body. */
	private stripLeadingNewline(): void {
		if (this.buffer.length >= 2 && this.buffer[0] === 0x0d && this.buffer[1] === 0x0a) {
			this.buffer = this.buffer.subarray(2);
		} else if (this.buffer.length >= 1 && this.buffer[0] === 0x0a) {
			this.buffer = this.buffer.subarray(1);
		}
	}

	/**
	 * If `line` ends in a `{N}` / `{N+}` literal declaration that the pump
	 * should absorb (every command except APPEND, which streams its body via
	 * the session `awaitingLiteral` path), set up command-literal absorption:
	 * strip the literal token, stash the segment, send the `+ ` continuation
	 * (unless LITERAL+), and arm `commandLiteralRemaining`. Returns true when
	 * absorption was started, false when `line` should be dispatched as-is.
	 */
	private startCommandLiteralIfPresent(line: string): boolean {
		const lit = matchTrailingLiteral(line);
		if (!lit) return false;

		// APPEND owns its own byte-streaming literal path — let it dispatch
		// normally so its module sets `awaitingLiteral` and handles `+ Ready`.
		if (this.pendingCommand === null && this.peekVerb(line) === 'APPEND') {
			return false;
		}

		// Defense-in-depth literal cap at the pump, mirroring the session path.
		if (lit.octets > this.maxLiteralBytes) {
			this.pendingCommand = null;
			this.destroyConnection('Literal too large');
			return true;
		}

		// Pre-auth memory ceiling: an unauthenticated peer can only legitimately
		// send a credentials literal (tens of bytes via LOGIN). Refuse to buffer a
		// larger `{N}` for any verb before LOGIN succeeds — otherwise a peer could
		// declare a huge literal and force the pump to absorb up to `maxLiteralBytes`
		// (50 MiB) per connection before dispatch (pre-auth memory-amplification DoS).
		if (this.state.auth === null && lit.octets > PRE_AUTH_LITERAL_BYTES) {
			this.pendingCommand = null;
			this.destroyConnection('Literal too large');
			return true;
		}

		const segment = line.slice(0, line.length - this.trailingLiteralTokenLength(line));
		if (this.pendingCommand === null) {
			this.pendingCommand = { segments: [], literals: [] };
		}
		this.pendingCommand.segments.push(segment);
		this.commandLiteralRemaining = lit.octets;
		this.commandLiteralChunks = [];
		// RFC 3501 §4.3: a non-synchronizing LITERAL+ ({N+}, RFC 7888) needs no
		// continuation; a synchronizing {N} requires the server to invite data.
		if (!lit.literalPlus) {
			this.send('+ ');
		}
		return true;
	}

	/** Length of the trailing `{N}` / `{N+}` token on a segment (0 if none). */
	private trailingLiteralTokenLength(segment: string): number {
		const m = segment.match(/\{\d+\+?\}$/);
		return m ? m[0].length : 0;
	}

	/** Best-effort peek at the command verb (second token) of a raw line. */
	private peekVerb(line: string): string | null {
		const parsed = parseLine(line);
		return parsed ? parsed.command : null;
	}

	/**
	 * Dispatch a fully-assembled command. When a `pendingCommand` is in
	 * flight, `line` is its final segment (no trailing literal): splice the
	 * collected literals back into the token stream. Otherwise parse the
	 * single line directly.
	 */
	private dispatchAssembled(line: string): void {
		let parsed;
		if (this.pendingCommand) {
			this.pendingCommand.segments.push(line);
			parsed = parseCommandWithLiterals(
				this.pendingCommand.segments,
				this.pendingCommand.literals,
			);
			this.pendingCommand = null;
		} else {
			parsed = parseLine(line);
		}
		if (!parsed) return;

		const session = dispatch(
			this.deps,
			this.state,
			parsed,
			(l) => this.send(l),
		);
		this.trackSession(session);
	}

	private trackSession(session: CommandSession): void {
		const isLongRunning = !!(session.awaitingLiteral || session.onClientLine);
		if (isLongRunning) {
			// Defense-in-depth literal cap at the pump: even if a command module
			// forgot to bound its `{N}`, refuse to absorb an oversized literal
			// rather than buffer it into memory.
			if (session.awaitingLiteral && session.awaitingLiteral.bytes > this.maxLiteralBytes) {
				session.cancel();
				this.destroyConnection('Literal too large');
				return;
			}
			this.activeSession = session;
			if (session.awaitingLiteral) {
				this.literalRemaining = session.awaitingLiteral.bytes;
			}
		}
		session.completion
			.then(() => {
				if (this.activeSession === session) {
					this.activeSession = null;
					this.literalRemaining = 0;
				}
			})
			.catch((err) => {
				logger.error({ err }, 'session completion crashed');
			});
	}
}
