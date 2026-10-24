/**
 * The receiving MX for the MTA kill test: a plaintext SMTP server on port 25
 * that records every transaction and can withhold one reply on command.
 *
 * Two hold points pin the sender inside the two windows the MTA journal
 * distinguishes:
 *   - `data`: the DATA command arrived and the 354 is never sent, so not one
 *     body byte has crossed the wire. A sender killed here must resend after a
 *     restart, and the sink must still end up with exactly one body.
 *   - `dot`:  the whole body and its terminating dot arrived and the final
 *     reply is never sent. A real receiver has committed the message at this
 *     point, so the body counts as received, and the sender cannot know it:
 *     it must classify the attempt as ambiguous and never resend.
 *
 * A rule fires once. The redelivery after the restart then runs unhindered.
 */

import { createServer, type Server, type Socket } from 'node:net';
import type { EventLog } from './events';

export type HoldPoint = 'data' | 'dot';

export interface HoldRule {
	/** Envelope recipient the rule applies to (lower-cased on match). */
	readonly rcpt: string;
	readonly point: HoldPoint;
}

export interface SinkTransaction {
	readonly session: number;
	readonly mailFrom: string;
	readonly rcpts: string[];
	/** Where the transaction stopped. `held-*` ends only when the peer drops. */
	state: 'envelope' | 'held-data' | 'body' | 'accepted' | 'held-dot' | 'aborted';
	/** True once the body and its terminating dot arrived: the receiver has the message. */
	bodyReceived: boolean;
}

const GREETING = '220 mx.sink.owlat.test ESMTP kill-test sink';
const BODY_END = '\r\n.\r\n';

export class SmtpSink {
	readonly transactions: SinkTransaction[] = [];
	private rules: HoldRule[] = [];
	private sessions = 0;
	private readonly sockets = new Set<Socket>();
	private server: Server | undefined;

	constructor(private readonly events: EventLog) {}

	arm(rules: readonly HoldRule[]): void {
		this.rules.push(...rules.map((rule) => ({ ...rule, rcpt: rule.rcpt.toLowerCase() })));
	}

	listen(port: number): Promise<void> {
		this.server = createServer((socket) => this.session(socket));
		return new Promise((resolve) => this.server!.listen(port, '0.0.0.0', resolve));
	}

	close(): void {
		for (const socket of this.sockets) socket.destroy();
		this.server?.close();
	}

	/** Bodies received per recipient: the duplicate-delivery oracle reads this. */
	bodiesFor(rcpt: string): number {
		const wanted = rcpt.toLowerCase();
		return this.transactions.filter((t) => t.bodyReceived && t.rcpts.includes(wanted)).length;
	}

	private takeRule(rcpts: readonly string[], point: HoldPoint): HoldRule | undefined {
		const index = this.rules.findIndex((rule) => rule.point === point && rcpts.includes(rule.rcpt));
		if (index < 0) return undefined;
		return this.rules.splice(index, 1)[0];
	}

	private session(socket: Socket): void {
		const session = ++this.sessions;
		this.sockets.add(socket);
		socket.setEncoding('latin1');
		let buffer = '';
		let current: SinkTransaction | undefined;
		let mode: 'command' | 'body' | 'held' = 'command';
		let body = '';
		const reply = (line: string) => {
			if (!socket.destroyed) socket.write(`${line}\r\n`);
		};
		const close = () => {
			this.sockets.delete(socket);
			if (current && current.state !== 'accepted') {
				if (current.state === 'envelope' || current.state === 'body') current.state = 'aborted';
				for (const rcpt of current.rcpts) this.events.emit(`smtp.dropped:${rcpt}`, { session });
			}
		};
		socket.on('close', close);
		socket.on('error', () => socket.destroy());

		const command = (line: string) => {
			const verb = line.slice(0, 4).toUpperCase();
			if (verb === 'EHLO')
				return reply('250-mx.sink.owlat.test\r\n250-8BITMIME\r\n250 SIZE 52428800');
			if (verb === 'HELO') return reply('250 mx.sink.owlat.test');
			if (verb === 'NOOP') return reply('250 2.0.0 OK');
			if (verb === 'RSET') {
				if (current && current.state === 'envelope') current.state = 'aborted';
				current = undefined;
				return reply('250 2.0.0 OK');
			}
			if (verb === 'QUIT') {
				reply('221 2.0.0 Bye');
				socket.end();
				return;
			}
			if (verb === 'MAIL') {
				const mailFrom = /<([^>]*)>/.exec(line)?.[1] ?? '';
				current = { session, mailFrom, rcpts: [], state: 'envelope', bodyReceived: false };
				this.transactions.push(current);
				return reply('250 2.1.0 OK');
			}
			if (verb === 'RCPT') {
				const rcpt = /<([^>]*)>/.exec(line)?.[1]?.toLowerCase();
				if (!current || !rcpt) return reply('503 5.5.1 MAIL first');
				current.rcpts.push(rcpt);
				return reply('250 2.1.5 OK');
			}
			if (verb === 'DATA') {
				if (!current || current.rcpts.length === 0) return reply('503 5.5.1 RCPT first');
				const rule = this.takeRule(current.rcpts, 'data');
				if (rule) {
					current.state = 'held-data';
					mode = 'held';
					this.events.emit(`smtp.held:${rule.rcpt}`, { session, point: 'data' });
					return;
				}
				current.state = 'body';
				mode = 'body';
				body = '';
				return reply('354 End data with <CR><LF>.<CR><LF>');
			}
			reply('502 5.5.2 Command not implemented');
		};

		const finishBody = () => {
			const transaction = current!;
			transaction.bodyReceived = true;
			mode = 'command';
			for (const rcpt of transaction.rcpts) {
				this.events.emit(`smtp.body:${rcpt}`, { session, count: this.bodiesFor(rcpt) });
			}
			const rule = this.takeRule(transaction.rcpts, 'dot');
			if (rule) {
				transaction.state = 'held-dot';
				mode = 'held';
				this.events.emit(`smtp.held:${rule.rcpt}`, { session, point: 'dot' });
				return;
			}
			transaction.state = 'accepted';
			current = undefined;
			reply('250 2.0.0 OK queued');
		};

		socket.on('data', (chunk: string) => {
			buffer += chunk;
			// `command` and `finishBody` switch `mode`; a hold stops reading for good.
			for (;;) {
				if (mode === 'held') return;
				if (mode === 'body') {
					// The body starts right after DATA's CRLF, so prefix one to match a
					// dot on the very first line too.
					const scan = `\r\n${body}${buffer}`;
					const end = scan.indexOf(BODY_END);
					if (end < 0) {
						body += buffer;
						buffer = '';
						return;
					}
					const consumed = end + BODY_END.length - 2 - body.length;
					body = '';
					buffer = buffer.slice(consumed);
					finishBody();
					continue;
				}
				const newline = buffer.indexOf('\r\n');
				if (newline < 0) return;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 2);
				command(line);
			}
		});

		reply(GREETING);
	}
}
