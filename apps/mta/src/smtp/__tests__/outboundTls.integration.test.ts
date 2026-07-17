/**
 * Integration test for the outbound TLS floor (PR-23 / RFC 8996, RFC 9325).
 *
 * Spins up a real local STARTTLS SMTP server that is restricted to a MAXIMUM TLS
 * version of 1.1, then drives a delivery through the real {@link SmtpConnectionPool}
 * + @owlat/smtp-client with the pinned `minVersion: 'TLSv1.2'`. Because the server
 * cannot speak >= 1.2 and the client refuses < 1.2, the STARTTLS handshake has no
 * common protocol version and delivery must fail — proving the floor is enforced
 * end to end and never silently negotiates down to a deprecated TLS version. The
 * 1.2 server proves the floor is met, not over-strict.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import { SmtpConnectionPool } from '../connectionPool.js';
import { deliver } from './loopbackMxHarness.js';

// Throwaway self-signed cert/key, used ONLY by this test's loopback server.
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDCzCCAfOgAwIBAgIUIexTohNreQzk0XWjNfC/AYW+7nUwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDYyMTE2MDY0MFoYDzIxMjYw
NTI4MTYwNjQwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDAT/G+jjHxKc0W9LuSsqfvXYFTXA6TTnc2IQP10GJR
OFkP0WB6rvA7C/t4AcyBswZPzAx/Uxk+SHhit07ZB23dDA9pYj6tw0xayQBpmHBG
YZuYm+u+GXliWo1DdhyV9Er7jTu/BKiuxEqqotQcRhEMGFl+5ic01SAYUcqHIgE7
R/YsMhz5lQT3p1sHbOy+r3mvIdrmsStER3RvS+QADxtweNSUiW7Lt8P1EOyzdj0n
L9LineULAA6R+ve+rS4vDIQyqtBQ6Myb8tNp/2GszhF2MCmBk2kSVRkPnP45bwUE
8DL4lOJ/2G9lYENTnDhIerl7oLvD9d2pKAl6NC4ftJRlAgMBAAGjUzBRMB0GA1Ud
DgQWBBTex8uKwiFq8LienD1p7RMbx8Hk3DAfBgNVHSMEGDAWgBTex8uKwiFq8Lie
nD1p7RMbx8Hk3DAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQCF
LMVTtCxbItNPpP23gnlsXOKhLwyoiul1dREE3Xay3r0mk0nJPVFyXa4niPM6lD38
rk2/DCNSSKhXaacpER8AEPMgvHDYmPohugLz5ZFN9bjVVZ4GMXbDTsUrGHzjOBBn
KieE6F7N3oN0R1pPZkEUljz8X6kJnVRWJZRZt1R8uVXz/YIgOcve+1Kl5N8ULcXv
3xlZSA2/HTnqNsOxoNHCX1ZRyEFW9xhMS6lmpIz9YLeWM027irucdRb8EC14MUlR
UGw9Y5rKhLU+/e8XAuMPhrE3p2bSNBcx1t8OguQuvR+HLqdVm8mqn00pR1JgcGiX
9N4+GRtyaQk06wlkJcqY
-----END CERTIFICATE-----`;

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDAT/G+jjHxKc0W
9LuSsqfvXYFTXA6TTnc2IQP10GJROFkP0WB6rvA7C/t4AcyBswZPzAx/Uxk+SHhi
t07ZB23dDA9pYj6tw0xayQBpmHBGYZuYm+u+GXliWo1DdhyV9Er7jTu/BKiuxEqq
otQcRhEMGFl+5ic01SAYUcqHIgE7R/YsMhz5lQT3p1sHbOy+r3mvIdrmsStER3Rv
S+QADxtweNSUiW7Lt8P1EOyzdj0nL9LineULAA6R+ve+rS4vDIQyqtBQ6Myb8tNp
/2GszhF2MCmBk2kSVRkPnP45bwUE8DL4lOJ/2G9lYENTnDhIerl7oLvD9d2pKAl6
NC4ftJRlAgMBAAECggEAMA6KMX0lG8e/WWI00VbVwmoSXDtf5Q2xmpQrgizdtMAo
+VvwCRhYLdkzsOx6J1sOU7iA0vx4DWlctAZsrK0/lgJig4oqcY+hL/qUoM6YF+5i
TIOCKJIDFEHelSIZyJswdaX4bSaD5JBmvDdOW/ZiYixfiOeImpo7l/gwbQ5hUmec
l+OAShKrepsIclq98/PfAmwfBjV67xSzE9nzXdAsk8o+99BLIRBTvBquKlD7Uovg
VsiYGxqhitKNwiMyvUyrZrrbxtgpvSBHhzdnrN4RKq9SHm39yomjFD1GP9GhNwgr
x/51bCVt/luOfpafVGveV4hBjPgDKehsJ7atNb+SAQKBgQD37Bit3/faaPK2OhP9
bk3v+sNimMEaBZOLFOaDUTruu7SkeuO8mVZ5Wmubxm5KTmAwPmUFtpUX4ap9uFvO
TC9aqYik57o0foj8iamDZ2iYgwZ+P81riRdDAvMs7W8TEASSPHM45aTjWuqNzd8v
ivSAKa1W0ktPkqapJOD3vuUMgQKBgQDGlAI72bZXGnniKoJenca06+wGAB2JpaCi
nHR9duvlvSXPvt64qaiDMxxU3XmoupeI9sYrOe0eVtZOVsZZLCOKbiItYpYdGs17
KFICSD7Qlb2ANhBExureghU/F6Kzn3S8eoGGa+8T/i4qSe4GbRiiR9PlKsqNDrYt
20KI3CHl5QKBgQC6ZYa0i3Q0gL0ipo3K97ifGeD2azSblN+2LLOWvWbagMOy+jXo
4TxzprjK+KiJM138R5z6a6iyuNbPCOH1O7BKsLXsjdCgkRX7EKEjC4dHSxOBrgSK
uhqEJl6gQ69EHMHjFJHokDelPACnNsZ7XzSueyc45Ij8vZySBQkjGyHogQKBgHRs
HC8owj2pGSJfF9YPHIu/8b3G3Ypw34/WuHlCeqVT0tJMrlmHpnNdSNP8kTI6S1OS
kraPHJT4BmcheuKW/TNQxJrlPOtNZoE5L3OFFcbGs7Zye/FGyjav/3LhEZPL/e3u
yPedWirXkAtdEr8TwSiLghDOmLhAktCpxwVkQj99AoGAS6Tj3ca8WRLCFGzPwvmc
lmzgSsRZPmuP4HFxhsGCjLXTyuucKUDzo9EzRg7Wl0j2EKOZd4gQabBSMKRbojVy
gEqOIXVIiJQgm079dJerivHT0Sff3o0ong4EhDzT0I9JQmugPuwyUDYArYGYNWnX
waiSQp1spNfmCGgw7qotcmY=
-----END PRIVATE KEY-----`;

async function startServer(maxVersion: 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3'): Promise<{
	server: SMTPServer;
	port: number;
}> {
	const server = new SMTPServer({
		secure: false, // STARTTLS upgrade (matches outbound port-25 path)
		authOptional: true,
		disabledCommands: ['AUTH'],
		cert: TEST_CERT,
		key: TEST_KEY,
		minVersion: 'TLSv1', // allow the server itself to go as low as 1.0/1.1
		maxVersion,
		...(maxVersion === 'TLSv1.1' ? { ciphers: 'DEFAULT@SECLEVEL=0' } : {}),
		onData(stream, _session, callback) {
			stream.on('data', () => {});
			stream.on('end', () => callback());
		},
	});
	server.on('error', () => {});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
	const port = (server.server.address() as AddressInfo).port;
	return { server, port };
}

function stopServer(server: SMTPServer): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

describe('outbound STARTTLS TLS-version floor (PR-23)', () => {
	let pool: SmtpConnectionPool | undefined;
	let server: SMTPServer | undefined;

	afterEach(async () => {
		if (pool) await pool.closeAll(500);
		if (server) await stopServer(server);
		pool = undefined;
		server = undefined;
	});

	it('fails delivery to a STARTTLS server that only offers TLS <= 1.1 (pool pins minVersion 1.2, no sub-1.2 negotiation)', async () => {
		const started = await startServer('TLSv1.1');
		server = started.server;
		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });

		// Caller passes a tls block WITHOUT minVersion — the pool injects the
		// 'TLSv1.2' floor. The client refuses < 1.2, so the STARTTLS handshake has no
		// common version and the connection fails closed rather than downgrading.
		await expect(
			deliver(pool, {
				port: started.port,
				requireTLS: true, // force the STARTTLS upgrade rather than fall back to plaintext
				tls: { rejectUnauthorized: false },
				connectionTimeout: 5000,
				greetingTimeout: 5000,
				socketTimeout: 5000,
			})
		).rejects.toThrow();
	}, 15000);

	it('succeeds against a STARTTLS server that offers TLS 1.2 (floor is met, not over-strict)', async () => {
		const started = await startServer('TLSv1.2');
		server = started.server;
		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });

		const result = await deliver(pool, {
			port: started.port,
			requireTLS: true,
			tls: { rejectUnauthorized: false },
			connectionTimeout: 5000,
			greetingTimeout: 5000,
			socketTimeout: 5000,
		});

		expect(result.accepted.map((v) => v.recipient)).toContain('recipient@example.test');
	}, 15000);
});
