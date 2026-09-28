/**
 * Runtime certificate swap (`SmtpListener.updateTlsMaterial`) over real
 * sockets: a renewed certificate reaches the next STARTTLS upgrade and the next
 * implicit-TLS handshake, an already-encrypted session is left alone, and a bad
 * pair is refused without disturbing the certificate in service.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client, closeAllListeners, generateCert, startListener } from './tlsTestUtil.js';

let oldPair: { cert: string; key: string };
let newPair: { cert: string; key: string };

beforeAll(() => {
	oldPair = generateCert('old.mx.test');
	newPair = generateCert('new.mx.test');
}, 30000);

afterEach(closeAllListeners);

async function starttlsClient(port: number): Promise<Client> {
	const c = await Client.connect(port);
	await c.waitCode(220);
	c.write('EHLO client.test\r\n');
	await c.waitCode(250);
	c.write('STARTTLS\r\n');
	await c.waitCode(220);
	await c.startTls('mx.test');
	return c;
}

describe('updateTlsMaterial on a STARTTLS listener', () => {
	it('serves the new certificate to the next upgrade and keeps existing sessions', async () => {
		const { listener, port } = await startListener({ hostname: 'mx.test', tls: oldPair });

		const before = await starttlsClient(port);
		expect(before.peerCertificate?.subject.CN).toBe('old.mx.test');

		listener.updateTlsMaterial(newPair);

		const after = await starttlsClient(port);
		expect(after.peerCertificate?.subject.CN).toBe('new.mx.test');

		// The session that negotiated before the swap still works on its old context.
		before.write('NOOP\r\n');
		await before.waitCode(250);
		expect(before.peerCertificate?.subject.CN).toBe('old.mx.test');
	});

	it('refuses a mismatched pair and keeps serving the current certificate', async () => {
		const { listener, port } = await startListener({ hostname: 'mx.test', tls: oldPair });

		expect(() => listener.updateTlsMaterial({ cert: newPair.cert, key: oldPair.key })).toThrow();

		const c = await starttlsClient(port);
		expect(c.peerCertificate?.subject.CN).toBe('old.mx.test');
	});

	it('refuses to add TLS to a listener created without it', async () => {
		const { listener } = await startListener({ hostname: 'mx.test' });
		expect(() => listener.updateTlsMaterial(newPair)).toThrow(/without tls/);
	});
});

describe('updateTlsMaterial on an implicit-TLS listener', () => {
	it('serves the new certificate to the next handshake', async () => {
		const { listener, port } = await startListener({
			hostname: 'mx.test',
			tls: oldPair,
			implicitTls: true,
		});

		const before = await Client.connectTls(port);
		expect(before.peerCertificate?.subject.CN).toBe('old.mx.test');
		await before.waitCode(220);

		listener.updateTlsMaterial(newPair);

		const after = await Client.connectTls(port);
		expect(after.peerCertificate?.subject.CN).toBe('new.mx.test');
		await after.waitCode(220);
	});
});
