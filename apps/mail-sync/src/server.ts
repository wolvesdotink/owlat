/**
 * Internal HTTP surface for Convex → worker calls. Bearer-authenticated with
 * MAIL_SYNC_API_KEY, compared with `secretMatches` from
 * `@owlat/shared/constantTimeEqual` like the MTA's API key. No public ports —
 * reachable only over the compose network.
 *
 *   POST /send  — relay an outbound message through the account's external SMTP
 *   POST /test  — validate IMAP+SMTP credentials (persists nothing)
 *   POST /reconcile — re-read the connectable accounts now (a mailbox was just
 *                    connected or re-authorized); answers 202 at once
 *   POST /remote-ops — an account has queued write-backs; replay them now
 *   GET  /health
 *   GET  /metrics — Prometheus process metrics; unauthenticated like the MTA's,
 *                   since the port is not published
 */

import { Hono, type Context } from 'hono';
import { v } from 'convex/values';
import { decodeJson, type Checked, type JsonChecker } from '@owlat/worker-protocol/decodeJson';
import { secretMatches } from '@owlat/shared/constantTimeEqual';
import type { MetricsSource } from '@owlat/shared/nodeMetrics';

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
import { fileSentCopyInBackground, sendViaExternal, testConnection } from './send.js';
import type { RecipientResult } from './send.js';
import { logger } from './logger.js';

const protocolCreds = v.object({
	host: v.string(),
	port: v.number(),
	secure: v.boolean(),
	username: v.string(),
	password: v.string(),
	accessToken: v.optional(v.string()),
});
const testBody = v.object({ imap: protocolCreds, smtp: protocolCreds });
const sendBody = v.object({
	externalAccountId: v.string(),
	from: v.string(),
	recipients: v.array(v.string()),
	rawEmlUrl: v.string(),
});
const remoteOpsBody = v.object({ accountId: v.string() });

/** Every body here is a few fields, or one message's recipient list. */
const BODY_MAX_BYTES = 1024 * 1024;

/**
 * Read a route's JSON body to the checked value, or the 400/413 answering it.
 * `message` keeps each route's historic wording for a body that does not fit.
 */
async function readBody<C extends JsonChecker>(
	c: Context,
	checker: C,
	message: string
): Promise<{ ok: true; value: Checked<C> } | { ok: false; response: Response }> {
	const result = await decodeJson(c.req.raw, checker, BODY_MAX_BYTES);
	if (result.ok) return result;
	const { status } = result.failure;
	if (status !== 413) return { ok: false, response: c.json({ error: message }, status) };
	// A refused body may be partly unread, so the connection cannot carry
	// another request after it.
	c.header('Connection', 'close');
	return { ok: false, response: c.json({ error: result.failure.message }, status) };
}

/**
/**
 * Deadline for fetching the outgoing `.eml` back from Convex (at most 8 MiB, from
 * a storage proxy on the same network). A hung fetch answers 502 instead of
 * holding the send until the caller gives up.
 */
const RAW_EML_FETCH_TIMEOUT_MS = 30_000;

/**
 * Asks the account's live connection to replay its write-back queue; false when
 * the worker holds no connection for it (`AccountManager.requestRemoteOps`).
 */
export type RemoteOpsRequester = (accountId: string) => boolean;

/** What the routes need from the rest of the worker, beyond Convex. */
export interface ServerHooks {
	/** Start a reconcile pass without waiting for it (AccountManager.requestReconcile). */
	requestReconcile?: () => void;
	/** Replay one account's write-back queue (AccountManager.requestRemoteOps). */
	requestRemoteOps?: RemoteOpsRequester;
	/** The process registry served on `GET /metrics`; the route is absent without it. */
	metrics?: MetricsSource;
}

/** The worker's routes, without a listener (tests drive it through `app.request`). */
export function createApp(
	config: MailSyncConfig,
	convex: ConvexClient,
	hooks: ServerHooks = {}
): Hono {
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
	app.use('/reconcile', auth);
	app.use('/remote-ops', auth);

	app.get('/health', (c) => c.json({ ok: true, service: 'owlat-mail-sync' }));

	const { metrics } = hooks;
	if (metrics) {
		app.get('/metrics', async (c) =>
			c.body(await metrics.metrics(), 200, { 'Content-Type': metrics.contentType })
		);
	}

	// Convex pokes this after a connect so the new account's IMAP connection
	// opens now rather than on the next reconcile tick (up to 30 s later). The
	// pass itself runs in the background: the caller only needs to know the
	// worker heard it, and the account list is read from Convex, not from here.
	app.post('/reconcile', (c) => {
		hooks.requestReconcile?.();
		return c.json({ ok: true }, 202);
	});

	app.post('/test', async (c) => {
		const read = await readBody(c, testBody, 'imap and smtp credentials required');
		if (!read.ok) return read.response;
		return c.json(await testConnection(read.value));
	});

	// Fire-and-forget: the drain runs on the account's connection, and the
	// backend only needs to know the nudge arrived.
	app.post('/remote-ops', async (c) => {
		const read = await readBody(c, remoteOpsBody, 'accountId required');
		if (!read.ok) return read.response;
		const { accountId } = read.value;
		if (!accountId) return c.json({ error: 'accountId required' }, 400);
		return c.json({ accepted: hooks.requestRemoteOps?.(accountId) ?? false }, 202);
	});

	app.post('/send', async (c) => {
		const required = 'externalAccountId, from, recipients, rawEmlUrl required';
		const read = await readBody(c, sendBody, required);
		if (!read.ok) return read.response;
		const body = read.value;
		if (!body.externalAccountId || !body.from || !body.rawEmlUrl) {
			return c.json({ error: required }, 400);
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

		let raw: Buffer;
		try {
			const fetched = await fetch(body.rawEmlUrl, {
				signal: AbortSignal.timeout(RAW_EML_FETCH_TIMEOUT_MS),
			});
			if (!fetched.ok) {
				return c.json({ error: `failed to fetch raw eml: ${fetched.status}` }, 502);
			}
			raw = Buffer.from(await fetched.arrayBuffer());
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return c.json({ error: `failed to fetch raw eml: ${message}` }, 502);
		}

		try {
			const result = await sendViaExternal(creds, {
				from: body.from,
				recipients: body.recipients,
				raw,
			});
			// Filed AFTER the answer: the caller is waiting on SMTP's verdict, not
			// on a second login to the IMAP server. The copy never rejects (a
			// failure is logged at warn, as before), and shutdown waits for it.
			fileSentCopyInBackground(creds, raw);
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

	return app;
}

export function startServer(
	config: MailSyncConfig,
	convex: ConvexClient,
	hooks: ServerHooks = {}
): ServerType {
	const app = createApp(config, convex, hooks);
	const server = serve({ fetch: app.fetch, hostname: config.listenAddress, port: config.port });
	logger.info({ port: config.port }, 'mail-sync HTTP server listening');
	return server;
}
