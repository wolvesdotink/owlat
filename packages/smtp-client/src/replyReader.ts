/**
 * The single reply reader for a connection's whole lifetime — greeting, EHLO,
 * STARTTLS, re-EHLO, and every command issued after the connection is live.
 *
 * It owns exactly one `data` listener at a time, follows the socket across a
 * STARTTLS upgrade (via {@link ReplyReader.pauseSource} + {@link ReplyReader.rebind}),
 * and enforces the sequential-read invariant of D5: at most one {@link
 * ReplyReader.read} may be outstanding at once. `connect()` builds one reader for
 * the opening handshake and hands the SAME instance to the {@link SmtpConnection}
 * it constructs — there is no parser hand-off and no second reader, so no reply
 * can be dropped or double-read in a transition.
 */

import type net from 'node:net';

import { SmtpError, type SmtpPhase } from './errors';
import { ReplyParser, type SmtpReply } from './reply';

export class ReplyReader {
	private source: net.Socket;
	private parser = new ReplyParser();
	private readonly queue: SmtpReply[] = [];
	private waiter:
		| { resolve: (reply: SmtpReply) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
		| undefined;
	private terminalError: Error | undefined;
	private readonly onData = (chunk: Buffer): void => this.feed(chunk);
	private readonly onError = (err: Error): void => this.fail(err);
	private readonly onClose = (): void =>
		this.fail(this.terminalError ?? new Error('socket closed before reply'));

	constructor(socket: net.Socket) {
		this.source = socket;
		this.bind(socket);
	}

	/** The socket the reader is currently bound to (the command/DATA writer's target). */
	get socket(): net.Socket {
		return this.source;
	}

	/** `true` once a terminal error (socket `error`/`close`) has been observed. */
	get failed(): boolean {
		return this.terminalError !== undefined;
	}

	/**
	 * `true` while a {@link ReplyReader.read} is outstanding. `command()` checks
	 * this BEFORE serializing so a D5-violating second command is refused before
	 * its bytes reach the wire — otherwise the line would be sent, its reply
	 * would land in the queue with no waiter, and the next read would consume a
	 * stale reply (silent desync).
	 */
	get busy(): boolean {
		return this.waiter !== undefined;
	}

	/**
	 * `true` when the reader is holding reply data the caller has not consumed —
	 * a fully-parsed reply still queued, or bytes mid-line in the parser. The
	 * STARTTLS upgrade asserts this is `false` after the 220 to prove the peer
	 * injected nothing before the socket is wrapped (RFC 3207 §4.2).
	 */
	get hasBufferedData(): boolean {
		return this.queue.length > 0 || this.parser.hasPending;
	}

	read(phase: SmtpPhase, timeoutMs: number, secured: boolean): Promise<SmtpReply> {
		if (this.waiter !== undefined) {
			// D5 is sequential command/reply: a second read while one is pending is
			// a caller bug, never a wire condition. Reject loudly instead of
			// clobbering the live waiter (which would hang both promises).
			return Promise.reject(
				new SmtpError({
					phase,
					message: 'concurrent SMTP read: a reply is already awaited',
					secured,
				})
			);
		}
		// A terminal error poisons the reader: it takes precedence over anything
		// still in the queue so a reply that arrived AFTER a wire timeout / close
		// can never be handed out as the answer to a later read (stale-reply
		// desync). Only a live, un-poisoned reader drains the queue.
		if (this.terminalError !== undefined) {
			return Promise.reject(this.wrap(phase, this.terminalError, secured));
		}
		const queued = this.queue.shift();
		if (queued !== undefined) {
			return Promise.resolve(queued);
		}
		return new Promise<SmtpReply>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiter = undefined;
				// A wire timeout is fatal: poison the reader so no late-arriving reply
				// can be queued and consumed by the NEXT read as its own answer (the
				// reply-stream desync class behind DATA-reply misattribution). Setting
				// terminalError flips `failed`, so write() refuses and every later read
				// rejects. (The concurrent-read rejection above must NOT poison — only
				// this wire timeout does.)
				const timeoutError = new SmtpError({
					phase,
					message: `timed out after ${timeoutMs}ms waiting for an SMTP reply`,
					secured,
				});
				if (this.terminalError === undefined) {
					this.terminalError = timeoutError;
				}
				reject(timeoutError);
			}, timeoutMs);
			this.waiter = {
				resolve,
				reject: (err: Error) => reject(this.wrap(phase, err, secured)),
				timer,
			};
		});
	}

	/** Stop listening on the current source (before a socket swap). */
	pauseSource(): void {
		this.source.removeListener('data', this.onData);
		this.source.removeListener('error', this.onError);
		this.source.removeListener('close', this.onClose);
	}

	/** Point the reader at the upgraded (TLS) socket and resume reading. */
	rebind(socket: net.Socket): void {
		this.source = socket;
		this.bind(socket);
	}

	/**
	 * Discard the cleartext parser and start the secured leg with a fresh one so
	 * no pre-TLS byte can be decoded as a post-TLS reply (RFC 3207 §4.2). Callers
	 * MUST have already asserted {@link ReplyReader.hasBufferedData} is `false`.
	 */
	resetParser(): void {
		this.parser = new ReplyParser();
	}

	/**
	 * Stop reading and settle any pending waiter. Idempotent teardown.
	 *
	 * `SmtpConnection.close()` calls this and then destroys the socket, but by then
	 * {@link ReplyReader.pauseSource} has already removed the `close`/`error`
	 * listeners, so the destroy can no longer settle an in-flight read. We must
	 * reject the waiter here — otherwise a caller awaiting a reply when the
	 * connection is closed (e.g. on an outer deadline) hangs forever. Poison the
	 * reader too so any later read rejects instead of consuming a late reply.
	 */
	dispose(): void {
		this.pauseSource();
		if (this.terminalError === undefined) {
			this.terminalError = new Error('connection closed while a reply was awaited');
		}
		const waiter = this.waiter;
		if (waiter !== undefined) {
			clearTimeout(waiter.timer);
			this.waiter = undefined;
			waiter.reject(this.terminalError);
		}
	}

	private bind(socket: net.Socket): void {
		socket.on('data', this.onData);
		socket.on('error', this.onError);
		socket.on('close', this.onClose);
	}

	private feed(chunk: Buffer): void {
		// A poisoned reader (wire timeout / terminal error) never hands out a reply
		// again — read() rejects on terminalError before the queue is ever drained.
		// Discard the chunk before parsing so a still-open, chatty/hostile server
		// cannot grow the queue without bound between the poisoning and close().
		if (this.terminalError !== undefined) {
			return;
		}
		let replies: SmtpReply[];
		try {
			replies = this.parser.push(chunk);
		} catch (err) {
			this.fail(err instanceof Error ? err : new Error(String(err)));
			return;
		}
		for (const reply of replies) {
			const waiter = this.waiter;
			if (waiter !== undefined) {
				clearTimeout(waiter.timer);
				this.waiter = undefined;
				waiter.resolve(reply);
			} else {
				this.queue.push(reply);
			}
		}
	}

	private fail(err: Error): void {
		if (this.terminalError === undefined) {
			this.terminalError = err;
		}
		const waiter = this.waiter;
		if (waiter !== undefined) {
			clearTimeout(waiter.timer);
			this.waiter = undefined;
			waiter.reject(err);
		}
	}

	private wrap(phase: SmtpPhase, cause: Error, secured: boolean): SmtpError {
		if (cause instanceof SmtpError) {
			return cause;
		}
		return new SmtpError({
			phase,
			message: `SMTP connection failed: ${cause.message}`,
			secured,
			cause,
		});
	}
}
