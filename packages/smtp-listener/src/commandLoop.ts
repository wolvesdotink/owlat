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
import type { SmtpHandlerResult, SmtpListenerOptions, SmtpReply, SmtpSession } from './types.js';

/** Fully-resolved listener configuration (defaults applied). */
export interface ResolvedListenerConfig<S, T> {
	hostname: string;
	banner: string;
	extensions: string[];
	maxMessageBytes: number;
	abortFactor: number;
	maxCommandBytes: number;
	maxBadCommands: number;
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
	session: SmtpSession<S, T>,
	config: ResolvedListenerConfig<S, T>
): Promise<void> {
	const { opts } = config;
	// `activeSocket` and `reader` are reassigned by a STARTTLS upgrade: after the
	// handshake the loop continues over the TLS socket with a FRESH reader (any
	// bytes buffered on the plaintext socket are discarded — RFC 3207).
	let activeSocket: Socket = socket;
	const write = (reply: SmtpReply): void => {
		if (!activeSocket.writableEnded && !activeSocket.destroyed) {
			activeSocket.write(replyBytes(reply));
		}
	};
	// Emit one final reply and tear the socket down, but only AFTER the reply has
	// flushed to the kernel — a bare `destroy()` right after `write()` can drop
	// the reply. Destroying also ends the read side, unblocking the command loop.
	const writeThenDestroy = (reply: SmtpReply): void => {
		if (activeSocket.destroyed || activeSocket.writableEnded) {
			if (!activeSocket.destroyed) activeSocket.destroy();
			return;
		}
		activeSocket.write(replyBytes(reply), () => {
			if (!activeSocket.destroyed) activeSocket.destroy();
		});
	};
	const resetTransaction = (): void => {
		session.mailFrom = undefined;
		session.rcptTo = [];
		session.transaction = undefined;
	};

	// One idle timer governs every stall. Its duration is switched between the
	// command phase and the DATA phase; on fire we emit 421 and destroy. The
	// handler is re-armed on the TLS socket after a STARTTLS upgrade.
	const armTimeout = (sock: Socket): void => {
		sock.setTimeout(config.commandMs);
		sock.on('timeout', () => {
			writeThenDestroy(Reply.shuttingDown(config.hostname));
		});
	};
	armTimeout(activeSocket);

	let reader = new SmtpCommandReader(activeSocket);
	let badCommands = 0;

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
			badCommands = 0;
			write(Reply.ok());
			continue;
		}
		if (verb === 'RSET') {
			badCommands = 0;
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
				write(hello.reply ?? Reply.paramError());
				badCommands++;
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
				write(Reply.paramError());
				badCommands++;
				if (badCommands >= config.maxBadCommands) {
					writeThenDestroy(Reply.tooManyErrors());
					return;
				}
				continue;
			}
			const res = await invokeHandler(opts.onMailFrom, parsed, session, opts.onError);
			if (!res.accept) {
				write(res.reply ?? Reply.localError());
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
				write(Reply.paramError());
				badCommands++;
				if (badCommands >= config.maxBadCommands) {
					writeThenDestroy(Reply.tooManyErrors());
					return;
				}
				continue;
			}
			const res = await invokeHandler(opts.onRcptTo, parsed, session, opts.onError);
			if (!res.accept) {
				write(res.reply ?? Reply.localError());
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
			// Do not confirm or deny address existence (no enumeration oracle).
			badCommands = 0;
			write({ code: 252, enhanced: '2.5.2', text: 'Cannot VRFY user' });
			continue;
		}
		if (verb === 'HELP') {
			badCommands = 0;
			write({ code: 214, enhanced: '2.0.0', text: 'See RFC 5321' });
			continue;
		}
		if (verb === 'STARTTLS') {
			// Advertised only when TLS is available and the channel is not already
			// secure; refuse otherwise so the capability list and behavior agree.
			if (!config.tls || session.secure) {
				write(session.secure ? Reply.badSequence('TLS already active') : Reply.notImplemented());
				if (!session.secure) {
					badCommands++;
					if (badCommands >= config.maxBadCommands) {
						writeThenDestroy(Reply.tooManyErrors());
						return;
					}
				}
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
			resetTransaction();
			session.clientHostname = undefined;
			session.esmtp = false;
			session.authenticated = false;
			session.user = undefined;
			session.secure = true;
			// Silence the plaintext socket's idle timer; the TLS socket owns it now.
			activeSocket.setTimeout(0);
			activeSocket = tlsSocket;
			activeSocket.setNoDelay(true);
			activeSocket.on('error', (e: Error) => opts.onError?.(e));
			armTimeout(activeSocket);
			reader = new SmtpCommandReader(activeSocket);
			badCommands = 0;
			continue;
		}
		if (verb === 'AUTH') {
			if (!config.auth) {
				write(Reply.notImplemented());
				badCommands++;
				if (badCommands >= config.maxBadCommands) {
					writeThenDestroy(Reply.tooManyErrors());
					return;
				}
				continue;
			}
			if (config.auth.requireTls && !session.secure) {
				// AUTH before TLS is refused with a distinct encryption-required
				// reply — this is not an auth oracle (it reveals nothing about any
				// credential), it enforces RFC 4954 §4.
				write(Reply.encryptionRequired());
				continue;
			}
			if (session.authenticated) {
				write(Reply.badSequence('Already authenticated'));
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
			});
			if (result === 'closed') return;
			// One byte-identical reply per outcome — no auth oracle (D6).
			if (result === 'ok') {
				badCommands = 0;
				write(Reply.authOk());
			} else {
				write(Reply.authFailed());
			}
			continue;
		}
		// Everything else is unimplemented.
		write(Reply.notImplemented());
		badCommands++;
		if (badCommands >= config.maxBadCommands) {
			writeThenDestroy(Reply.tooManyErrors());
			return;
		}
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
