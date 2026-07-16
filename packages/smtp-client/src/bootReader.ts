/**
 * The short-lived reply reader that drives a connection's OPENING handshake —
 * greeting, EHLO, STARTTLS, re-EHLO — before the persistent {@link SmtpConnection}
 * reader takes over.
 *
 * It owns exactly one `data` listener at a time, follows the socket across a
 * STARTTLS upgrade (via {@link BootReader.pauseSource} + {@link BootReader.rebind}),
 * and — on {@link BootReader.detach} — surrenders its {@link ReplyParser} (with any
 * buffered bytes) to the connection so no reply is dropped in the handoff.
 */

import type net from 'node:net';

import { SmtpError, type SmtpPhase } from './errors';
import { ReplyParser, type SmtpReply } from './reply';

export class BootReader {
	private source: net.Socket;
	private readonly parser = new ReplyParser();
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

	read(phase: SmtpPhase, timeoutMs: number, secured: boolean): Promise<SmtpReply> {
		const queued = this.queue.shift();
		if (queued !== undefined) {
			return Promise.resolve(queued);
		}
		if (this.terminalError !== undefined) {
			return Promise.reject(this.wrap(phase, this.terminalError, secured));
		}
		return new Promise<SmtpReply>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiter = undefined;
				reject(
					new SmtpError({
						phase,
						message: `timed out after ${timeoutMs}ms waiting for an SMTP reply`,
						secured,
					})
				);
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

	/** Surrender the ReplyParser (with buffered bytes) to the persistent reader. */
	detach(): ReplyParser {
		this.pauseSource();
		if (this.waiter !== undefined) {
			clearTimeout(this.waiter.timer);
			this.waiter = undefined;
		}
		return this.parser;
	}

	/** Tear down without handing anything off (error path). */
	dispose(): void {
		this.pauseSource();
		if (this.waiter !== undefined) {
			clearTimeout(this.waiter.timer);
			this.waiter = undefined;
		}
	}

	private bind(socket: net.Socket): void {
		socket.on('data', this.onData);
		socket.on('error', this.onError);
		socket.on('close', this.onClose);
	}

	private feed(chunk: Buffer): void {
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
