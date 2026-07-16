/**
 * Outbound relay + connection testing through a user's external SMTP/IMAP.
 *
 * `sendViaExternal` ships the exact .eml bytes Convex already built (preserving
 * From / threading headers + the provider's own DKIM) via the user's SMTP, then
 * APPENDs a copy to the remote Sent folder. `testConnection` validates
 * credentials without persisting anything.
 *
 * TLS is enforced at this layer: for any non-loopback host the connection MUST be
 * encrypted (implicit TLS or forced STARTTLS via tls.ts), so the mailbox password
 * never crosses the network in the clear regardless of the secure/STARTTLS choice.
 */

import os from 'node:os';
import { sendMessage, verify as verifySmtp } from '@owlat/smtp-client';
import { ImapFlow } from 'imapflow';
import type { WorkerCredentials } from './convex.js';
import { mapFolderRole } from './folders.js';
import { logger } from './logger.js';
import { smtpTlsOptions, imapTlsOptions } from './tls.js';

export interface RecipientResult {
	address: string;
	status: 'sent' | 'bounced';
	error?: string;
}

/**
 * The name announced in EHLO to the user's submission server. nodemailer defaulted
 * to the machine hostname; we keep that identity so no observable EHLO name changes
 * in the cutover.
 */
function ehloName(): string {
	return os.hostname();
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
		connect: {
			host: creds.smtpHost,
			port: creds.smtpPort,
			ehloName: ehloName(),
			...smtpTlsOptions(creds.smtpHost, creds.isSmtpSecure),
		},
		auth: { credentials: { username: creds.smtpUsername, password: creds.smtpPassword } },
		envelope: { from: params.from, to: params.recipients, data: params.raw },
	});

	const rejected = new Set(result.rejected.map((v) => v.recipient.toLowerCase()));
	const recipients: RecipientResult[] = params.recipients.map((address) =>
		rejected.has(address.toLowerCase())
			? { address, status: 'bounced', error: 'Rejected by SMTP server' }
			: { address, status: 'sent' }
	);

	// Best-effort Sent filing. A later sync re-ingests it, but the Message-ID
	// dedup skips it against the lifecycle-inserted Sent row.
	await appendToSent(creds, params.raw).catch((err) =>
		logger.warn({ err }, 'append-to-Sent failed (non-fatal)')
	);

	return { recipients };
}

async function appendToSent(creds: WorkerCredentials, raw: Buffer): Promise<void> {
	const client = new ImapFlow({
		host: creds.imapHost,
		port: creds.imapPort,
		...imapTlsOptions(creds.imapHost, creds.isImapSecure),
		auth: { user: creds.imapUsername, pass: creds.imapPassword },
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
		auth: { user: c.username, pass: c.password },
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
			connect: {
				host: c.host,
				port: c.port,
				ehloName: ehloName(),
				...smtpTlsOptions(c.host, c.secure),
			},
			auth: { credentials: { username: c.username, password: c.password } },
		});
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
