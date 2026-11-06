/**
 * POST /send answers on SMTP's verdict, not on the Sent-folder APPEND (plan E5).
 *
 * The APPEND is a second login to a different server. Run inside the request,
 * it would make every send through an external account wait for IMAP connect,
 * LIST, APPEND and LOGOUT before the caller heard back. So it runs after the
 * answer, stays best-effort (a failure is logged, never surfaced), and a
 * shutdown waits for it the way it waits for an open request.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SendMessageOptions, SendResult } from '@owlat/smtp-client';
import type * as SmtpClient from '@owlat/smtp-client';
import type { MailSyncConfig } from '../config.js';
import type { ConvexClient, WorkerCredentialsResult } from '../convex.js';

const {
	sendMessage,
	imapConnect,
	imapList,
	imapAppend,
	imapLogout,
	warn,
	fetchCreds,
	convexMutation,
} = vi.hoisted(() => ({
	sendMessage: vi.fn<(o: SendMessageOptions) => Promise<SendResult>>(),
	imapConnect: vi.fn(),
	imapList: vi.fn(),
	imapAppend: vi.fn(),
	imapLogout: vi.fn(),
	warn: vi.fn(),
	fetchCreds: vi.fn<(c: unknown, id: string) => Promise<WorkerCredentialsResult>>(),
	convexMutation: vi.fn(async () => null),
}));

vi.mock('@owlat/smtp-client', async (importOriginal) => ({
	...(await importOriginal<typeof SmtpClient>()),
	sendMessage,
	verify: vi.fn(),
}));

vi.mock('imapflow', () => ({
	ImapFlow: vi.fn(function (this: Record<'connect' | 'list' | 'append' | 'logout', unknown>) {
		this.connect = imapConnect;
		this.list = imapList;
		this.append = imapAppend;
		this.logout = imapLogout;
	}),
}));

vi.mock('../logger.js', () => ({
	logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../convex.js', () => ({
	fetchWorkerCredentials: fetchCreds,
	fn: { setSendPath: 'mail/external/accounts:setSendPath' },
	isMissingFunction: () => false,
}));

import { SmtpError } from '@owlat/smtp-client';
import { createApp, GRAPH_CONSENT_NEEDED_MESSAGE } from '../server.js';
import { drainSentCopies, GRAPH_SEND_MAIL_URL } from '../send.js';

const API_KEY = 'test-api-key';
const CONVEX_ORIGIN = 'http://convex:3210';
const RAW = 'From: me@example.com\r\nSubject: hi\r\n\r\nbody';

const config = {
	apiKey: API_KEY,
	allowedFetchOrigins: [CONVEX_ORIGIN],
} as unknown as MailSyncConfig;

function app() {
	return createApp(config, { mutation: convexMutation } as unknown as ConvexClient);
}

function postSend(recipients = ['x@example.com']) {
	return app().request('/send', {
		method: 'POST',
		headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			externalAccountId: 'acc-1',
			from: 'me@example.com',
			recipients,
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

describe('POST /send for a Microsoft 365 mailbox with SMTP AUTH turned off', () => {
	const MICROSOFT = {
		imapHost: 'outlook.office365.com',
		imapPort: 993,
		isImapSecure: true,
		smtpHost: 'smtp.office365.com',
		smtpPort: 587,
		isSmtpSecure: false,
		imapUsername: 'me@contoso.com',
		smtpUsername: 'me@contoso.com',
		imapPassword: '',
		smtpPassword: '',
		imapAccessToken: 'mail-token',
		smtpAccessToken: 'mail-token',
	};
	const smtpAuthDisabled = () =>
		new SmtpError({
			phase: 'auth',
			message: 'XOAUTH2 rejected with 535',
			replyCode: 535,
			enhancedCode: '5.7.139',
			secured: true,
			authCause: 'credentials-rejected',
		});

	/** Serve the raw .eml from Convex and record what reaches Graph. */
	function stubFetch(graph: () => Response = () => new Response(null, { status: 202 })) {
		const graphCalls: RequestInit[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init: RequestInit) => {
				if (url === GRAPH_SEND_MAIL_URL) {
					graphCalls.push(init);
					return graph();
				}
				return new Response(RAW, { status: 200 });
			})
		);
		return graphCalls;
	}

	function microsoftCreds(extra: Record<string, unknown>) {
		fetchCreds.mockResolvedValue({
			kind: 'credentials',
			credentials: { ...MICROSOFT, ...extra },
		} as WorkerCredentialsResult);
	}

	it('falls back to Graph with the MIME and a Bcc, skips the APPEND and records the path', async () => {
		microsoftCreds({ sendPath: 'smtp', graphAccessToken: 'graph-token' });
		sendMessage.mockRejectedValue(smtpAuthDisabled());
		const graphCalls = stubFetch();

		const res = await postSend(['x@example.com', 'hidden@example.com']);
		await drainSentCopies();

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			recipients: [
				{ address: 'x@example.com', status: 'sent' },
				{ address: 'hidden@example.com', status: 'sent' },
			],
		});
		expect(graphCalls).toHaveLength(1);
		const headers = graphCalls[0]?.headers as Record<string, string> | undefined;
		expect(headers?.['Authorization']).toBe('Bearer graph-token');
		expect(Buffer.from(String(graphCalls[0]?.body), 'base64').toString()).toBe(
			`Bcc: x@example.com, hidden@example.com\r\n${RAW}`
		);
		// Graph files the Sent copy itself.
		expect(imapConnect).not.toHaveBeenCalled();
		expect(convexMutation).toHaveBeenCalledWith('mail/external/accounts:setSendPath', {
			accountId: 'acc-1',
			sendPath: 'graph',
		});
	});

	it('sends an account already on the Graph path through Graph without trying SMTP', async () => {
		microsoftCreds({ sendPath: 'graph', graphAccessToken: 'graph-token' });
		const graphCalls = stubFetch();

		const res = await postSend();
		await drainSentCopies();

		expect(res.status).toBe(200);
		expect(sendMessage).not.toHaveBeenCalled();
		expect(graphCalls).toHaveLength(1);
		expect(imapConnect).not.toHaveBeenCalled();
		expect(convexMutation).not.toHaveBeenCalled();
	});

	it('asks the user to sign in again when the grant has no Graph send permission', async () => {
		microsoftCreds({ sendPath: 'smtp' });
		sendMessage.mockRejectedValue(smtpAuthDisabled());
		const graphCalls = stubFetch();

		const res = await postSend();

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: GRAPH_CONSENT_NEEDED_MESSAGE });
		expect(graphCalls).toHaveLength(0);
		expect(convexMutation).not.toHaveBeenCalled();
	});

	it('reports a Graph refusal after the fallback as a retryable failure', async () => {
		microsoftCreds({ sendPath: 'smtp', graphAccessToken: 'graph-token' });
		sendMessage.mockRejectedValue(smtpAuthDisabled());
		stubFetch(() =>
			Response.json({ error: { code: 'ErrorAccessDenied', message: 'Denied' } }, { status: 403 })
		);

		const res = await postSend();

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({
			error: 'Microsoft Graph refused the message (403 ErrorAccessDenied: Denied)',
		});
		expect(convexMutation).not.toHaveBeenCalled();
	});

	it('moves back to SMTP when the Graph path has no token and SMTP takes the message', async () => {
		microsoftCreds({ sendPath: 'graph' });
		stubFetch();

		const res = await postSend();
		await drainSentCopies();

		expect(res.status).toBe(200);
		expect(imapAppend).toHaveBeenCalledTimes(1);
		expect(convexMutation).toHaveBeenCalledWith('mail/external/accounts:setSendPath', {
			accountId: 'acc-1',
			sendPath: 'smtp',
		});
	});

	it('does not reach for Graph on another provider’s refusal', async () => {
		sendMessage.mockRejectedValue(smtpAuthDisabled());
		const graphCalls = stubFetch();

		const res = await postSend();

		expect(res.status).toBe(502);
		expect(graphCalls).toHaveLength(0);
	});
});
