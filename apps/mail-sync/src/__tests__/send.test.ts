import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkerCredentials } from '../convex.js';

// --- Mocks ------------------------------------------------------------------
// vi.mock factories are hoisted above the file, so the shared mock fns they
// reference must be created via vi.hoisted (which is hoisted alongside them).
const {
	sendMail,
	verify,
	createTransport,
	imapConnect,
	imapList,
	imapAppend,
	imapLogout,
	warn,
} = vi.hoisted(() => {
	const sendMail = vi.fn();
	const verify = vi.fn();
	return {
		sendMail,
		verify,
		createTransport: vi.fn(() => ({ sendMail, verify })),
		imapConnect: vi.fn(),
		imapList: vi.fn(),
		imapAppend: vi.fn(),
		imapLogout: vi.fn(),
		warn: vi.fn(),
	};
});

// nodemailer is imported as the default export; expose createTransport on it.
vi.mock('nodemailer', () => ({
	default: { createTransport },
}));

// ImapFlow is a named export used with `new`; the mock must be constructible,
// so use a `function` (not an arrow) and assign the shared spies onto `this`.
vi.mock('imapflow', () => ({
	ImapFlow: vi.fn(function (this: Record<string, unknown>) {
		this.connect = imapConnect;
		this.list = imapList;
		this.append = imapAppend;
		this.logout = imapLogout;
	}),
}));

// Silence the pino logger and let us assert the non-fatal warn path.
vi.mock('../logger.js', () => ({
	logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Imported after mocks so the module picks up the mocked deps.
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { sendViaExternal, testConnection } from '../send.js';

const CREDS: WorkerCredentials = {
	imapHost: 'imap.example.com',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.example.com',
	smtpPort: 465,
	isSmtpSecure: true,
	imapUsername: 'imap-user',
	smtpUsername: 'smtp-user',
	imapPassword: 'imap-pass',
	smtpPassword: 'smtp-pass',
};

const RAW = Buffer.from('From: a@example.com\r\nSubject: hi\r\n\r\nbody');

beforeEach(() => {
	vi.clearAllMocks();
	// Sensible defaults; individual tests override as needed.
	sendMail.mockResolvedValue({ rejected: [] });
	imapConnect.mockResolvedValue(undefined);
	imapList.mockResolvedValue([
		{ path: 'INBOX', specialUse: '\\Inbox' },
		{ path: 'Sent', specialUse: '\\Sent' },
	]);
	imapAppend.mockResolvedValue(undefined);
	imapLogout.mockResolvedValue(undefined);
	verify.mockResolvedValue(true);
});

describe('sendViaExternal', () => {
	it('builds the transport + envelope from the SMTP creds and recipients', async () => {
		await sendViaExternal(CREDS, {
			from: 'me@example.com',
			recipients: ['x@example.com', 'y@example.com'],
			raw: RAW,
		});

		expect(nodemailer.createTransport).toHaveBeenCalledWith({
			host: 'smtp.example.com',
			port: 465,
			secure: true,
			requireTLS: true,
			tls: { minVersion: 'TLSv1.2' },
			auth: { user: 'smtp-user', pass: 'smtp-pass' },
		});

		expect(sendMail).toHaveBeenCalledTimes(1);
		const arg = sendMail.mock.calls[0][0];
		expect(arg.envelope).toEqual({
			from: 'me@example.com',
			to: ['x@example.com', 'y@example.com'],
		});
		expect(arg.raw).toBe(RAW);
	});

	it('marks every recipient sent when none are rejected', async () => {
		sendMail.mockResolvedValue({ rejected: [] });

		const { recipients } = await sendViaExternal(CREDS, {
			from: 'me@example.com',
			recipients: ['x@example.com', 'y@example.com'],
			raw: RAW,
		});

		expect(recipients).toEqual([
			{ address: 'x@example.com', status: 'sent' },
			{ address: 'y@example.com', status: 'sent' },
		]);
	});

	it('marks rejected recipients as bounced (case-insensitive match)', async () => {
		// SMTP reports the rejection in a different case than our recipient list.
		sendMail.mockResolvedValue({ rejected: ['X@EXAMPLE.COM'] });

		const { recipients } = await sendViaExternal(CREDS, {
			from: 'me@example.com',
			recipients: ['x@example.com', 'y@example.com'],
			raw: RAW,
		});

		expect(recipients).toEqual([
			{ address: 'x@example.com', status: 'bounced', error: 'Rejected by SMTP server' },
			{ address: 'y@example.com', status: 'sent' },
		]);
	});

	it('tolerates a missing rejected array from the transport', async () => {
		sendMail.mockResolvedValue({});

		const { recipients } = await sendViaExternal(CREDS, {
			from: 'me@example.com',
			recipients: ['only@example.com'],
			raw: RAW,
		});

		expect(recipients).toEqual([{ address: 'only@example.com', status: 'sent' }]);
	});

	it('appends the raw bytes to the resolved Sent folder', async () => {
		await sendViaExternal(CREDS, {
			from: 'me@example.com',
			recipients: ['x@example.com'],
			raw: RAW,
		});

		// IMAP client built from the IMAP creds, not the SMTP ones.
		expect(ImapFlow).toHaveBeenCalledWith(
			expect.objectContaining({
				host: 'imap.example.com',
				port: 993,
				secure: true,
				auth: { user: 'imap-user', pass: 'imap-pass' },
			}),
		);
		expect(imapAppend).toHaveBeenCalledWith('Sent', RAW, ['\\Seen']);
		expect(imapLogout).toHaveBeenCalled();
	});

	it('skips the append when no Sent folder is found, without throwing', async () => {
		imapList.mockResolvedValue([{ path: 'INBOX', specialUse: '\\Inbox' }]);

		const { recipients } = await sendViaExternal(CREDS, {
			from: 'me@example.com',
			recipients: ['x@example.com'],
			raw: RAW,
		});

		expect(imapAppend).not.toHaveBeenCalled();
		// Send still succeeds.
		expect(recipients).toEqual([{ address: 'x@example.com', status: 'sent' }]);
	});

	it('treats a Sent-append failure as non-fatal and still reports the send result', async () => {
		const boom = new Error('IMAP append failed');
		imapAppend.mockRejectedValue(boom);

		const { recipients } = await sendViaExternal(CREDS, {
			from: 'me@example.com',
			recipients: ['x@example.com'],
			raw: RAW,
		});

		// The SMTP send result is returned unchanged.
		expect(recipients).toEqual([{ address: 'x@example.com', status: 'sent' }]);
		// And the failure is logged at warn level rather than thrown.
		expect(warn).toHaveBeenCalledWith({ err: boom }, expect.stringContaining('append-to-Sent'));
	});
});

describe('testConnection', () => {
	const input = {
		imap: {
			host: 'imap.example.com',
			port: 993,
			secure: true,
			username: 'imap-user',
			password: 'imap-pass',
		},
		smtp: {
			host: 'smtp.example.com',
			port: 587,
			secure: false,
			username: 'smtp-user',
			password: 'smtp-pass',
		},
	};

	it('reports ok for both when IMAP connects and SMTP verifies', async () => {
		imapConnect.mockResolvedValue(undefined);
		verify.mockResolvedValue(true);

		const result = await testConnection(input);

		expect(result).toEqual({ imap: { ok: true }, smtp: { ok: true } });
		// IMAP probe connects and logs out cleanly.
		expect(imapConnect).toHaveBeenCalled();
		expect(imapLogout).toHaveBeenCalled();
		expect(verify).toHaveBeenCalled();
	});

	it('reports the IMAP error message on auth rejection while SMTP stays ok', async () => {
		imapConnect.mockRejectedValue(new Error('Invalid credentials'));
		verify.mockResolvedValue(true);

		const result = await testConnection(input);

		expect(result.imap).toEqual({ ok: false, error: 'Invalid credentials' });
		expect(result.smtp).toEqual({ ok: true });
	});

	it('reports the SMTP error message on a network failure while IMAP stays ok', async () => {
		imapConnect.mockResolvedValue(undefined);
		verify.mockRejectedValue(new Error('ECONNREFUSED smtp.example.com:587'));

		const result = await testConnection(input);

		expect(result.imap).toEqual({ ok: true });
		expect(result.smtp).toEqual({ ok: false, error: 'ECONNREFUSED smtp.example.com:587' });
	});

	it('stringifies non-Error rejections', async () => {
		imapConnect.mockRejectedValue('imap blew up');
		verify.mockRejectedValue('smtp blew up');

		const result = await testConnection(input);

		expect(result).toEqual({
			imap: { ok: false, error: 'imap blew up' },
			smtp: { ok: false, error: 'smtp blew up' },
		});
	});

	it('builds the SMTP transport with verify-only (no send)', async () => {
		await testConnection(input);

		expect(nodemailer.createTransport).toHaveBeenCalledWith({
			host: 'smtp.example.com',
			port: 587,
			secure: false,
			requireTLS: true,
			tls: { minVersion: 'TLSv1.2' },
			auth: { user: 'smtp-user', pass: 'smtp-pass' },
		});
		expect(sendMail).not.toHaveBeenCalled();
	});
});

// Regression-lock (PR-75 §1 + §6): across EVERY nodemailer / imapflow
// construction in the send + connection-test paths, the options handed to the
// library must never disable certificate verification and the test path must be
// byte-identical to the live path.
describe('outbound TLS posture is locked (no rejectUnauthorized:false anywhere)', () => {
	const REMOTE: WorkerCredentials = {
		imapHost: 'imap.gmail.com',
		imapPort: 143,
		isImapSecure: false,
		smtpHost: 'smtp.gmail.com',
		smtpPort: 587,
		isSmtpSecure: false,
		imapUsername: 'imap-user',
		smtpUsername: 'smtp-user',
		imapPassword: 'imap-pass',
		smtpPassword: 'smtp-pass',
	};

	function assertNoVerifyDisable(opts: unknown): void {
		const o = opts as { tls?: unknown; rejectUnauthorized?: unknown };
		// No top-level verification-disabling flag.
		expect(o.rejectUnauthorized).not.toBe(false);
		// No tls.rejectUnauthorized === false.
		if (o.tls && typeof o.tls === 'object') {
			expect((o.tls as { rejectUnauthorized?: unknown }).rejectUnauthorized).not.toBe(false);
		}
		// No `tls: false` (which disables TLS verification wholesale).
		expect(o.tls).not.toBe(false);
		// Belt-and-braces serialized scan, including any future nested shape.
		expect(JSON.stringify(opts)).not.toMatch(/"rejectUnauthorized"\s*:\s*false/);
	}

	it('sendViaExternal: nodemailer transport + appendToSent ImapFlow keep verification on', async () => {
		await sendViaExternal(REMOTE, {
			from: 'me@gmail.com',
			recipients: ['x@example.com'],
			raw: RAW,
		});
		// Construction 1: nodemailer.createTransport (the actual send).
		expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
		assertNoVerifyDisable((nodemailer.createTransport as ReturnType<typeof vi.fn>).mock.calls[0][0]);
		// Construction 2: ImapFlow for the best-effort Sent append.
		expect(ImapFlow).toHaveBeenCalledTimes(1);
		assertNoVerifyDisable((ImapFlow as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
	});

	it('testConnection: testImap ImapFlow + testSmtp transport keep verification on', async () => {
		await testConnection({
			imap: {
				host: 'imap.gmail.com',
				port: 143,
				secure: false,
				username: 'imap-user',
				password: 'imap-pass',
			},
			smtp: {
				host: 'smtp.gmail.com',
				port: 587,
				secure: false,
				username: 'smtp-user',
				password: 'smtp-pass',
			},
		});
		// Construction 3: ImapFlow (testImap).
		expect(ImapFlow).toHaveBeenCalledTimes(1);
		assertNoVerifyDisable((ImapFlow as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
		// Construction 4: nodemailer.createTransport (testSmtp).
		expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
		assertNoVerifyDisable((nodemailer.createTransport as ReturnType<typeof vi.fn>).mock.calls[0][0]);
	});

	it('test path passes byte-identical TLS options to the live path (PR-75 §6)', async () => {
		// Live SMTP construction.
		await sendViaExternal(REMOTE, {
			from: 'me@gmail.com',
			recipients: ['x@example.com'],
			raw: RAW,
		});
		const liveSmtp = (nodemailer.createTransport as ReturnType<typeof vi.fn>).mock.calls[0][0];
		const liveImap = (ImapFlow as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];

		vi.clearAllMocks();
		sendMail.mockResolvedValue({ rejected: [] });
		imapConnect.mockResolvedValue(undefined);
		imapList.mockResolvedValue([{ path: 'INBOX', specialUse: '\\Inbox' }]);
		imapLogout.mockResolvedValue(undefined);
		verify.mockResolvedValue(true);

		// Test path uses the same host/port/secure values.
		await testConnection({
			imap: {
				host: REMOTE.imapHost,
				port: REMOTE.imapPort,
				secure: REMOTE.isImapSecure,
				username: REMOTE.imapUsername,
				password: REMOTE.imapPassword,
			},
			smtp: {
				host: REMOTE.smtpHost,
				port: REMOTE.smtpPort,
				secure: REMOTE.isSmtpSecure,
				username: REMOTE.smtpUsername,
				password: REMOTE.smtpPassword,
			},
		});
		const testSmtp = (nodemailer.createTransport as ReturnType<typeof vi.fn>).mock.calls[0][0];
		const testImap = (ImapFlow as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];

		// Only auth differs by design (creds vs ProtocolCreds) — the TLS-bearing
		// fields (secure / requireTLS / doSTARTTLS / tls) must be identical.
		expect(testSmtp.secure).toBe(liveSmtp.secure);
		expect(testSmtp.requireTLS).toBe(liveSmtp.requireTLS);
		expect(testSmtp.tls).toEqual(liveSmtp.tls);
		expect(testImap.secure).toBe(liveImap.secure);
		expect(testImap.doSTARTTLS).toBe(liveImap.doSTARTTLS);
		expect(testImap.tls).toEqual(liveImap.tls);
	});
});
