import { describe, it, expect } from 'vitest';
import { buildRelayTransportOptions } from '../index';

/**
 * T1 — the generic SMTP-relay transport must pin a TLSv1.2 floor (RFC 8996/9325)
 * the same way the direct-MX connection pool does, and must keep enforcing the
 * STARTTLS upgrade on the cleartext-start (587) path so credentials + body can
 * never be stripped to plaintext. `buildRelayTransportOptions` is the pure seam
 * these invariants are asserted on (the network `getTransport` just wraps it).
 */
describe('buildRelayTransportOptions — TLS floor + STARTTLS enforcement', () => {
	it('pins minVersion TLSv1.2 and requires STARTTLS on the 587 (secure:false) path', () => {
		const opts = buildRelayTransportOptions({
			host: 'smtp.example.com',
			port: 587,
			secure: false,
			user: 'u',
			pass: 'p',
		});
		expect(opts.tls.minVersion).toBe('TLSv1.2');
		// secure:false starts cleartext, so the STARTTLS upgrade must be demanded.
		expect(opts.requireTLS).toBe(true);
		expect(opts.secure).toBe(false);
		expect(opts.host).toBe('smtp.example.com');
		expect(opts.port).toBe(587);
		expect(opts.auth).toEqual({ user: 'u', pass: 'p' });
	});

	it('still pins minVersion TLSv1.2 on the implicit-TLS (465, secure:true) path', () => {
		const opts = buildRelayTransportOptions({
			host: 'smtp.example.com',
			port: 465,
			secure: true,
			user: 'u',
			pass: 'p',
		});
		expect(opts.tls.minVersion).toBe('TLSv1.2');
		// Implicit TLS already opens encrypted, so STARTTLS-upgrade enforcement is
		// not applicable — but the version floor still applies to the TLS socket.
		expect(opts.requireTLS).toBe(false);
		expect(opts.secure).toBe(true);
	});
});
