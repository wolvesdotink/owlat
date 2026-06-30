import { describe, it, expect } from 'vitest';
import { isLocalMailHost } from '../mailHost';

describe('isLocalMailHost', () => {
	it('accepts loopback hosts (where plaintext is allowed)', () => {
		for (const h of [
			'localhost',
			'LOCALHOST',
			'localhost.', // trailing FQDN dot
			'127.0.0.1',
			'127.0.0.53',
			'::1',
			'[::1]',
			'0:0:0:0:0:0:0:1',
			'::ffff:127.0.0.1',
		]) {
			expect(isLocalMailHost(h)).toBe(true);
		}
	});

	it('rejects remote hosts (plaintext to these would leak credentials)', () => {
		for (const h of [
			'imap.gmail.com',
			'mail.example.com',
			'192.168.1.10', // private LAN is still remote-ish — TLS required
			'10.0.0.5',
			'8.8.8.8',
			'127.0.0.1.evil.com', // not actually loopback
			'',
		]) {
			expect(isLocalMailHost(h)).toBe(false);
		}
	});
});
