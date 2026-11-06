/**
 * Outbound relay + connection testing through a user's external SMTP/IMAP.
 *
 * `sendViaExternal` ships the exact .eml bytes Convex already built (preserving
 * From / threading headers + the provider's own DKIM) via the user's SMTP;
 * `fileSentCopy` then APPENDs a copy to the remote Sent folder, after the route
 * has answered. `sendViaGraph` ships the same bytes through Microsoft Graph for
 * a Microsoft 365 mailbox whose tenant turned SMTP AUTH off. `testConnection`
 * validates credentials without persisting anything.
 *
 * TLS is enforced at this layer: for any non-loopback host the connection MUST be
 * encrypted (implicit TLS or forced STARTTLS via tls.ts), so the mailbox password
 * never crosses the network in the clear regardless of the secure/STARTTLS choice.
 */

import os from 'node:os';
import { isSmtpError, sendMessage, verify as verifySmtp } from '@owlat/smtp-client';
import type { SmtpConnectOptions } from '@owlat/smtp-client';
import { ImapFlow } from 'imapflow';
import { v } from 'convex/values';
import { decodeJsonText } from '@owlat/worker-protocol/decodeJson';
import type { WorkerCredentials } from './convex.js';
import { imapAuth, smtpAuth } from './auth.js';
import { mapFolderRole } from './folders.js';
import { logger } from './logger.js';
import { smtpTlsOptions, imapTlsOptions } from './tls.js';

export interface RecipientResult {
	address: string;
	status: 'sent' | 'bounced';
	error?: string;
}

/**
 * The name announced in EHLO to the user's submission server. This replicates
 * the old library's `_getHostname()` byte-for-byte so the cutover changes no observable
 * EHLO identity: the machine hostname when it is an FQDN, otherwise the
 * `[127.0.0.1]` fallback (mail-sync ships in Docker, where container hostnames are
 * dotless hex — a bare non-FQDN token would be rejected by strict submission
 * servers, e.g. postfix `reject_non_fqdn_helo_hostname`), and a bare IPv4 literal
 * enclosed in brackets as an address literal (RFC 5321 §4.1.3).
 */
function ehloName(): string {
	let host: string;
	try {
		host = os.hostname() || '';
	} catch {
		// os.hostname() can throw on some platforms (the old library guarded this too).
		host = 'localhost';
	}
	// Not an FQDN (no dot) → the old library's fallback identity.
	if (host === '' || !host.includes('.')) {
		host = '[127.0.0.1]';
	}
	// A bare IPv4 literal must be sent as a bracketed address literal.
	if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
		host = `[${host}]`;
	}
	return host;
}

/**
 * The shared `@owlat/smtp-client` connect shape for both the live send
 * (`sendViaExternal`) and the credential probe (`testSmtp`): identical host /
 * port / EHLO identity / TLS posture. Extracting it keeps the test path
 * byte-identical to the live path structurally (PR-75 §6), not merely by
 * assertion.
 */
function smtpConnectOptions(host: string, port: number, secure: boolean): SmtpConnectOptions {
	return {
		host,
		port,
		ehloName: ehloName(),
		...smtpTlsOptions(host, secure),
	};
}

export async function sendViaExternal(
	creds: WorkerCredentials,
	params: { from: string; recipients: string[]; raw: Buffer }
): Promise<{ recipients: RecipientResult[] }> {
	// The custom envelope keeps the SMTP RCPT set exactly our recipients (including
	// Bcc), independent of the visible headers. The client collects a per-recipient
	// RCPT verdict — the authoritative accept/reject signal — and ships the exact
	// .eml bytes Convex already built.
	const result = await sendMessage({
		connect: smtpConnectOptions(creds.smtpHost, creds.smtpPort, creds.isSmtpSecure),
		auth: smtpAuth({
			user: creds.smtpUsername,
			pass: creds.smtpPassword,
			accessToken: creds.smtpAccessToken,
		}),
		envelope: { from: params.from, to: params.recipients, data: params.raw },
	});

	const rejected = new Set(result.rejected.map((v) => v.recipient.toLowerCase()));
	const recipients: RecipientResult[] = params.recipients.map((address) =>
		rejected.has(address.toLowerCase())
			? { address, status: 'bounced', error: 'Rejected by SMTP server' }
			: { address, status: 'sent' }
	);

	return { recipients };
}

/** Microsoft Graph's send call for the signed-in user (delegated `Mail.Send`). */
export const GRAPH_SEND_MAIL_URL = 'https://graph.microsoft.com/v1.0/me/sendMail';

/**
 * Graph refuses a request body over 4 MB, and the body is the base64 of the
 * message, a third larger than the message itself. Larger messages need an
 * upload session, which this path does not do.
 */
const GRAPH_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** How long Graph gets to accept a message; it answers once it has queued it. */
const GRAPH_SEND_TIMEOUT_MS = 60_000;

/**
 * Exchange Online's answer to SMTP AUTH on a mailbox or tenant that turned it
 * off: `535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is
 * disabled for the Tenant`. The client keeps the enhanced code, not the text.
 * Exchange also uses 5.7.139 for a few other sign-in refusals; for each of them
 * Graph is still the path that can work, and a Graph refusal is what is
 * reported then.
 */
export function isSmtpAuthRefusedByExchange(err: unknown): boolean {
	return isSmtpError(err) && err.phase === 'auth' && err.enhancedCode === '5.7.139';
}

/** Graph refused the message; `permanent` means sending it again cannot work. */
export class GraphSendError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly permanent: boolean
	) {
		super(message);
		this.name = 'GraphSendError';
	}
}

/** Addresses in a header value, display names and groups aside. */
const HEADER_ADDRESS = /[^\s<>,;:"()]+@[^\s<>,;:"()]+/g;

/**
 * The message with a `Bcc:` header for every recipient its To, Cc and Bcc
 * headers do not name.
 *
 * Graph's MIME send takes its recipients from the headers, not from an
 * envelope, and the stored .eml never carries Bcc (it is the copy everyone
 * received). Exchange drops the Bcc header from what it delivers, and keeps it
 * on the sender's copy in Sent Items, as a mail client does. Bytes are kept
 * as they are: the header goes in front, in the message's own line ending.
 */
export function withEnvelopeBcc(raw: Buffer, recipients: string[]): Buffer {
	const text = raw.toString('utf8');
	const crlf = text.indexOf('\r\n\r\n');
	const lf = text.indexOf('\n\n');
	const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf : lf >= 0 ? lf : text.length;
	const lines = text
		.slice(0, end)
		.replace(/\r?\n[ \t]+/g, ' ')
		.split(/\r?\n/);
	const named = new Set<string>();
	for (const line of lines) {
		const header = /^(?:to|cc|bcc)[ \t]*:(.*)$/i.exec(line);
		for (const match of header?.[1]?.matchAll(HEADER_ADDRESS) ?? []) {
			named.add(match[0].toLowerCase());
		}
	}
	const missing: string[] = [];
	for (const address of recipients) {
		const key = address.toLowerCase();
		if (named.has(key)) continue;
		named.add(key);
		missing.push(address);
	}
	if (missing.length === 0) return raw;
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	return Buffer.concat([Buffer.from(`Bcc: ${missing.join(', ')}${eol}`, 'utf8'), raw]);
}

/** Graph's error body; its other fields (`innerError`, …) are ignored. */
const graphErrorBody = v.object({
	error: v.optional(v.object({ code: v.optional(v.string()), message: v.optional(v.string()) })),
});

/** Graph's error body (`{ error: { code, message } }`), as far as it can be read. */
async function readGraphError(res: Response): Promise<string> {
	const text = await res.text().catch(() => '');
	const decoded = decodeJsonText(text, graphErrorBody);
	if (!decoded.ok) return '';
	const { code, message } = decoded.value.error ?? {};
	return [code, message].filter(Boolean).join(': ');
}

/**
 * Send the exact .eml through Microsoft Graph (`POST /me/sendMail`, MIME body).
 *
 * Graph answers 202 once it has queued the message and reports no
 * per-recipient verdict, so every recipient reads as sent; a refusal by a
 * receiving server comes back later as a bounce message, as with SMTP. Graph
 * files the copy in Sent Items itself, so the caller must not APPEND one.
 */
export async function sendViaGraph(
	accessToken: string,
	params: { recipients: string[]; raw: Buffer }
): Promise<{ recipients: RecipientResult[] }> {
	const body = withEnvelopeBcc(params.raw, params.recipients).toString('base64');
	if (body.length > GRAPH_MAX_BODY_BYTES) {
		throw new GraphSendError(
			'The message is larger than Microsoft Graph accepts (4 MB including encoding).',
			413,
			true
		);
	}
	const res = await fetch(GRAPH_SEND_MAIL_URL, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'text/plain' },
		body,
		signal: AbortSignal.timeout(GRAPH_SEND_TIMEOUT_MS),
	});
	if (res.ok) {
		return { recipients: params.recipients.map((address) => ({ address, status: 'sent' })) };
	}
	const detail = await readGraphError(res);
	throw new GraphSendError(
		`Microsoft Graph refused the message (${res.status}${detail ? ` ${detail}` : ''})`,
		res.status,
		res.status === 413
	);
}

/**
 * File the sent copy in the account's remote Sent folder. Best-effort and
 * never rejects: a failure is logged at warn level. A later sync re-ingests
 * the copy, but the Message-ID dedup skips it against the lifecycle-inserted
 * Sent row.
 *
 * Separate from {@link sendViaExternal} so the `/send` route can answer as soon
 * as SMTP has accepted the message and file the copy AFTER responding: the
 * APPEND is a second login to a different server, and the sender was waiting
 * on it for nothing.
 */
export async function fileSentCopy(creds: WorkerCredentials, raw: Buffer): Promise<void> {
	await appendToSent(creds, raw).catch((err) =>
		logger.warn({ err }, 'append-to-Sent failed (non-fatal)')
	);
}

/** Sent copies filed after their /send answered and not yet finished. */
const pendingSentCopies = new Set<Promise<void>>();

/**
 * Start {@link fileSentCopy} without waiting for it, and remember it so a
 * shutdown can let it finish. Before the route answered first, a SIGTERM could
 * not strand a copy: the APPEND ran inside the request, and the server drains
 * open requests. {@link drainSentCopies} keeps that true.
 */
export function fileSentCopyInBackground(creds: WorkerCredentials, raw: Buffer): void {
	const pending: Promise<void> = fileSentCopy(creds, raw).finally(() => {
		pendingSentCopies.delete(pending);
	});
	pendingSentCopies.add(pending);
}

/** Resolve once every background Sent copy started so far has settled. */
export async function drainSentCopies(): Promise<void> {
	await Promise.all(pendingSentCopies);
}

async function appendToSent(creds: WorkerCredentials, raw: Buffer): Promise<void> {
	const client = new ImapFlow({
		host: creds.imapHost,
		port: creds.imapPort,
		...imapTlsOptions(creds.imapHost, creds.isImapSecure),
		auth: imapAuth({
			user: creds.imapUsername,
			pass: creds.imapPassword,
			accessToken: creds.imapAccessToken,
		}),
		logger: false,
		emitLogs: false,
	});
	await client.connect();
	try {
		const list = await client.list();
		const sent = list.find((f) => mapFolderRole(f.specialUse, f.path) === 'sent');
		if (sent) await client.append(sent.path, raw, ['\\Seen']);
	} finally {
		await client.logout().catch(() => undefined);
	}
}

export interface ProtocolCreds {
	host: string;
	port: number;
	secure: boolean;
	username: string;
	password: string;
	/**
	 * OAuth bearer access token for this protocol's probe. When present, BOTH
	 * probes authenticate with SASL XOAUTH2 instead of the password — IMAP through
	 * ImapFlow's own `AUTHENTICATE XOAUTH2`, SMTP through `@owlat/smtp-client`.
	 */
	accessToken?: string;
}

export async function testConnection(input: {
	imap: ProtocolCreds;
	smtp: ProtocolCreds;
}): Promise<{ imap: { ok: boolean; error?: string }; smtp: { ok: boolean; error?: string } }> {
	const [imap, smtp] = await Promise.all([testImap(input.imap), testSmtp(input.smtp)]);
	return { imap, smtp };
}

async function testImap(c: ProtocolCreds): Promise<{ ok: boolean; error?: string }> {
	const client = new ImapFlow({
		host: c.host,
		port: c.port,
		...imapTlsOptions(c.host, c.secure),
		auth: imapAuth({ user: c.username, pass: c.password, accessToken: c.accessToken }),
		logger: false,
		emitLogs: false,
	});
	try {
		await client.connect();
		await client.logout();
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

async function testSmtp(c: ProtocolCreds): Promise<{ ok: boolean; error?: string }> {
	try {
		// verify() drives connect → EHLO → AUTH → QUIT with no message sent, on the
		// same TLS posture as the live send path.
		await verifySmtp({
			connect: smtpConnectOptions(c.host, c.port, c.secure),
			auth: smtpAuth({ user: c.username, pass: c.password, accessToken: c.accessToken }),
		});
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
