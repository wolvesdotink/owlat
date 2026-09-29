/**
 * POST /send answers on SMTP's verdict, not on the Sent-folder APPEND (plan E5).
 *
 * The APPEND is a second login to a different server. It used to run inside the
 * request, so every send through an external account waited for IMAP connect,
 * LIST, APPEND and LOGOUT before the caller heard back. It now runs after the
 * answer, stays best-effort (a failure is logged, never surfaced), and a
 * shutdown waits for it the way it used to wait for the open request.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SendMessageOptions, SendResult } from '@owlat/smtp-client';
import type { MailSyncConfig } from '../config.js';
import type { ConvexClient, WorkerCredentialsResult } from '../convex.js';

const { sendMessage, imapConnect, imapList, imapAppend, imapLogout, warn, fetchCreds } = vi.hoisted(
	() => ({
		sendMessage: vi.fn<(o: SendMessageOptions) => Promise<SendResult>>(),
		imapConnect: vi.fn(),
		imapList: vi.fn(),
		imapAppend: vi.fn(),
		imapLogout: vi.fn(),
		warn: vi.fn(),
		fetchCreds: vi.fn<(c: unknown, id: string) => Promise<WorkerCredentialsResult>>(),
	})
);

vi.mock('@owlat/smtp-client', () => ({
	sendMessage,
	verify: vi.fn(),
	isSmtpError: () => false,
}));

vi.mock('imapflow', () => ({
	ImapFlow: vi.fn(function (this: Record<string, unknown>) {
		this.connect = imapConnect;
		this.list = imapList;
		this.append = imapAppend;
		this.logout = imapLogout;
	}),
}));

vi.mock('../logger.js', () => ({
	logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../convex.js', () => ({ fetchWorkerCredentials: fetchCreds }));

import { createApp } from '../server.js';
import { drainSentCopies } from '../send.js';

const API_KEY = 'test-api-key';
const CONVEX_ORIGIN = 'http://convex:3210';
const RAW = 'From: me@example.com\r\nSubject: hi\r\n\r\nbody';

const config = {
	apiKey: API_KEY,
	allowedFetchOrigins: [CONVEX_ORIGIN],
} as unknown as MailSyncConfig;

function app() {
	return createApp(config, {} as ConvexClient);
}

function postSend() {
	return app().request('/send', {
		method: 'POST',
		headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			externalAccountId: 'acc-1',
			from: 'me@example.com',
			recipients: ['x@example.com'],
			rawEmlUrl: `${CONVEX_ORIGIN}/api/storage/abc`,
		}),
	});
}

/** A promise plus the function that settles it. */
function deferred() {
	let resolve!: () => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	vi.clearAllMocks();
	fetchCreds.mockResolvedValue({
		kind: 'credentials',
		credentials: {
			imapHost: 'imap.example.com',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.example.com',
			smtpPort: 465,
			isSmtpSecure: true,
			imapUsername: 'me',
			smtpUsername: 'me',
			imapPassword: 'pw',
			smtpPassword: 'pw',
		},
	});
	sendMessage.mockResolvedValue({
		accepted: [{ recipient: 'x@example.com', accepted: true, replyCode: 250, message: 'OK' }],
		rejected: [],
		response: { code: 250, text: 'queued', lines: ['250 queued'] },
	});
	imapConnect.mockResolvedValue(undefined);
	imapList.mockResolvedValue([{ path: 'Sent', specialUse: '\\Sent' }]);
	imapLogout.mockResolvedValue(undefined);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(RAW, { status: 200 }))
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('POST /send', () => {
	it('answers with the SMTP verdict while the Sent APPEND is still running', async () => {
		const append = deferred();
		imapAppend.mockReturnValue(append.promise);

		const res = await postSend();

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			recipients: [{ address: 'x@example.com', status: 'sent' }],
		});
		// The copy is on its way but has not landed: the answer did not wait for it.
		await vi.waitFor(() => expect(imapAppend).toHaveBeenCalledTimes(1));
		expect(imapAppend.mock.calls[0]?.[0]).toBe('Sent');
		expect(Buffer.from(imapAppend.mock.calls[0]?.[1] as Buffer).toString()).toBe(RAW);
		expect(imapLogout).not.toHaveBeenCalled();

		// Shutdown waits for it.
		let drained = false;
		const drain = drainSentCopies().then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);
		append.resolve();
		await drain;
		expect(drained).toBe(true);
		expect(imapLogout).toHaveBeenCalledTimes(1);
	});

	it('keeps a failed APPEND non-fatal: the send still succeeds and the failure is logged', async () => {
		const boom = new Error('APPEND refused');
		imapAppend.mockRejectedValue(boom);

		const res = await postSend();
		await drainSentCopies();

		expect(res.status).toBe(200);
		expect(warn).toHaveBeenCalledWith({ err: boom }, expect.stringContaining('append-to-Sent'));
	});

	it('files no Sent copy when SMTP fails', async () => {
		sendMessage.mockRejectedValue(new Error('connection refused'));

		const res = await postSend();
		await drainSentCopies();

		expect(res.status).toBe(502);
		expect(imapConnect).not.toHaveBeenCalled();
		expect(imapAppend).not.toHaveBeenCalled();
	});
});
