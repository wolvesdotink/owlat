/**
 * The SMTP command loop: the MAIL / RCPT / DATA / RSET / NOOP / QUIT / STARTTLS
 * / AUTH (+ HELO/EHLO/VRFY) state machine over a byte-oriented socket reader.
 *
 * The loop is written against a plain duplex socket so the same machine runs
 * over `net.Socket` and `tls.TLSSocket`; a STARTTLS upgrade rebinds the same
 * connection to TLS mid-loop and performs a full RFC 3207 state reset. DATA is
 * bounded by {@link ByteBudget} (D5) and dot-decoded by {@link dotDecode}; the
 * wire reader and command parsers live in {@link module:reader}; every stall is
 * closed by the socket idle timeout.
 */

import type { Socket } from 'node:net';
import { ByteBudget } from './budget.js';
import { dotDecode } from './dotDecode.js';
import { Reply, replyBytes, SmtpReplyError } from './reply.js';
import { performAuth, type SmtpAuthConfig } from './auth.js';
import { upgradeTls, type ResolvedTlsConfig } from './tls.js';
import { SmtpCommandReader, parseAddressCommand, parseCommand } from './reader.js';
import type {
	MutableSmtpSession,
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
	maxRecipients: number;
	abortFactor: number;
	maxCommandBytes: number;
	maxBadCommands: number;
	maxMailCommands: number;
	maxPendingReplyBytes: number;
	commandMs: number;
	dataMs: number;
	/** Resolved TLS material, present when the listener can speak TLS. */
	tls?: ResolvedTlsConfig;
	/** Whether the accepted socket is already TLS (implicit-TLS listener). */
	implicitTls: boolean;
	/** SASL AUTH configuration, present when the listener advertises AUTH. */
	auth?: SmtpAuthConfig<S, T>;
	opts: SmtpListenerOptions<S, T>;
}

/** Minimal socket surface used by the bounded reply writer (also fakeable in tests). */
export interface ReplyWriteSocket {
	readonly writableEnded: boolean;
	readonly destroyed: boolean;
	readonly writableLength: number;
	write(bytes: Buffer, callback?: () => void): boolean;
	destroy(): void;
}

/**
 * Queue one reply without allowing Node's user-space socket buffer to grow past
 * `maxPendingBytes`. A peer can send commands without reading replies because
 * TCP is full-duplex; destroying at this boundary prevents that valid-command
 * pattern from becoming a one-connection memory-exhaustion primitive.
 */
export function writeReplyWithinBudget(
	socket: ReplyWriteSocket,
	reply: SmtpReply,
	maxPendingBytes: number,
	onFlushed?: () => void
): boolean {
	if (socket.writableEnded || socket.destroyed) return false;
	const bytes = replyBytes(reply);
	if (socket.writableLength + bytes.length > maxPendingBytes) {
		socket.destroy();
		return false;
	}
	socket.write(bytes, onFlushed);
	return true;
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
	session: MutableSmtpSession<S, T>,
	config: ResolvedListenerConfig<S, T>
): Promise<void> {
	const { opts } = config;
	// `activeSocket` and `reader` are reassigned by a STARTTLS upgrade: after the
	// handshake the loop continues over the TLS socket with a FRESH reader (any
	// bytes buffered on the plaintext socket are discarded — RFC 3207).
	let activeSocket: Socket = socket;
	const write = (reply: SmtpReply): void => {
		writeReplyWithinBudget(activeSocket, reply, config.maxPendingReplyBytes);
	};
	// Emit one final reply and tear the socket down, but only AFTER the reply has
	// flushed to the kernel — a bare `destroy()` right after `write()` can drop
	// the reply. Destroying also ends the read side, unblocking the command loop.
	const writeThenDestroy = (reply: SmtpReply): void => {
		const target = activeSocket;
		const queued = writeReplyWithinBudget(target, reply, config.maxPendingReplyBytes, () => {
			if (!target.destroyed) target.destroy();
		});
		if (!queued && !target.destroyed) target.destroy();
	};
	const resetTransaction = (): void => {
		session.mailFrom = undefined;
		session.rcptTo = [];
		session.transaction = undefined;
	};
	// The RFC 3207 §4.2/§6 full state reset performed on a STARTTLS upgrade:
	// discard the transaction AND every connection-level fact learned in the
	// plaintext phase (EHLO identity, ESMTP mode, any prior AUTH). Named so a
	// future session field cannot silently miss the reset the piece exists to
	// guarantee — `session.secure` is set to `true` by the caller, separately,
	// because it is the NEW posture rather than a cleared plaintext-phase fact.
	const resetSessionForTls = (): void => {
		resetTransaction();
		session.clientHostname = undefined;
		session.esmtp = false;
		session.authenticated = false;
		session.user = undefined;
	};

	// One idle timer governs every stall. Its duration is switched between the
	// command phase and the DATA phase; on fire we emit 421 and destroy. Returns
	// a disarm handle that both silences the timer AND detaches the handler —
	// used at a STARTTLS upgrade so the plaintext socket's timer cannot fire a
	// stale `writeThenDestroy` against the NEW (TLS) `activeSocket`. The loop
	// re-arms on the TLS socket after the upgrade.
	const armTimeout = (sock: Socket): (() => void) => {
		const onTimeout = (): void => {
			writeThenDestroy(Reply.shuttingDown(config.hostname));
		};
		sock.setTimeout(config.commandMs);
		sock.on('timeout', onTimeout);
		return (): void => {
			sock.setTimeout(0);
			sock.removeListener('timeout', onTimeout);
		};
	};
	let disarmTimeout = armTimeout(activeSocket);

	let reader = new SmtpCommandReader(activeSocket);
	let badCommands = 0;
	// Monotonic lifetime budget: valid MAIL FROM invokes application policy (SPF
	// on the MX), so EHLO/RSET/STARTTLS/AUTH/DATA must never replenish the cap.
	let mailCommands = 0;

	// Emit `reply`, count it against the bad-command budget, and — once the
	// budget is exhausted — send 421 and tear the socket down. Returns `'stop'`
	// when the caller must return from the loop, `'continue'` otherwise. This is
	// the single choke point for error streams (unknown
	// verbs, malformed MAIL/RCPT, STARTTLS/AUTH misuse, failed AUTH attempts, AND
	// application policy rejections of MAIL FROM / RCPT TO — matching
	// `smtp-server`'s unauthenticated-command cap, D2). Because every MAIL/RCPT
	// rejection is a bad command, a peer cannot loop rejected envelope commands to
	// drive unbounded SPF/route/auth lookups or to hold the connection open: each
	// rejection advances the budget, and only a command that makes real FORWARD
	// PROGRESS resets it — an ACCEPTED HELO/EHLO/MAIL/RCPT/DATA or a successful
	// AUTH. The free, stateless commands (NOOP/RSET/VRFY/EXPN/HELP) deliberately
	// do NOT reset the budget: they need no valid state and always "succeed", so
	// resetting on them would let a peer launder the amplification bound by
	// interleaving a free command between each rejected envelope command. The
	// monotonic MAIL budget above separately caps laundering through real progress.
	const noteBadCommand = (reply: SmtpReply): 'continue' | 'stop' => {
		write(reply);
		badCommands++;
		if (badCommands >= config.maxBadCommands) {
			writeThenDestroy(Reply.tooManyErrors());
			return 'stop';
		}
		return 'continue';
	};

	// Greeting + optional connect hook. onConnect takes only the session, so it
	// is adapted to the (arg, session) shape invokeHandler expects.
	write(Reply.greeting(config.banner));
	const onConnect = opts.onConnect;
	const connect = onConnect
		? await invokeHandler((_arg: undefined, s) => onConnect(s), undefined, session, opts.onError)
		: { accept: true as const };
	if (!connect.accept) {
		if (connect.reply) write(connect.reply);
		activeSocket.end();
		return;
	}

	for (;;) {
		activeSocket.setTimeout(config.commandMs);
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
			activeSocket.end();
			return;
		}
		if (verb === 'NOOP') {
			// Free, stateless command: never resets the bad-command budget (see the
			// `noteBadCommand` rationale) so it cannot launder the amplification bound.
			write(Reply.ok());
			continue;
		}
		if (verb === 'RSET') {
			// Resets the TRANSACTION per RFC 5321, but not the bad-command budget: a
			// bare RSET is free and makes no forward progress.
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
				if (noteBadCommand(hello.reply ?? Reply.paramError()) === 'stop') return;
			} else {
				badCommands = 0;
				if (hello.reply) {
					write(hello.reply);
				} else if (verb === 'EHLO') {
					write(
						Reply.helloOk([
							`${config.hostname} greets ${rest || 'you'}`,
							...ehloLines(config, session),
						])
					);
				} else {
					write(Reply.helloOk([`${config.hostname} at your service`]));
				}
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
				if (noteBadCommand(Reply.paramError()) === 'stop') return;
				continue;
			}
			if (mailCommands >= config.maxMailCommands) {
				writeThenDestroy(Reply.tooManyMailCommands());
				return;
			}
			mailCommands++;
			const res = await invokeHandler(opts.onMailFrom, parsed, session, opts.onError);
			if (!res.accept) {
				// A rejected sender leaves `session.mailFrom` unset, so the "already
				// specified" guard above can never bound a stream of rejected MAIL FROMs.
				// Count each rejection against the bad-command budget instead: a peer
				// looping rejected senders (each triggering a full checkSpf ~ 10 DNS
				// lookups on the port-25 MX) is torn down with 421 after the cap.
				if (noteBadCommand(res.reply ?? Reply.localError()) === 'stop') return;
				continue;
			}
			badCommands = 0;
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
				if (noteBadCommand(Reply.paramError()) === 'stop') return;
				continue;
			}
			if (session.rcptTo.length >= config.maxRecipients) {
				// Bound ACCEPTED per-transaction state before invoking application
				// policy: once `maxRecipients` recipients have been accepted, further
				// RCPTs are refused 452 WITHOUT invoking the handler, so the recipient
				// array cannot grow past the cap. Already-accepted recipients remain
				// valid and the peer may proceed to DATA (RFC 5321 §4.5.3.1.8). This
				// gate keys on `rcptTo.length`, which only grows on ACCEPTED recipients;
				// REJECTED recipients never reach it, so they are bounded separately by
				// the bad-command budget below (a rejected RCPT triggers a route lookup).
				write(Reply.tooManyRecipients(config.maxRecipients));
				continue;
			}
			const res = await invokeHandler(opts.onRcptTo, parsed, session, opts.onError);
			if (!res.accept) {
				// Rejected recipients never grow `rcptTo`, so the `maxRecipients` gate
				// above can never trip on them. Count each rejection against the
				// bad-command budget so a peer flooding rejected RCPTs (each a Redis
				// route lookup on the port-25 MX) is torn down with 421 after the cap
				// rather than amplifying lookups without bound.
				if (noteBadCommand(res.reply ?? Reply.localError()) === 'stop') return;
				continue;
			}
			badCommands = 0;
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
			activeSocket.setTimeout(config.dataMs);
			const budget = new ByteBudget(config.maxMessageBytes, config.abortFactor);
			const outcome = await reader.readDataBody(budget);
			activeSocket.setTimeout(config.commandMs);
			if (outcome === 'closed') return;
			if (outcome === 'abort') {
				activeSocket.destroy();
				return;
			}
			if (outcome === 'over') {
				write(Reply.messageTooLarge(config.maxMessageBytes));
				resetTransaction();
				continue;
			}
			badCommands = 0;
			const message = dotDecode(budget.result());
			const res = await invokeHandler(opts.onData, message, session, opts.onError);
			write(res.accept ? (res.reply ?? Reply.dataAccepted()) : (res.reply ?? Reply.localError()));
			resetTransaction();
			continue;
		}
		if (verb === 'VRFY' || verb === 'EXPN') {
			// Do not confirm or deny address existence (no enumeration oracle). Free
			// and stateless: does not reset the bad-command budget.
			write({ code: 252, enhanced: '2.5.2', text: 'Cannot VRFY user' });
			continue;
		}
		if (verb === 'HELP') {
			// Free and stateless: does not reset the bad-command budget.
			write({ code: 214, enhanced: '2.0.0', text: 'See RFC 5321' });
			continue;
		}
		if (verb === 'STARTTLS') {
			// RFC 3207 §4: STARTTLS takes NO parameter; reject any argument with
			// 501 (matches `smtp-server`) without upgrading.
			if (rest.length > 0) {
				if (noteBadCommand(Reply.paramError()) === 'stop') return;
				continue;
			}
			// Advertised only when TLS is available and the channel is not already
			// secure; refuse otherwise so the capability list and behavior agree.
			if (!config.tls || session.secure) {
				// Both misuse cases flow through the single bad-command choke point so
				// a secured client cannot loop STARTTLS 503s without consuming budget.
				const reply = session.secure
					? Reply.badSequence('TLS already active')
					: Reply.notImplemented();
				if (noteBadCommand(reply) === 'stop') return;
				continue;
			}
			// Capture the narrowed TLS config before any `await` so narrowing on the
			// mutable `config.tls` property cannot be invalidated across the calls.
			const tlsConfig = config.tls;
			// 220, then the client begins the TLS handshake on THIS socket.
			write(Reply.tlsReady());
			// Detach the plaintext reader from the socket (without destroying it)
			// so TLS can take over the same connection cleanly.
			await reader.release();
			let tlsSocket: Socket;
			try {
				tlsSocket = await upgradeTls(activeSocket, tlsConfig);
			} catch (err) {
				opts.onError?.(err instanceof Error ? err : new Error(String(err)));
				if (!activeSocket.destroyed) activeSocket.destroy();
				return;
			}
			// FULL STATE RESET (RFC 3207 §4.2 / §6): everything learned before the
			// upgrade is discarded, including any pending MAIL FROM, the greeting,
			// and any prior AUTH. A fresh reader over the TLS socket drops any
			// plaintext bytes the peer pipelined behind STARTTLS (injection guard).
			resetSessionForTls();
			session.secure = true;
			// Fully disarm the plaintext socket's idle timer AND detach its handler
			// before rebinding: the handler's closure calls `writeThenDestroy`, which
			// dereferences the mutable `activeSocket`, so a stale timer left attached
			// could tear down the NEW TLS session.
			disarmTimeout();
			activeSocket = tlsSocket;
			activeSocket.setNoDelay(true);
			activeSocket.on('error', (e: Error) => opts.onError?.(e));
			disarmTimeout = armTimeout(activeSocket);
			reader = new SmtpCommandReader(activeSocket);
			badCommands = 0;
			continue;
		}
		if (verb === 'AUTH') {
			if (!config.auth) {
				if (noteBadCommand(Reply.notImplemented()) === 'stop') return;
				continue;
			}
			if (config.auth.requireTls && !session.secure) {
				// AUTH before TLS is refused with a distinct encryption-required
				// reply — this is not an auth oracle (it reveals nothing about any
				// credential), it enforces RFC 4954 §4. Counted against the
				// bad-command budget so a pre-TLS AUTH flood cannot loop forever.
				if (noteBadCommand(Reply.encryptionRequired()) === 'stop') return;
				continue;
			}
			if (session.authenticated) {
				if (noteBadCommand(Reply.badSequence('Already authenticated')) === 'stop') return;
				continue;
			}
			const sp = rest.indexOf(' ');
			const mechanism = (sp === -1 ? rest : rest.slice(0, sp)).toUpperCase();
			const initialResponse = sp === -1 ? null : rest.slice(sp + 1).trim();
			const result = await performAuth({
				mechanism,
				initialResponse,
				session,
				auth: config.auth,
				write,
				readLine: async () => {
					const l = await reader.readCommandLine(config.maxCommandBytes);
					return l === null ? null : l.toString('utf8');
				},
				onError: opts.onError,
			});
			if (result === 'closed') return;
			// One byte-identical reply per outcome — no auth oracle (D6).
			if (result === 'ok') {
				badCommands = 0;
				write(Reply.authOk());
				continue;
			}
			// Every failed AUTH (rejected credentials OR protocol garbage that never
			// reached the backend) counts against the bad-command budget, so a
			// hostile client looping AUTH cannot hold the connection open forever —
			// the cap `smtp-server` enforces via `_maxAllowedUnauthenticatedCommands`
			// (D2). The 535 bytes are unchanged (no oracle).
			if (noteBadCommand(Reply.authFailed()) === 'stop') return;
			continue;
		}
		// Everything else is unimplemented.
		if (noteBadCommand(Reply.notImplemented()) === 'stop') return;
	}
}

/**
 * EHLO capability lines: caller extensions, then STARTTLS / AUTH (gated on the
 * live TLS + auth posture so the list FLIPS across a STARTTLS upgrade), then the
 * derived SIZE advertisement.
 *
 *  - STARTTLS is advertised only while TLS is available AND the channel is still
 *    plaintext — it disappears once `session.secure` is true.
 *  - AUTH is advertised only when the channel is eligible (already secure, or the
 *    listener does not require TLS for AUTH) — it appears after the upgrade.
 */
function ehloLines<S, T>(
	config: ResolvedListenerConfig<S, T>,
	session: SmtpSession<S, T>
): string[] {
	const lines = [...config.extensions];
	if (config.tls && !session.secure) lines.push('STARTTLS');
	if (config.auth && (session.secure || !config.auth.requireTls)) {
		lines.push(`AUTH ${config.auth.mechanisms.join(' ')}`);
	}
	lines.push(`SIZE ${config.maxMessageBytes}`);
	return lines;
}
