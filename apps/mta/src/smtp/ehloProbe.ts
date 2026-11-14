/**
 * One EHLO exchange with a remote MX, to read the client address it saw.
 *
 * Large receivers name the connecting address in their EHLO greeting
 * (`250-mx.google.com at your service, [192.0.2.7]`,
 * `250-…outlook.com Hello [192.0.2.7]`). Behind NAT that bracketed address is
 * the only view of the translated source the MTA can get without asking a
 * third-party "what is my IP" service, and it is exactly the address the
 * receiver will run PTR, SPF and blocklist checks against.
 *
 * The exchange sends EHLO and QUIT and nothing else: no MAIL FROM, no message.
 */

import { createConnection } from 'node:net';
import { normalizeIpAddress } from '@owlat/shared/ipAddress';

/** A greeting or EHLO reply longer than this is not an SMTP server worth reading. */
const MAX_REPLY_BYTES = 16 * 1024;

export interface EhloExchangeArgs {
	host: string;
	port: number;
	/** Omitted when the kernel picks the source address (behind NAT). */
	localAddress?: string;
	ehloName: string;
	timeoutMs: number;
}

/** Resolves with the lines of the remote's EHLO reply, or rejects with a coded error. */
export type EhloExchange = (args: EhloExchangeArgs) => Promise<string[]>;

/**
 * The client address a receiver names in the first line of its EHLO reply, or
 * `null` when it names none or more than one. Accepts `[192.0.2.7]`,
 * `[2001:db8::7]` and the RFC 5321 address literal `[IPv6:2001:db8::7]`.
 */
export function parseEhloClientAddress(replyLines: readonly string[]): string | null {
	const first = replyLines[0];
	if (first === undefined || !/^250[ -]/.test(first)) return null;
	const found = new Set<string>();
	for (const match of first.matchAll(/\[(?:IPv6:)?([0-9A-Fa-f:.]+)\]/g)) {
		const address = normalizeIpAddress(match[1] ?? '');
		if (address) found.add(address);
	}
	return found.size === 1 ? [...found][0]! : null;
}

function codedError(message: string, code: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}

/**
 * Read one complete SMTP reply (every `NNN-` continuation line and the final
 * `NNN ` line) from `buffer`, or return null when it is not complete yet.
 */
function takeReply(buffer: string): { lines: string[]; rest: string } | null {
	const lines: string[] = [];
	let offset = 0;
	for (;;) {
		const end = buffer.indexOf('\n', offset);
		if (end === -1) return null;
		const line = buffer.slice(offset, end).replace(/\r$/, '');
		offset = end + 1;
		lines.push(line);
		if (/^\d{3}(?: |$)/.test(line)) return { lines, rest: buffer.slice(offset) };
		if (!/^\d{3}-/.test(line)) throw codedError('Malformed SMTP reply', 'EPROTO');
	}
}

export const ehloExchange: EhloExchange = ({ host, port, localAddress, ehloName, timeoutMs }) =>
	new Promise<string[]>((resolve, reject) => {
		const socket = createConnection({
			host,
			port,
			...(localAddress !== undefined ? { localAddress } : {}),
		});
		let buffer = '';
		let stage: 'greeting' | 'ehlo' | 'done' = 'greeting';
		const finish = (err: Error | null, lines?: string[]) => {
			if (stage === 'done') return;
			stage = 'done';
			if (err) {
				socket.destroy();
				reject(err);
				return;
			}
			// QUIT and stop: the reply to it carries nothing, and a remote that
			// never closes its side must not keep the socket alive.
			socket.end('QUIT\r\n');
			socket.destroySoon();
			resolve(lines ?? []);
		};

		// A hard deadline, not an idle timeout: a server that drips one byte at a
		// time must not hold the probe open for minutes.
		const deadline = setTimeout(() => {
			socket.destroy();
			finish(codedError('EHLO exchange timed out', 'ETIMEDOUT'));
		}, timeoutMs);
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			buffer += chunk;
			if (buffer.length > MAX_REPLY_BYTES) {
				finish(codedError('SMTP reply too long', 'EPROTO'));
				return;
			}
			try {
				const reply = takeReply(buffer);
				if (!reply) return;
				buffer = reply.rest;
				const code = reply.lines[reply.lines.length - 1]!.slice(0, 3);
				if (stage === 'greeting') {
					if (code !== '220') {
						finish(codedError(`SMTP greeting ${code}`, 'EPROTO'));
						return;
					}
					stage = 'ehlo';
					socket.write(`EHLO ${ehloName}\r\n`);
					return;
				}
				if (code !== '250') {
					finish(codedError(`EHLO answered ${code}`, 'EPROTO'));
					return;
				}
				finish(null, reply.lines);
			} catch (err) {
				finish(err as Error);
			}
		});
		socket.once('error', (err) => finish(err));
		socket.once('close', () => {
			clearTimeout(deadline);
			finish(codedError('Connection closed early', 'ECONNRESET'));
		});
	});
