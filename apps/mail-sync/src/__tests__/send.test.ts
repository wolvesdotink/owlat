import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import type { WorkerCredentials } from '../convex.js';
import type {
	RecipientVerdict,
	SendResult,
	SendMessageOptions,
	VerifyOptions,
} from '@owlat/smtp-client';

// --- Mocks ------------------------------------------------------------------
// vi.mock factories are hoisted above the file, so the shared mock fns they
// reference must be created via vi.hoisted (which is hoisted alongside them).
// sendMessage / verify are typed against the real client signatures so every
// `.mock.calls[0][0]` shape assertion is checked against @owlat/smtp-client's
// API — a future connect/envelope/auth change breaks these tests at compile time.
const { sendMessage, verify, imapConnect, imapList, imapAppend, imapLogout, warn } = vi.hoisted(
	() => ({
		sendMessage: vi.fn<(o: SendMessageOptions) => Promise<SendResult>>(),
		verify: vi.fn<(o: VerifyOptions) => Promise<void>>(),
		imapConnect: vi.fn(),
		imapList: vi.fn(),
		imapAppend: vi.fn(),
		imapLogout: vi.fn(),
		warn: vi.fn(),
	})
);

// The in-house SMTP client replaces the old library: sendMessage does the one-shot
// connect → AUTH → MAIL/RCPT/DATA → QUIT; verify does connect → AUTH → QUIT.
vi.mock('@owlat/smtp-client', () => ({ sendMessage, verify }));

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
import { sendMessage as clientSendMessage, verify as clientVerify } from '@owlat/smtp-client';
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

/** A per-recipient verdict, minimal but structurally faithful. */
function verdict(recipient: string, accepted: boolean): RecipientVerdict {
	return {
		recipient,
		accepted,
		replyCode: accepted ? 250 : 550,
		message: accepted ? 'OK' : 'no such user',
	};
}

/** A SendResult with the given accepted / rejected recipient partition. */
function sendResult(accepted: string[], rejected: string[]): SendResult {
	return {
		accepted: accepted.map((r) => verdict(r, true)),
		rejected: rejected.map((r) => verdict(r, false)),
		response: { code: 250, text: 'queued', lines: ['250 queued'] },
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// Sensible defaults; individual tests override as needed.
	sendMessage.mockResolvedValue(sendResult(['x@example.com', 'y@example.com'], []));
	imapConnect.mockResolvedValue(undefined);
	imapList.mockResolvedValue([
		{ path: 'INBOX', specialUse: '\\Inbox' },
		{ path: 'Sent', specialUse: '\\Sent' },
	]);
	imapAppend.mockResolvedValue(undefined);
	imapLogout.mockResolvedValue(undefined);
	verify.mockResolvedValue(undefined);
});

describe('sendViaExternal', () => {
	it('builds the client connect + envelope from the SMTP creds and recipients', async () => {
		sendMessage.mockResolvedValue(sendResult(['x@example.com', 'y@example.com'], []));

		await sendViaExternal(CREDS, {
			from: 'me@example.com',
			recipients: ['x@example.com', 'y@example.com'],
			raw: RAW,
		});

		expect(clientSendMessage).toHaveBeenCalledTimes(1);
		const arg = sendMessage.mock.calls[0][0];
		// Implicit TLS (secure=true) to a remote host, pinned at the 1.2 floor, with
		// requireTls fail-closed. ehloName is the machine hostname.
		expect(arg.connect).toMatchObject({
			host: 'smtp.example.com',
			port: 465,
			tlsMode: 'implicit',
			requireTls: true,
			tls: { minVersion: 'TLSv1.2' },
		});
		expect(typeof arg.connect.ehloName).toBe('string');
		expect(arg.auth).toEqual({ credentials: { username: 'smtp-user', password: 'smtp-pass' } });
		// Custom envelope: RCPT set is exactly our recipients; raw bytes shipped as-is.
		expect(arg.envelope).toEqual({
			from: 'me@example.com',
			to: ['x@example.com', 'y@example.com'],
			data: RAW,
		});
	});

	// NAMED GATE (b): the SMTP RCPT set is exactly params.recipients — including a
	// Bcc that is NOT in the visible headers — proving envelope-driven delivery.
	it('sends to the exact recipient set (Bcc) regardless of the visible headers', async () => {
		const headerlessBcc = 'secret@example.com';
		// The raw bytes carry only To: visible@example.com; the Bcc is envelope-only.
		const withBcc = Buffer.from('To: visible@example.com\r\nSubject: hi\r\n\r\nbody');
		sendMessage.mockResolvedValue(sendResult(['visible@example.com', headerlessBcc], []));

		await sendViaExternal(CREDS, {
			from: 'me@example.com',
			recipients: ['visible@example.com', headerlessBcc],
			raw: withBcc,
		});

		const arg = sendMessage.mock.calls[0][0];
		// RCPT set == params.recipients, verbatim and independent of the headers.
		expect(arg.envelope.to).toEqual(['visible@example.com', headerlessBcc]);
		expect(arg.envelope.data).toBe(withBcc);
	});

	it('marks every recipient sent when none are rejected', async () => {
		sendMessage.mockResolvedValue(sendResult(['x@example.com', 'y@example.com'], []));

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
		// The RCPT verdict reports the rejection in a different case than our list.
		sendMessage.mockResolvedValue(sendResult(['y@example.com'], ['X@EXAMPLE.COM']));

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

	it('marks every recipient sent when the verdict lists no rejections', async () => {
		sendMessage.mockResolvedValue(sendResult(['only@example.com'], []));

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
			})
		);
		expect(imapAppend).toHaveBeenCalledWith('Sent', RAW, ['\\Seen']);
		expect(imapLogout).toHaveBeenCalled();
	});

	it('skips the append when no Sent folder is found, without throwing', async () => {
		imapList.mockResolvedValue([{ path: 'INBOX', specialUse: '\\Inbox' }]);
		sendMessage.mockResolvedValue(sendResult(['x@example.com'], []));

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
		sendMessage.mockResolvedValue(sendResult(['x@example.com'], []));

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

// The EHLO identity must be byte-identical to the old library's `_getHostname()` so the
// cutover changes no observable HELO name. The old library falls back to `[127.0.0.1]`
// for a non-FQDN (dotless) hostname — which is exactly what mail-sync's own Docker
// container hostnames are — and brackets a bare IPv4 literal as an address literal.
describe('ehloName (_getHostname parity)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function capturedEhloName(hostname: string): Promise<unknown> {
		vi.spyOn(os, 'hostname').mockReturnValue(hostname);
		sendMessage.mockResolvedValue(sendResult(['x@example.com'], []));
		imapList.mockResolvedValue([{ path: 'INBOX', specialUse: '\\Inbox' }]);
		await sendViaExternal(CREDS, {
			from: 'me@example.com',
			recipients: ['x@example.com'],
			raw: RAW,
		});
		return sendMessage.mock.calls[0]?.[0].connect.ehloName;
	}

	it('falls back to [127.0.0.1] for a non-FQDN (dotless) container hostname', async () => {
		expect(await capturedEhloName('a1b2c3d4e5f6')).toBe('[127.0.0.1]');
	});

	it('falls back to [127.0.0.1] for an empty hostname', async () => {
		expect(await capturedEhloName('')).toBe('[127.0.0.1]');
	});

	it('encloses a bare IPv4 literal in brackets (address literal)', async () => {
		expect(await capturedEhloName('10.20.30.40')).toBe('[10.20.30.40]');
	});

	it('keeps an FQDN hostname unchanged', async () => {
		expect(await capturedEhloName('mx1.relay.example.com')).toBe('mx1.relay.example.com');
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
		verify.mockResolvedValue(undefined);

		const result = await testConnection(input);

		expect(result).toEqual({ imap: { ok: true }, smtp: { ok: true } });
		// IMAP probe connects and logs out cleanly.
		expect(imapConnect).toHaveBeenCalled();
		expect(imapLogout).toHaveBeenCalled();
		expect(clientVerify).toHaveBeenCalled();
	});

	it('reports the IMAP error message on auth rejection while SMTP stays ok', async () => {
		imapConnect.mockRejectedValue(new Error('Invalid credentials'));
		verify.mockResolvedValue(undefined);

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

	it('verifies the SMTP endpoint without sending a message', async () => {
		await testConnection(input);

		expect(clientVerify).toHaveBeenCalledTimes(1);
		const arg = verify.mock.calls[0][0];
		// STARTTLS (secure=false) to a remote host, forced + pinned at the 1.2 floor.
		expect(arg.connect).toMatchObject({
			host: 'smtp.example.com',
			port: 587,
			tlsMode: 'starttls',
			requireTls: true,
			tls: { minVersion: 'TLSv1.2' },
		});
		expect(arg.auth).toEqual({ credentials: { username: 'smtp-user', password: 'smtp-pass' } });
		// verify() never sends a message.
		expect(clientSendMessage).not.toHaveBeenCalled();
	});
});

// Regression-lock (PR-75 §1 + §6): across EVERY smtp-client / imapflow
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

	it('sendViaExternal: smtp-client connect + appendToSent ImapFlow keep verification on', async () => {
		sendMessage.mockResolvedValue(sendResult(['x@example.com'], []));
		imapList.mockResolvedValue([{ path: 'INBOX', specialUse: '\\Inbox' }]);
		await sendViaExternal(REMOTE, {
			from: 'me@gmail.com',
			recipients: ['x@example.com'],
			raw: RAW,
		});
		// Construction 1: the smtp-client connect options (the actual send).
		expect(clientSendMessage).toHaveBeenCalledTimes(1);
		assertNoVerifyDisable(sendMessage.mock.calls[0][0].connect);
		// Construction 2: ImapFlow for the best-effort Sent append.
		expect(ImapFlow).toHaveBeenCalledTimes(1);
		assertNoVerifyDisable((ImapFlow as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
	});

	it('testConnection: testImap ImapFlow + testSmtp connect keep verification on', async () => {
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
		// Construction 4: the smtp-client verify connect options (testSmtp).
		expect(clientVerify).toHaveBeenCalledTimes(1);
		assertNoVerifyDisable(verify.mock.calls[0][0].connect);
	});

	it('test path passes byte-identical TLS options to the live path (PR-75 §6)', async () => {
		// Live SMTP construction.
		sendMessage.mockResolvedValue(sendResult(['x@example.com'], []));
		imapList.mockResolvedValue([{ path: 'INBOX', specialUse: '\\Inbox' }]);
		await sendViaExternal(REMOTE, {
			from: 'me@gmail.com',
			recipients: ['x@example.com'],
			raw: RAW,
		});
		const liveSmtp = sendMessage.mock.calls[0][0].connect;
		const liveImap = (ImapFlow as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];

		vi.clearAllMocks();
		imapConnect.mockResolvedValue(undefined);
		imapLogout.mockResolvedValue(undefined);
		verify.mockResolvedValue(undefined);

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
		const testSmtp = verify.mock.calls[0][0].connect;
		const testImap = (ImapFlow as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];

		// Only auth differs by design (creds vs ProtocolCreds) — the TLS-bearing
		// fields (tlsMode / requireTls / tls) must be identical.
		expect(testSmtp.tlsMode).toBe(liveSmtp.tlsMode);
		expect(testSmtp.requireTls).toBe(liveSmtp.requireTls);
		expect(testSmtp.tls).toEqual(liveSmtp.tls);
		expect(testImap.secure).toBe(liveImap.secure);
		expect(testImap.doSTARTTLS).toBe(liveImap.doSTARTTLS);
		expect(testImap.tls).toEqual(liveImap.tls);
	});
});
