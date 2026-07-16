import { describe, it, expect } from 'vitest';
import { buildRelayClientConfig } from '../index';

/**
 * T1 — the generic SMTP-relay client must pin a TLSv1.2 floor (RFC 8996/9325)
 * the same way the direct-MX connection pool does, and must keep enforcing the
 * STARTTLS upgrade on the cleartext-start (587) path so credentials + body can
 * never be stripped to plaintext. `buildRelayClientConfig` is the pure seam
 * these invariants are asserted on (the network `getClientConfig` just wraps it,
 * and `sendMessage` fails closed with `starttls-unavailable` when `requireTls`
 * holds but the relay omits STARTTLS).
 */
describe('buildRelayClientConfig — TLS floor + STARTTLS enforcement', () => {
	it('pins minVersion TLSv1.2 and requires STARTTLS on the 587 (secure:false) path', () => {
		const { connect, auth } = buildRelayClientConfig({
			host: 'smtp.example.com',
			port: 587,
			secure: false,
			user: 'u',
			pass: 'p',
			ehloName: 'relay.owlat.test',
		});
		expect(connect.tls?.minVersion).toBe('TLSv1.2');
		// secure:false starts cleartext, so the STARTTLS upgrade must be demanded —
		// the client fails closed if the relay does not offer it.
		expect(connect.tlsMode).toBe('starttls');
		expect(connect.requireTls).toBe(true);
		expect(connect.host).toBe('smtp.example.com');
		expect(connect.port).toBe(587);
		expect(connect.ehloName).toBe('relay.owlat.test');
		expect(auth.credentials).toEqual({ username: 'u', password: 'p' });
	});

	it('still pins minVersion TLSv1.2 on the implicit-TLS (465, secure:true) path', () => {
		const { connect } = buildRelayClientConfig({
			host: 'smtp.example.com',
			port: 465,
			secure: true,
			user: 'u',
			pass: 'p',
			ehloName: 'relay.owlat.test',
		});
		expect(connect.tls?.minVersion).toBe('TLSv1.2');
		// Implicit TLS already opens encrypted (TLS from byte zero), so a separate
		// STARTTLS-upgrade requirement is not applicable — but the version floor
		// still applies to the TLS socket.
		expect(connect.tlsMode).toBe('implicit');
		expect(connect.requireTls).toBe(false);
	});

	it('bounds the pre-acceptance (connect + greeting) phase so an unreachable relay fails retryably', () => {
		const { connect } = buildRelayClientConfig({
			host: 'smtp.example.com',
			port: 587,
			secure: false,
			user: 'u',
			pass: 'p',
			ehloName: 'relay.owlat.test',
		});
		expect(connect.timeouts?.connect).toBe(15_000);
		expect(connect.timeouts?.greeting).toBe(15_000);
	});
});
