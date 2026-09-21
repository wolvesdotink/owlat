import { describe, it, expect } from 'vitest';
import { isLoopbackHost, smtpTlsOptions, imapTlsOptions } from '../tls.js';

describe('isLoopbackHost', () => {
	it('accepts loopback hosts (plaintext permitted)', () => {
		for (const h of [
			'localhost',
			'localhost.',
			'127.0.0.1',
			'127.1.2.3',
			'::1',
			'[::1]',
			'0:0:0:0:0:0:0:1',
			'::ffff:127.0.0.1',
		]) {
			expect(isLoopbackHost(h)).toBe(true);
		}
	});

	it('rejects remote hosts (must be encrypted)', () => {
		for (const h of ['smtp.mail.me.com', 'smtp-mail.outlook.com', 'example.com', '8.8.8.8', '']) {
			expect(isLoopbackHost(h)).toBe(false);
		}
	});

	// Regression-lock (PR-75 §3): the loopback gate is a security boundary —
	// anything that is NOT a canonical loopback form must be treated as remote so
	// the connection is forced through TLS. These are spoof / homograph / encoding
	// tricks that must NEVER be mistaken for loopback.
	it('rejects spoofed, encoded, and homograph "localhost" lookalikes (no plaintext)', () => {
		for (const h of [
			'localhost.evil.com', // subdomain trick
			'127.0.0.1.evil.com', // dotted-IP-prefixed hostname
			'evil-localhost.com',
			'fake-localhost',
			'notlocalhost',
			'0x7f000001', // hex-encoded 127.0.0.1
			'0177.0.0.1', // octal first octet
			'2130706433', // decimal 127.0.0.1
			'127.0.0.1:993', // host:port is not a bare host
			'127.0.0.1:587',
			'①27.0.0.1', // U+2460 circled digit one (homograph)
			'127．0．0．1', // U+FF0E fullwidth full stop
			'127。0。0。1', // U+3002 ideographic full stop
			'1270.0.1',
			'12700.0.1',
			'127.0.0', // too few octets
			'::1.evil.com',
			'[::1].evil.com',
			'127.0.0.1 ', // trailing space INSIDE (after trim it is canonical) — see canonical-forms test
		].filter((h) => h !== '127.0.0.1 ')) {
			expect(isLoopbackHost(h)).toBe(false);
		}
	});

	it('accepts only the canonical loopback forms (trim + trailing-dot + brackets tolerated)', () => {
		// These are the ONLY shapes that should ever permit a plaintext connection.
		for (const h of [
			'localhost',
			'  localhost  ', // surrounding whitespace is trimmed
			'LOCALHOST', // case-insensitive
			'localhost.', // FQDN root dot
			'127.0.0.1',
			'127.255.255.255', // anywhere in 127.0.0.0/8
			'::1',
			'[::1]',
			'0:0:0:0:0:0:0:1',
			'::ffff:127.0.0.1',
		]) {
			expect(isLoopbackHost(h)).toBe(true);
		}
	});
});

describe('smtpTlsOptions', () => {
	it('forces STARTTLS (requireTls) for a remote host even when secure=false (587/STARTTLS preset)', () => {
		// iCloud / Outlook.com ship smtpPort 587 with isSmtpSecure=false.
		expect(smtpTlsOptions('smtp.mail.me.com', false)).toEqual({
			tlsMode: 'starttls',
			requireTls: true,
			tls: { minVersion: 'TLSv1.2' },
		});
	});

	it('uses implicit TLS with requireTls on for a remote host with a secure port', () => {
		expect(smtpTlsOptions('smtp.mail.me.com', true)).toEqual({
			tlsMode: 'implicit',
			requireTls: true,
			tls: { minVersion: 'TLSv1.2' },
		});
	});

	// Loopback + insecure keeps the old library's `{ secure:false, requireTLS:false }`
	// posture: opportunistic STARTTLS — upgrade when the local relay (Proton Bridge)
	// advertises it, stay cleartext only when it does not. Never forced (requireTls
	// false), never unconditionally plaintext (`tlsMode: 'none'`).
	it('uses opportunistic STARTTLS for a loopback host on an insecure port (Proton Bridge)', () => {
		expect(smtpTlsOptions('127.0.0.1', false)).toEqual({
			tlsMode: 'starttls',
			requireTls: false,
		});
	});

	it('uses implicit TLS (never plaintext) to a loopback host on a secure port', () => {
		expect(smtpTlsOptions('127.0.0.1', true)).toEqual({ tlsMode: 'implicit', requireTls: false });
	});

	// Regression-lock (PR-75 §1): the options handed to the SMTP client must never
	// disable certificate verification, on any branch.
	it('never disables certificate verification on any branch', () => {
		for (const [host, secure] of [
			['smtp.mail.me.com', false],
			['smtp.mail.me.com', true],
			['127.0.0.1', false],
			['localhost', false],
		] as const) {
			const opts = smtpTlsOptions(host, secure) as { tls?: { rejectUnauthorized?: unknown } };
			expect(opts.tls?.rejectUnauthorized).not.toBe(false);
			expect(JSON.stringify(opts)).not.toMatch(/rejectUnauthorized.*false/);
		}
	});

	// Regression-lock (PR-75 §5): TLS floor pinned at 1.2 for remote hosts.
	it('pins tls.minVersion to TLSv1.2 for non-loopback hosts', () => {
		expect(smtpTlsOptions('smtp.mail.me.com', true).tls?.minVersion).toBe('TLSv1.2');
		expect(smtpTlsOptions('smtp.mail.me.com', false).tls?.minVersion).toBe('TLSv1.2');
	});

	it('does not pin a TLS floor for loopback (plaintext is permitted there)', () => {
		expect(smtpTlsOptions('127.0.0.1', false).tls).toBeUndefined();
	});
});

describe('imapTlsOptions', () => {
	it('forces STARTTLS-before-auth for a remote host with secure=false (143/STARTTLS preset)', () => {
		expect(imapTlsOptions('imap.mail.me.com', false)).toEqual({
			secure: false,
			doSTARTTLS: true,
			tls: { minVersion: 'TLSv1.2' },
		});
	});

	it('does NOT set doSTARTTLS with implicit TLS (combining the two is invalid)', () => {
		expect(imapTlsOptions('imap.mail.me.com', true)).toEqual({
			secure: true,
			tls: { minVersion: 'TLSv1.2' },
		});
	});

	it('allows plaintext to a loopback host (no forced STARTTLS, no TLS floor)', () => {
		expect(imapTlsOptions('localhost', false)).toEqual({ secure: false });
	});

	// Regression-lock (PR-75 §4): the exact contract pinned by the audit.
	it('imapTlsOptions("127.0.0.1", false) === { secure: false } (no doSTARTTLS, no tls)', () => {
		expect(imapTlsOptions('127.0.0.1', false)).toStrictEqual({ secure: false });
	});

	it('imapTlsOptions("imap.gmail.com", false) carries secure:false + doSTARTTLS:true', () => {
		const opts = imapTlsOptions('imap.gmail.com', false);
		expect(opts.secure).toBe(false);
		expect(opts.doSTARTTLS).toBe(true);
		expect(opts.tls?.minVersion).toBe('TLSv1.2');
	});

	// Regression-lock (PR-75 §1): never disable certificate verification.
	it('never disables certificate verification on any branch', () => {
		for (const [host, secure] of [
			['imap.gmail.com', false],
			['imap.gmail.com', true],
			['127.0.0.1', false],
			['localhost', false],
		] as const) {
			const opts = imapTlsOptions(host, secure) as { tls?: { rejectUnauthorized?: unknown } };
			expect(opts.tls?.rejectUnauthorized).not.toBe(false);
			expect(JSON.stringify(opts)).not.toMatch(/rejectUnauthorized.*false/);
		}
	});

	// Regression-lock (PR-75 §5): TLS floor pinned at 1.2 for remote hosts.
	it('pins tls.minVersion to TLSv1.2 for non-loopback hosts', () => {
		expect(imapTlsOptions('imap.gmail.com', true).tls?.minVersion).toBe('TLSv1.2');
		expect(imapTlsOptions('imap.gmail.com', false).tls?.minVersion).toBe('TLSv1.2');
	});
});
