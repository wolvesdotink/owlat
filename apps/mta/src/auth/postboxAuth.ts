/**
 * Postbox app-password verification client.
 *
 * Calls the HMAC-signed Convex endpoint at /webhooks/mta-verify-credential
 * to verify a (mailbox-address, app-password) pair against the
 * mailAppPasswords table. Used by the SMTP submission server to
 * authenticate per-user clients (Apple Mail, Thunderbird, …).
 */

import { createHmac } from 'crypto';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';

export interface PostboxAuthResult {
	mailboxId: string;
	appPasswordId: string;
	userId: string;
	organizationId: string;
}

const TIMEOUT_MS = 5_000;

export async function verifyPostboxAppPassword(
	config: MtaConfig,
	address: string,
	password: string,
	scope: 'imap' | 'smtp',
	// Optional client identifier (the SMTP EHLO hostname) forwarded so a
	// successful submission populates the app-password "Last used" client
	// column. Omitted leaves lastUsedUa untouched on the server side.
	clientName?: string
): Promise<PostboxAuthResult | null> {
	const url = `${config.convexSiteUrl}/webhooks/mta-verify-credential`;
	const body = JSON.stringify({
		address: address.toLowerCase(),
		password,
		scope,
		...(clientName ? { clientName } : {}),
	});
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = createHmac('sha256', config.webhookSecret)
		.update(`${timestamp}.${body}`)
		.digest('hex');

	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-MTA-Timestamp': timestamp,
				'X-MTA-Signature': signature,
			},
			body,
			signal: controller.signal,
		});
		clearTimeout(t);
		if (!res.ok) {
			logger.warn({ status: res.status, address }, 'verify-credential non-OK');
			return null;
		}
		const json = (await res.json()) as
			| { ok: true; mailboxId: string; appPasswordId: string; userId: string; organizationId: string }
			| { ok: false };
		if (!json.ok) return null;
		return {
			mailboxId: json.mailboxId,
			appPasswordId: json.appPasswordId,
			userId: json.userId,
			organizationId: json.organizationId,
		};
	} catch (err) {
		clearTimeout(t);
		logger.warn({ err, address }, 'verify-credential request failed');
		return null;
	}
}
