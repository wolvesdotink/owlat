import { describe, expect, it } from 'vitest';
import { HARDENED_SERVER_TLS_OPTIONS } from '../tlsPolicy';

describe('HARDENED_SERVER_TLS_OPTIONS', () => {
	// IMAPS and every SMTP listener present this policy. A change here changes
	// the wire posture of ports 25, 465, 587 and 993 at once, so it has to be a
	// deliberate edit of this snapshot too.
	it('pins the TLS floor, the AEAD-only suite list and the server cipher order', () => {
		expect(HARDENED_SERVER_TLS_OPTIONS).toMatchInlineSnapshot(`
			{
			  "ciphers": "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305",
			  "honorCipherOrder": true,
			  "minVersion": "TLSv1.2",
			}
		`);
	});

	it('lists only ECDHE suites with an AEAD mode', () => {
		for (const suite of HARDENED_SERVER_TLS_OPTIONS.ciphers.split(':')) {
			expect(suite).toMatch(
				/^ECDHE-(ECDSA|RSA)-(AES(128|256)-GCM-SHA(256|384)|CHACHA20-POLY1305)$/
			);
		}
	});
});
