import { describe, it, expect } from 'vitest';
import type { ReplyWriteSocket } from '../commandLoop.js';
import { writeReplyWithinBudget } from '../commandLoop.js';
import { serializeReply, replyBytes, Reply, SmtpReplyError } from '../reply.js';

describe('serializeReply', () => {
	it('serializes a byte-exact enhanced status reply (552 5.2.2 ...)', () => {
		expect(serializeReply({ code: 552, enhanced: '5.2.2', text: 'mailbox full' })).toBe(
			'552 5.2.2 mailbox full\r\n'
		);
	});

	it('emits just the code + enhanced when text is empty', () => {
		expect(serializeReply({ code: 552, enhanced: '5.2.2', text: '' })).toBe('552 5.2.2\r\n');
	});

	it('emits just the code when there is neither enhanced code nor text', () => {
		expect(serializeReply({ code: 220, text: '' })).toBe('220\r\n');
	});

	it('serializes a plain (non-enhanced) single line', () => {
		expect(serializeReply({ code: 220, text: 'mx.owlat.app ESMTP' })).toBe(
			'220 mx.owlat.app ESMTP\r\n'
		);
	});

	it('serializes a multiline EHLO reply with code- continuation and code space last', () => {
		expect(
			serializeReply({ code: 250, text: ['mx greets you', 'PIPELINING', 'SIZE 10485760'] })
		).toBe('250-mx greets you\r\n250-PIPELINING\r\n250 SIZE 10485760\r\n');
	});

	it('repeats the enhanced code on every line of a multiline reply', () => {
		expect(serializeReply({ code: 250, enhanced: '2.1.0', text: ['first', 'second'] })).toBe(
			'250-2.1.0 first\r\n250 2.1.0 second\r\n'
		);
	});

	it('treats an empty text array as a single code-only line', () => {
		expect(serializeReply({ code: 250, text: [] })).toBe('250\r\n');
	});

	it('replyBytes returns the same bytes as serializeReply as UTF-8', () => {
		const reply = { code: 501, enhanced: '5.5.4', text: 'bad args' };
		expect(replyBytes(reply)).toEqual(Buffer.from(serializeReply(reply), 'utf8'));
	});
});

describe('Reply table (real RFC 3463 enhanced codes)', () => {
	const cases: Array<[string, string]> = [
		[serializeReply(Reply.greeting('mx.owlat.app ESMTP')), '220 mx.owlat.app ESMTP\r\n'],
		[serializeReply(Reply.ok()), '250 2.0.0 OK\r\n'],
		[serializeReply(Reply.senderOk()), '250 2.1.0 OK\r\n'],
		[serializeReply(Reply.recipientOk()), '250 2.1.5 OK\r\n'],
		[serializeReply(Reply.dataAccepted()), '250 2.0.0 OK: message accepted\r\n'],
		[serializeReply(Reply.startMailInput()), '354 Start mail input; end with <CRLF>.<CRLF>\r\n'],
		[serializeReply(Reply.bye('mx.owlat.app')), '221 2.0.0 mx.owlat.app closing connection\r\n'],
		[serializeReply(Reply.syntaxError()), '500 5.5.2 Syntax error, command unrecognized\r\n'],
		[serializeReply(Reply.paramError()), '501 5.5.4 Syntax error in parameters or arguments\r\n'],
		[serializeReply(Reply.notImplemented()), '502 5.5.1 Command not implemented\r\n'],
		[serializeReply(Reply.badSequence()), '503 5.5.1 Bad sequence of commands\r\n'],
		[serializeReply(Reply.localError()), '451 4.3.0 Local error in processing\r\n'],
		[serializeReply(Reply.tooManyErrors()), '421 4.7.0 Too many errors, closing connection\r\n'],
		[
			serializeReply(Reply.tooManyMailCommands()),
			'421 4.7.0 Too many MAIL commands, closing connection\r\n',
		],
		[
			serializeReply(Reply.shuttingDown('mx.owlat.app')),
			'421 4.4.2 mx.owlat.app timeout, closing connection\r\n',
		],
	];

	it.each(cases)('serializes %s', (actual, expected) => {
		expect(actual).toBe(expected);
	});

	it('messageTooLarge reports the limit in MB with the 552 5.3.4 code', () => {
		expect(serializeReply(Reply.messageTooLarge(10 * 1024 * 1024))).toBe(
			'552 5.3.4 Message exceeds maximum size of 10MB\r\n'
		);
	});

	it('startMailInput carries no enhanced code (354 is a non-enhanced reply)', () => {
		expect(Reply.startMailInput().enhanced).toBeUndefined();
	});
});

describe('SmtpReplyError', () => {
	it('carries the reply and a text message', () => {
		const err = new SmtpReplyError({ code: 550, enhanced: '5.7.1', text: 'blocked' });
		expect(err).toBeInstanceOf(Error);
		expect(err.reply.code).toBe(550);
		expect(err.message).toBe('blocked');
	});

	it('joins multiline reply text for the Error message', () => {
		const err = new SmtpReplyError({ code: 550, text: ['a', 'b'] });
		expect(err.message).toBe('a b');
	});
});

describe('bounded socket reply writes', () => {
	function fakeSocket(writableLength: number): {
		socket: ReplyWriteSocket;
		writes: Buffer[];
		wasDestroyed: () => boolean;
	} {
		const writes: Buffer[] = [];
		let destroyed = false;
		return {
			socket: {
				writableEnded: false,
				get destroyed() {
					return destroyed;
				},
				writableLength,
				write: (bytes) => {
					writes.push(bytes);
					return false;
				},
				destroy: () => {
					destroyed = true;
				},
			},
			writes,
			wasDestroyed: () => destroyed,
		};
	}

	it('destroys instead of crossing the pending-reply byte ceiling', () => {
		const { socket, writes, wasDestroyed } = fakeSocket(64);
		expect(writeReplyWithinBudget(socket, Reply.ok(), 64)).toBe(false);
		expect(writes).toHaveLength(0);
		expect(wasDestroyed()).toBe(true);
	});

	it('allows a reply that fits exactly at the ceiling', () => {
		const { socket, writes, wasDestroyed } = fakeSocket(10);
		const serializedBytes = Buffer.byteLength(serializeReply(Reply.ok()));
		expect(writeReplyWithinBudget(socket, Reply.ok(), 10 + serializedBytes)).toBe(true);
		expect(writes).toHaveLength(1);
		expect(wasDestroyed()).toBe(false);
	});
});
