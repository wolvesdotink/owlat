/**
 * Internal HTTP surface for Convex → worker calls. Bearer-authenticated with
 * MAIL_SYNC_API_KEY, compared with `secretMatches` from
 * `@owlat/shared/constantTimeEqual` like the MTA's API key. No public ports —
 * reachable only over the compose network.
 *
 *   POST /send  — relay an outbound message through the account's external SMTP
 *   POST /test  — validate IMAP+SMTP credentials (persists nothing)
 *   POST /remote-ops — an account has queued write-backs; replay them now
 *   GET  /health
 */

import { Hono, type Context } from 'hono';
import { secretMatches } from '@owlat/shared/constantTimeEqual';

/** http(s) only, and the origin must be one of the configured Convex origins. */
export function isAllowedEmlUrl(raw: string, allowedOrigins: string[]): boolean {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
	return allowedOrigins.includes(url.origin);
}
import { serve, type ServerType } from '@hono/node-server';
import { isSmtpError } from '@owlat/smtp-client';
import type { ConvexClient } from './convex.js';
import { fetchWorkerCredentials } from './convex.js';
import type { MailSyncConfig } from './config.js';
import { sendViaExternal, testConnection } from './send.js';
import type { ProtocolCreds, RecipientResult } from './send.js';
import { logger } from './logger.js';

interface TestBody {
	imap: ProtocolCreds;
	smtp: ProtocolCreds;
}
interface SendBody {
	externalAccountId: string;
	from: string;
	recipients: string[];
	rawEmlUrl: string;
}

/**
 * Asks the account's live connection to replay its write-back queue; false when
 * the worker holds no connection for it (`AccountManager.requestRemoteOps`).
 */
export type RemoteOpsRequester = (accountId: string) => boolean;

export function startServer(
	config: MailSyncConfig,
	convex: ConvexClient,
	requestRemoteOps: RemoteOpsRequester
): ServerType {
	const app = new Hono();

	const auth = async (c: Context, next: () => Promise<void>) => {
		const token = c.req.header('Authorization')?.replace('Bearer ', '');
		if (!secretMatches(token, config.apiKey)) {
			return c.json({ error: 'Unauthorized' }, 401);
		}
		await next();
	};
	app.use('/send', auth);
	app.use('/test', auth);
	app.use('/remote-ops', auth);

	app.get('/health', (c) => c.json({ ok: true, service: 'owlat-mail-sync' }));

	app.post('/test', async (c) => {
		const body = (await c.req.json().catch(() => null)) as TestBody | null;
		if (!body?.imap || !body?.smtp) {
			return c.json({ error: 'imap and smtp credentials required' }, 400);
		}
		return c.json(await testConnection(body));
	});

	// Fire-and-forget: the drain runs on the account's connection, and the
	// backend only needs to know the nudge arrived.
	app.post('/remote-ops', async (c) => {
		const body = (await c.req.json().catch(() => null)) as { accountId?: unknown } | null;
		if (typeof body?.accountId !== 'string' || !body.accountId) {
			return c.json({ error: 'accountId required' }, 400);
		}
		return c.json({ accepted: requestRemoteOps(body.accountId) }, 202);
	});

	app.post('/send', async (c) => {
		const body = (await c.req.json().catch(() => null)) as SendBody | null;
		if (
			!body?.externalAccountId ||
			!body.from ||
			!Array.isArray(body.recipients) ||
			!body.rawEmlUrl
		) {
			return c.json({ error: 'externalAccountId, from, recipients, rawEmlUrl required' }, 400);
		}

		const credentialsResult = await fetchWorkerCredentials(convex, body.externalAccountId);
		if (credentialsResult.kind !== 'credentials') {
			// A revoked authorization is reported in the words the user has to act
			// on: this message is what the outbound dispatcher records as the send's
			// failure reason, and "credentials unavailable" would tell them nothing.
			return c.json(
				{
					error:
						credentialsResult.reason === 'auth_revoked'
							? 'account authorization was revoked; reconnect the mailbox'
							: 'account credentials unavailable',
				},
				404
			);
		}
		const creds = credentialsResult.credentials;

		// SSRF guard: the only legitimate rawEmlUrl is a Convex storage URL.
		// Without this, anyone holding the internal API key could turn the
		// worker into a generic internal-network fetcher.
		if (!isAllowedEmlUrl(body.rawEmlUrl, config.allowedFetchOrigins)) {
			return c.json({ error: 'rawEmlUrl origin not allowed' }, 400);
		}

		const fetched = await fetch(body.rawEmlUrl);
		if (!fetched.ok) {
			return c.json({ error: `failed to fetch raw eml: ${fetched.status}` }, 502);
		}
		const raw = Buffer.from(await fetched.arrayBuffer());

		try {
			const result = await sendViaExternal(creds, {
				from: body.from,
				recipients: body.recipients,
				raw,
			});
			return c.json(result);
		} catch (err) {
			// A client-side SMTPUTF8 refusal (the external server does not advertise
			// RFC 6531 for an internationalized envelope) is a PERMANENT condition —
			// there is no ASCII downgrade for a non-ASCII local-part. Surface it like a
			// per-recipient bounce (terminal, non-retryable) instead of a generic 502,
			// so the Convex caller records it hard rather than re-driving it, matching
			// the MTA and API-relay paths (`SMTPUTF8_UNSUPPORTED`).
			if (isSmtpError(err) && err.clientRefusal === 'smtputf8-unavailable') {
				logger.warn(
					{ accountId: body.externalAccountId },
					'external send refused: server lacks SMTPUTF8 for internationalized envelope'
				);
				const recipients: RecipientResult[] = body.recipients.map((address) => ({
					address,
					status: 'bounced',
					error:
						'Recipient/sender address requires SMTPUTF8 (RFC 6531) but the SMTP server does not support it',
				}));
				return c.json({ recipients });
			}
			const message = err instanceof Error ? err.message : String(err);
			logger.warn({ accountId: body.externalAccountId, err }, 'external send failed');
			return c.json({ error: message }, 502);
		}
	});

	const server = serve({ fetch: app.fetch, hostname: config.listenAddress, port: config.port });
	logger.info({ port: config.port }, 'mail-sync HTTP server listening');
	return server;
}
