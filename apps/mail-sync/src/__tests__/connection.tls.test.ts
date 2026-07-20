/**
 * Integration regression-lock for the outbound client TLS posture (audit PR-75).
 *
 * These tests stand up REAL TLS / TCP servers and drive the REAL imapflow +
 * @owlat/smtp-client code paths (via sendViaExternal and direct ImapFlow
 * construction with the production imapTlsOptions/smtpTlsOptions). They prove the
 * wire behaviour, not just the option shape:
 *
 *  §1 cert-verify ON  — a self-signed cert on a non-loopback host is rejected
 *                       (DEPTH_ZERO_SELF_SIGNED_CERT / "self-signed certificate").
 *  §2 no-downgrade    — a server that doesn't offer STARTTLS makes the client
 *                       FAIL rather than send AUTH / MAIL FROM in cleartext.
 *
 * A non-loopback hostname ("imap.regress.invalid" / "smtp.regress.invalid") is
 * used so the production TLS gate (imapTlsOptions/smtpTlsOptions) pins TLS, and a
 * test-only DNS/lookup shim maps it to the loopback test server. The shim is a
 * transport detail; every security-relevant option comes from the real helpers.
 *
 * RFC 8314 (implicit TLS for submission/IMAP), RFC 9525 (cert identity),
 * RFC 3207 (SMTP STARTTLS), RFC 2595 (IMAP STARTTLS).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import { imapTlsOptions, smtpTlsOptions } from '../tls.js';
import { sendViaExternal } from '../send.js';
import type { WorkerCredentials } from '../convex.js';

const IMAP_HOST = 'imap.regress.invalid';
const SMTP_HOST = 'smtp.regress.invalid';

// --- self-signed cert (generated once, on loopback) -------------------------
let certDir: string;
let key: Buffer;
let cert: Buffer;

beforeAll(() => {
	certDir = mkdtempSync(join(tmpdir(), 'owlat-tls-'));
	// A self-signed cert with a CN of the non-loopback host. It is self-signed,
	// so a verifying client rejects it regardless of name match.
	execFileSync(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			join(certDir, 'key.pem'),
			'-out',
			join(certDir, 'cert.pem'),
			'-days',
			'1',
			'-subj',
			`/CN=${IMAP_HOST}`,
		],
		{ stdio: 'ignore' }
	);
	key = readFileSync(join(certDir, 'key.pem'));
	cert = readFileSync(join(certDir, 'cert.pem'));
});

afterAll(() => {
	if (certDir) rmSync(certDir, { recursive: true, force: true });
});

// --- DNS shim: map our non-loopback test hosts to the loopback server -------
// Installed only while a test that uses sendViaExternal (which can't take a
// custom lookup) is running, and always restored afterwards.
type LookupFn = typeof dns.lookup;
const realLookup: LookupFn = dns.lookup;
let dnsShimActive = false;

function installDnsShim(): void {
	dnsShimActive = true;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(dns as any).lookup = ((hostname: string, options: unknown, cb: unknown) => {
		const callback = (typeof options === 'function' ? options : cb) as (
			err: NodeJS.ErrnoException | null,
			address: unknown,
			family?: number
		) => void;
		const opts = (typeof options === 'function' ? {} : options) as { all?: boolean };
		if (hostname === IMAP_HOST || hostname === SMTP_HOST) {
			const rec = { address: '127.0.0.1', family: 4 };
			return opts && opts.all ? callback(null, [rec]) : callback(null, rec.address, rec.family);
		}
		return (realLookup as unknown as (...a: unknown[]) => void)(hostname, options, cb);
	}) as unknown as LookupFn;
}

function restoreDns(): void {
	if (dnsShimActive) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(dns as any).lookup = realLookup;
		dnsShimActive = false;
	}
}

// imapflow forwards `this.options.tls` to (tls|net).connect, so a per-instance
// `lookup` can be threaded there without touching production option shapes.
function loopbackLookup(hostname: string, options: unknown, cb: unknown): void {
	const callback = (typeof options === 'function' ? options : cb) as (
		err: NodeJS.ErrnoException | null,
		address: unknown,
		family?: number
	) => void;
	const opts = (typeof options === 'function' ? {} : options) as { all?: boolean };
	const rec = { address: '127.0.0.1', family: 4 };
	if (opts && opts.all) return callback(null, [rec]);
	return callback(null, rec.address, rec.family);
}

afterEach(() => restoreDns());

// --- helpers ----------------------------------------------------------------
function listenOnLoopback(server: net.Server): Promise<number> {
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			resolve(typeof addr === 'object' && addr ? addr.port : 0);
		});
	});
}

const RAW = Buffer.from('From: me@regress.invalid\r\nSubject: hi\r\n\r\nbody');

function smtpCreds(port: number, secure: boolean): WorkerCredentials {
	return {
		smtpHost: SMTP_HOST,
		smtpPort: port,
		isSmtpSecure: secure,
		smtpUsername: 'smtp-user',
		smtpPassword: 'smtp-pass',
		imapHost: IMAP_HOST,
		imapPort: port,
		isImapSecure: secure,
		imapUsername: 'imap-user',
		imapPassword: 'imap-pass',
	};
}

describe('PR-75 §1 — certificate verification is enforced (self-signed rejected)', () => {
	it('imapflow rejects a self-signed cert on a non-loopback host (DEPTH_ZERO_SELF_SIGNED_CERT)', async () => {
		const server = tls.createServer({ key, cert }, (sock) => sock.write('* OK ready\r\n'));
		const port = await listenOnLoopback(server);
		try {
			// Production options: implicit-TLS to a remote host. Only `lookup` is
			// test transport; secure/tls.minVersion come from the real helper.
			const base = imapTlsOptions(IMAP_HOST, true);
			const client = new ImapFlow({
				host: IMAP_HOST,
				port,
				...base,
				tls: { ...base.tls, lookup: loopbackLookup },
				auth: { user: 'u', pass: 'p' },
				logger: false,
				emitLogs: false,
			});
			client.on('error', () => undefined);
			await expect(client.connect()).rejects.toMatchObject({
				code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
			});
		} finally {
			server.close();
		}
	});

	it('sendViaExternal rejects a self-signed implicit-TLS SMTP server with a cert error', async () => {
		const server = tls.createServer({ key, cert }, (sock) => sock.write('220 fake ESMTP\r\n'));
		const port = await listenOnLoopback(server);
		installDnsShim();
		try {
			// The in-house client classifies the handshake failure from Node's error
			// CODE (DEPTH_ZERO_SELF_SIGNED_CERT → tlsCause 'cert-untrusted'), never a
			// string sniff; the message still names the code for the human reading it.
			await expect(
				sendViaExternal(smtpCreds(port, true), {
					from: 'me@regress.invalid',
					recipients: ['x@example.com'],
					raw: RAW,
				})
			).rejects.toMatchObject({
				tlsCause: 'cert-untrusted',
				secured: false,
			});
		} finally {
			server.close();
		}
	});
});

describe('PR-75 §2 — no-downgrade: a server without STARTTLS is rejected (no cleartext secrets)', () => {
	it('SMTP without STARTTLS + isSmtpSecure=false fails before any AUTH / MAIL FROM is sent', async () => {
		const captured: string[] = [];
		// ESMTP server that advertises NO STARTTLS extension.
		const server = net.createServer((sock) => {
			sock.write('220 fake ESMTP\r\n');
			sock.on('data', (d) => {
				captured.push(d.toString());
				const line = d.toString();
				if (/^EHLO/i.test(line)) sock.write('250-fake\r\n250 SIZE 1000000\r\n');
				else if (/^HELO/i.test(line)) sock.write('250 fake\r\n');
				else if (/^QUIT/i.test(line)) {
					sock.write('221 bye\r\n');
					sock.end();
				} else sock.write('502 not implemented\r\n');
			});
		});
		const port = await listenOnLoopback(server);
		installDnsShim();
		try {
			let err: { phase?: string; tlsCause?: string; message?: string } | undefined;
			try {
				await sendViaExternal(smtpCreds(port, false), {
					from: 'me@regress.invalid',
					recipients: ['x@example.com'],
					raw: RAW,
				});
			} catch (e) {
				err = e as { phase?: string; tlsCause?: string; message?: string };
			}
			expect(err, 'send should reject when STARTTLS is unavailable').toBeDefined();
			// The in-house client fails closed in the STARTTLS phase with a structured
			// tlsCause — the fail-open trap (proceeding in cleartext) never happens.
			expect(err?.phase).toBe('starttls');
			expect(err?.tlsCause).toBe('starttls-unavailable');
			// The mailbox password and envelope were NEVER sent in the clear.
			const wire = captured.join('');
			expect(wire).not.toMatch(/AUTH/i);
			expect(wire).not.toMatch(/MAIL FROM/i);
		} finally {
			server.close();
		}
	});

	it('IMAP without STARTTLS support fails with "does not support STARTTLS" and never logs in', async () => {
		const captured: string[] = [];
		// Plaintext IMAP server advertising NO STARTTLS capability.
		const server = net.createServer((sock) => {
			sock.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready\r\n');
			sock.on('data', (d) => {
				captured.push(d.toString());
				const line = d.toString();
				const tag = line.split(' ')[0] ?? '*';
				if (/CAPABILITY/i.test(line)) {
					sock.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK done\r\n`);
				} else if (/STARTTLS/i.test(line)) {
					sock.write(`${tag} NO starttls not supported\r\n`);
				} else if (/LOGIN/i.test(line)) {
					sock.write(`${tag} OK logged in\r\n`);
				} else if (/LOGOUT/i.test(line)) {
					sock.write(`* BYE\r\n${tag} OK\r\n`);
					sock.end();
				} else {
					sock.write(`${tag} OK\r\n`);
				}
			});
		});
		const port = await listenOnLoopback(server);
		try {
			// Production options: secure:false to a remote host → doSTARTTLS:true.
			const base = imapTlsOptions(IMAP_HOST, false);
			expect(base.doSTARTTLS).toBe(true);
			const client = new ImapFlow({
				host: IMAP_HOST,
				port,
				...base,
				tls: { ...base.tls, lookup: loopbackLookup },
				auth: { user: 'imap-user', pass: 'imap-pass' },
				logger: false,
				emitLogs: false,
			});
			client.on('error', () => undefined);
			await expect(client.connect()).rejects.toThrow(/does not support STARTTLS/i);
			// LOGIN must never have been attempted over the cleartext channel.
			expect(captured.some((c) => /LOGIN/i.test(c))).toBe(false);
		} finally {
			server.close();
		}
	});
});

describe('PR-75 §6 — sanity: the production helpers carry no verify-disabling flags', () => {
	it('smtpTlsOptions / imapTlsOptions never emit rejectUnauthorized:false for the test hosts', () => {
		for (const opts of [
			smtpTlsOptions(SMTP_HOST, true),
			smtpTlsOptions(SMTP_HOST, false),
			imapTlsOptions(IMAP_HOST, true),
			imapTlsOptions(IMAP_HOST, false),
		]) {
			expect(JSON.stringify(opts)).not.toMatch(/"rejectUnauthorized"\s*:\s*false/);
			expect(JSON.stringify(opts)).not.toMatch(/"tls"\s*:\s*false/);
		}
	});
});
