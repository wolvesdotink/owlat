import os from 'node:os';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildRelayClientConfig, relayEhloName } from '../index';

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

/**
 * The default EHLO identity when `EHLO_HOSTNAME` is unset. A container hostname is
 * a dotless hex token that strict relays reject (`reject_non_fqdn_helo_hostname`),
 * so the fallback must be the RFC 5321 §4.1.3 address literal — matching the
 * outbound path's preserved nodemailer `_getHostname()` behavior.
 */
describe('relayEhloName — non-FQDN fallback', () => {
	afterEach(() => vi.restoreAllMocks());

	it('falls back to [127.0.0.1] for a dotless (container) hostname', () => {
		vi.spyOn(os, 'hostname').mockReturnValue('a1b2c3d4e5f6');
		expect(relayEhloName()).toBe('[127.0.0.1]');
	});

	it('brackets a bare IPv4 hostname as an address literal', () => {
		vi.spyOn(os, 'hostname').mockReturnValue('10.0.0.5');
		expect(relayEhloName()).toBe('[10.0.0.5]');
	});

	it('passes a real FQDN through unchanged', () => {
		vi.spyOn(os, 'hostname').mockReturnValue('mail.relay.example.com');
		expect(relayEhloName()).toBe('mail.relay.example.com');
	});

	it('falls back when os.hostname() throws', () => {
		vi.spyOn(os, 'hostname').mockImplementation(() => {
			throw new Error('no hostname');
		});
		expect(relayEhloName()).toBe('[127.0.0.1]');
	});
});
