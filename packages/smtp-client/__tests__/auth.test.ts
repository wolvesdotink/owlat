/**
 * The cleartext AUTH gate, without a socket: `authenticate` derives loopback
 * from `conn.remoteAddress` through the shared `isLoopbackIp`, so every
 * spelling of a loopback peer is allowed and nothing else is.
 */

import { describe, expect, it, vi } from 'vitest';
import { authenticate } from '../src/auth';
import type { SmtpConnection } from '../src/connection';

function fakeConnection(remoteAddress: string | undefined) {
	const command = vi.fn(async () => ({ code: 235, lines: ['ok'], text: 'ok' }));
	const conn = {
		secured: false,
		remoteAddress,
		capabilities: { authMechanisms: new Set(['PLAIN']) },
		command,
	} as unknown as SmtpConnection;
	return { conn, command };
}

const credentials = { username: 'relay', password: 's3cret' };

describe('authenticate on an unsecured connection', () => {
	it.each(['127.0.0.1', '127.0.0.2', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1'])(
		'sends credentials to the loopback peer %s',
		async (address) => {
			const { conn, command } = fakeConnection(address);
			await authenticate(conn, credentials);
			expect(command).toHaveBeenCalledOnce();
		}
	);

	it.each([undefined, '10.0.0.1', '::ffff:10.0.0.1', '203.0.113.5', '2001:db8::1', 'localhost'])(
		'refuses before serializing for the non-loopback peer %s',
		async (address) => {
			const { conn, command } = fakeConnection(address);
			await expect(authenticate(conn, credentials)).rejects.toThrow(
				'refusing AUTH on an unsecured, non-loopback connection'
			);
			expect(command).not.toHaveBeenCalled();
		}
	);

	it('lets `loopback: false` force the strict rule on a loopback peer', async () => {
		const { conn, command } = fakeConnection('127.0.0.1');
		await expect(authenticate(conn, credentials, { loopback: false })).rejects.toThrow(
			'non-loopback'
		);
		expect(command).not.toHaveBeenCalled();
	});
});
