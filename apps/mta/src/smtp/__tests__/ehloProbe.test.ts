import { once } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ehloExchange, parseEhloClientAddress } from '../ehloProbe.js';

describe('parseEhloClientAddress', () => {
	it.each([
		['250-mx.google.com at your service, [192.0.2.7]', '192.0.2.7'],
		['250-BN8PR.outlook.com Hello [192.0.2.7]', '192.0.2.7'],
		['250 mx.example.net Hello mail.example.com [2001:db8::7]', '2001:db8::7'],
		['250-mx.example.net Hello [IPv6:2001:DB8::7]', '2001:db8::7'],
	])('reads the client address from %s', (line, expected) => {
		expect(parseEhloClientAddress([line, '250 SMTPUTF8'])).toBe(expected);
	});

	it.each([
		['no address', ['250-mx.example.net', '250 SIZE 1000']],
		['two addresses', ['250 mx [192.0.2.7] via [192.0.2.8]']],
		['a rejection', ['554 [192.0.2.7] listed']],
		['a later line only', ['250-mx.example.net', '250 X-CLIENT [192.0.2.7]']],
		['no reply', []],
	])('returns null for %s', (_label, lines) => {
		expect(parseEhloClientAddress(lines)).toBeNull();
	});
});

describe('ehloExchange', () => {
	let server: Server | undefined;

	afterEach(async () => {
		server?.close();
		if (server?.listening) await once(server, 'close');
		server = undefined;
	});

	async function listen(onConnection: (socket: Socket) => void): Promise<number> {
		server = createServer(onConnection);
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		return (server.address() as AddressInfo).port;
	}

	it('sends EHLO after the greeting, returns the full reply and QUITs', async () => {
		const received: string[] = [];
		let quit!: () => void;
		const quitSeen = new Promise<void>((resolve) => (quit = resolve));
		const port = await listen((socket) => {
			socket.setEncoding('utf8');
			socket.write('220-mx.example.net ESMTP\r\n220 ready\r\n');
			socket.on('data', (chunk: string) => {
				received.push(chunk);
				if (chunk.startsWith('EHLO')) {
					socket.write('250-mx.example.net Hello [192.0.2.7]\r\n');
					socket.write('250 SMTPUTF8\r\n');
				}
				if (chunk.includes('QUIT')) {
					socket.end('221 bye\r\n');
					quit();
				}
			});
		});

		const reply = await ehloExchange({
			host: '127.0.0.1',
			port,
			ehloName: 'mail.example.com',
			timeoutMs: 5_000,
		});

		expect(reply).toEqual(['250-mx.example.net Hello [192.0.2.7]', '250 SMTPUTF8']);
		await quitSeen;
		expect(received.join('')).toBe('EHLO mail.example.com\r\nQUIT\r\n');
	});

	it('rejects when the server refuses the session in its greeting', async () => {
		const port = await listen((socket) => socket.end('554 no service\r\n'));
		await expect(
			ehloExchange({ host: '127.0.0.1', port, ehloName: 'mail.example.com', timeoutMs: 5_000 })
		).rejects.toMatchObject({ code: 'EPROTO' });
	});

	it('rejects when the server closes before answering EHLO', async () => {
		const port = await listen((socket) => {
			socket.write('220 ready\r\n');
			socket.once('data', () => socket.destroy());
		});
		await expect(
			ehloExchange({ host: '127.0.0.1', port, ehloName: 'mail.example.com', timeoutMs: 5_000 })
		).rejects.toMatchObject({ code: 'ECONNRESET' });
	});
});
