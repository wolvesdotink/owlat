/**
 * SMTP Submission Server (Port 587)
 *
 * Accepts outbound email via SMTP protocol with authentication.
 * Provides compatibility with traditional email clients and apps.
 */

import { SMTPServer } from 'smtp-server';
import { collectDataStream, messageTooLargeError } from '../lib/dataStream.js';
import { timingSafeStringEqual } from '../auth/timingSafe.js';
import { simpleParser } from 'mailparser';
import type { Queue } from 'groupmq';
import type Redis from 'ioredis';
import type { EmailJob } from '../types.js';
import type { MtaConfig } from '../config.js';
import { assertSubmissionTlsConfigured } from '../config.js';
import { lookupCredential } from '../auth/credentials.js';
import { verifyPostboxAppPassword } from '../auth/postboxAuth.js';
import { buildGroupKey, extractDomain } from '../queue/groups.js';
import { mapToPriority } from '../intelligence/engagementPriority.js';
import { logger } from '../monitoring/logger.js';
import { MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import { emailDomain } from '@owlat/shared/spfAlignment';
import { randomUUID } from 'crypto';
import {
	checkConnectionRateLimit,
	releaseConnection,
	checkAuthThrottle,
	recordAuthFailure,
	clearAuthFailures,
} from './submissionSecurity.js';

/**
 * Hard cap for buffered submitted MIME (advertised AND wire-enforced). Tracks
 * the shared per-attachment cap so a message can always carry a max-size file.
 */
const MAX_SUBMISSION_BYTES = MAX_ATTACHMENT_BYTES;

function priorityToOrderMs(priority: number): number {
	if (priority <= 3) return priority;
	return Date.now();
}

interface AuthenticatedSession {
	organizationId: string;
	credentialName: string;
	/** Set when authenticated via a Postbox app password (per-user). */
	postbox?: {
		mailboxId: string;
		mailboxAddress: string;
		appPasswordId: string;
		userId: string;
	};
}

// Store authenticated session data. Exported so handler tests can seed an
// authenticated session without driving a real SMTP dialogue.
export const sessionAuth = new WeakMap<object, AuthenticatedSession>();

/** Dependencies for the exported handler factories (DI for tests). */
export interface SubmissionDeps {
	queue: Queue<EmailJob>;
	redis: Redis;
	config: MtaConfig;
}

type SmtpAuth = { username?: string; password?: string };
type AuthCallback = (err: Error | null, response?: { user: string }) => void;
type DataCallback = (err?: Error | null) => void;

/**
 * Best-effort client identifier for the app-password "Last used" column —
 * the EHLO name the client announced (`hostNameAppearsAs`), falling back to
 * the resolved reverse-DNS hostname. Both are populated by smtp-server on
 * the session before AUTH.
 */
function smtpClientName(session: object): string | undefined {
	const s = session as { hostNameAppearsAs?: unknown; clientHostname?: unknown };
	const ehlo = typeof s.hostNameAppearsAs === 'string' ? s.hostNameAppearsAs.trim() : '';
	if (ehlo) return ehlo;
	const host = typeof s.clientHostname === 'string' ? s.clientHostname.trim() : '';
	return host || undefined;
}

/** Best-effort remote IP from the smtp-server session (for throttling). */
function sessionRemoteIp(session: object): string {
	const ip = (session as { remoteAddress?: unknown }).remoteAddress;
	return typeof ip === 'string' && ip ? ip : 'unknown';
}

/**
 * AUTH handler: master key -> per-org credential -> Postbox app password.
 * Exported (factory form) so the auth chain is unit-testable.
 *
 * Every AUTH path that fails records a per-IP failure and is gated by a
 * per-IP failed-attempt throttle, so the master key and per-org credentials
 * cannot be brute-forced by reconnecting (RFC 4954 §4, OWASP brute-force).
 */
export function buildOnAuth(deps: Pick<SubmissionDeps, 'redis' | 'config'>) {
	const { redis, config } = deps;
	return async function onAuth(auth: SmtpAuth, session: object, callback: AuthCallback): Promise<void> {
		const remoteIp = sessionRemoteIp(session);
		// Record the failure + reuse the generic failure message so we never
		// leak which AUTH path the secret was rejected by.
		const fail = async (logCtx?: Record<string, unknown>): Promise<void> => {
			try {
				await recordAuthFailure(redis, remoteIp);
			} catch (err) {
				logger.error({ err, remoteIp }, 'Failed to record SMTP auth failure');
			}
			if (logCtx) logger.warn(logCtx, 'SMTP auth failed');
			callback(new Error('Authentication failed'));
		};

		try {
			// Throttle gate: refuse AUTH once an IP has burned its failure budget
			// within the window. Checked before any secret comparison so a flood
			// of guesses gets cut off rather than running the full chain each time.
			let allowed = true;
			try {
				allowed = await checkAuthThrottle(redis, remoteIp, config.submissionMaxAuthFailuresPerIp);
			} catch (err) {
				// Fail-open on throttle-store errors so Redis hiccups don't lock
				// out legitimate clients; the master-key compare is still safe.
				logger.error({ err, remoteIp }, 'SMTP auth throttle check failed');
			}
			if (!allowed) {
				logger.warn({ remoteIp }, 'SMTP auth throttled — too many failed attempts');
				return callback(new Error('Too many failed authentication attempts'));
			}

			const apiKey = auth.password;
			const username = auth.username;
			if (!apiKey) {
				return fail();
			}

			// Master key — constant-time compare like every other secret check
			if (timingSafeStringEqual(apiKey, config.apiKey)) {
				sessionAuth.set(session, { organizationId: '__master__', credentialName: 'master' });
				await clearAuthFailures(redis, remoteIp).catch(() => {});
				return callback(null, { user: 'master' });
			}

			// Per-org credential (existing campaigns/transactional path)
			const credential = await lookupCredential(redis, apiKey);
			if (credential) {
				sessionAuth.set(session, {
					organizationId: credential.organizationId,
					credentialName: credential.name,
				});
				await clearAuthFailures(redis, remoteIp).catch(() => {});
				return callback(null, { user: credential.name });
			}

			// Postbox app password (per-user) — username MUST be the
			// mailbox address. Skip the round-trip if it doesn't look
			// like an email.
			if (username && username.includes('@')) {
				const result = await verifyPostboxAppPassword(
					config,
					username,
					apiKey,
					'smtp',
					smtpClientName(session)
				);
				if (result) {
					sessionAuth.set(session, {
						organizationId: result.organizationId,
						credentialName: `postbox:${username.toLowerCase()}`,
						postbox: {
							mailboxId: result.mailboxId,
							mailboxAddress: username.toLowerCase(),
							appPasswordId: result.appPasswordId,
							userId: result.userId,
						},
					});
					await clearAuthFailures(redis, remoteIp).catch(() => {});
					return callback(null, { user: username });
				}
			}

			await fail({ username, remoteIp });
		} catch (err) {
			logger.error({ err }, 'SMTP auth error');
			await fail();
		}
	};
}

/**
 * DATA handler: bounded buffering, recipient extraction, From-forgery guard
 * for Postbox sessions, per-recipient queue fan-out. Exported for tests.
 */
export function buildOnData(deps: Pick<SubmissionDeps, 'queue'>) {
	const { queue } = deps;
	return async function onData(
		stream: Parameters<typeof collectDataStream>[0],
		session: object,
		callback: DataCallback
	): Promise<void> {
		try {
			const authData = sessionAuth.get(session);
			if (!authData) {
				return callback(new Error('Not authenticated'));
			}

			// Bounded buffering: smtp-server's `size` option does not enforce
			// streamed bytes (see dataStream.ts).
			const collected = await collectDataStream(stream, MAX_SUBMISSION_BYTES);
			if (!collected.ok) {
				return callback(messageTooLargeError(MAX_SUBMISSION_BYTES));
			}
			const parsed = await simpleParser(collected.buffer);

			// Extract recipients
			const recipients: string[] = [];
			const addRecipients = (field: unknown) => {
				if (!field) return;
				const addrs = Array.isArray(field) ? field : [field];
				for (const addr of addrs) {
					if (addr.value) {
						for (const v of addr.value) {
							if (v.address) recipients.push(v.address);
						}
					}
				}
			};
			addRecipients(parsed.to);
			addRecipients(parsed.cc);
			addRecipients(parsed.bcc);

			if (recipients.length === 0) {
				return callback(new Error('No valid recipients'));
			}

			const fromAddress = parsed.from?.value?.[0]?.address?.toLowerCase() ?? '';
			const fromDomain = emailDomain(fromAddress);

			// RFC 2046 §5.1.4: preserve the AMP alternative. mailparser surfaces
			// a `text/x-amp-html` part as an attachment (no `parsed.amp`), so the
			// 587 submission path silently dropped AMP. Recover it and thread it
			// onto the job so the sender re-emits the `text/x-amp-html` part.
			const ampPart = parsed.attachments.find(
				(a) => a.contentType?.toLowerCase() === 'text/x-amp-html'
			);
			const amp = ampPart ? ampPart.content.toString('utf-8') : undefined;

			// Postbox sessions MUST send From: their bound mailbox. Anyone
			// who exfiltrates an app password should not be able to forge
			// arbitrary identities.
			if (authData.postbox && fromAddress !== authData.postbox.mailboxAddress) {
				logger.warn(
					{
						expected: authData.postbox.mailboxAddress,
						got: fromAddress,
					},
					'SMTP submission rejected — From-address mismatch'
				);
				return callback(
					new Error('553 5.7.1 From address must match authenticated mailbox')
				);
			}

			// Fan out: one job per recipient
			let queued = 0;
			for (const to of recipients) {
				// Postbox-prefixed messageId so the bounce/sent webhook can
				// look the row back up — same convention as the webmail
				// dispatch path. Without a tracking row id we use a
				// placeholder so headers still flow through.
				const messageId = authData.postbox
					? `pb-smtp-${authData.postbox.mailboxId}-${randomUUID()}`
					: `smtp-${randomUUID()}`;
				const job: EmailJob = {
					messageId,
					to,
					from: fromAddress,
					subject: parsed.subject ?? '(no subject)',
					html: parsed.html || `<pre>${parsed.text ?? ''}</pre>`,
					text: parsed.text,
					...(amp ? { amp } : {}),
					ipPool: 'transactional',
					organizationId: authData.organizationId,
					dkimDomain: fromDomain,
					firstEnqueuedAt: Date.now(),
				};

				const domain = extractDomain(to);
				const groupId = buildGroupKey(job.ipPool, domain);
				const priority = mapToPriority(undefined);

				await queue.add({ groupId, data: job, orderMs: priorityToOrderMs(priority) });
				queued++;
			}

			logger.info(
				{ from: fromAddress, recipients: recipients.length, queued },
				'SMTP submission accepted'
			);

			callback();
		} catch (err) {
			logger.error({ err }, 'SMTP submission processing error');
			callback(new Error('Processing failed'));
		}
	};
}

/**
 * Hardened TLS material shared by both submission listeners — the STARTTLS
 * (587) and implicit-TLS (465) flavors present the same cert and the same
 * AEAD-only TLS 1.2+ cipher floor. Asserts the cert/key are present first so
 * neither listener can be built over plaintext (RFC 8314 §3.3).
 */
function submissionTlsOptions(config: MtaConfig): {
	cert: string;
	key: string;
	minVersion: 'TLSv1.2';
	ciphers: string;
	honorCipherOrder: true;
} {
	assertSubmissionTlsConfigured(config.submissionTlsCert, config.submissionTlsKey);
	return {
		cert: config.submissionTlsCert!,
		key: config.submissionTlsKey!,
		minVersion: 'TLSv1.2',
		ciphers: [
			'ECDHE-ECDSA-AES128-GCM-SHA256',
			'ECDHE-RSA-AES128-GCM-SHA256',
			'ECDHE-ECDSA-AES256-GCM-SHA384',
			'ECDHE-RSA-AES256-GCM-SHA384',
			'ECDHE-ECDSA-CHACHA20-POLY1305',
			'ECDHE-RSA-CHACHA20-POLY1305',
		].join(':'),
		honorCipherOrder: true,
	};
}

/**
 * Behavior shared by both submission listeners: identical AUTH chain, DATA
 * fan-out, per-IP connection cap, and connection-counter release. The only
 * difference between the 587 (STARTTLS) and 465 (implicit-TLS) flavors is
 * the transport (`secure` / `needsUpgrade`), so the handler wiring lives here
 * once to keep the two listeners behaviorally indistinguishable post-AUTH.
 */
function submissionHandlers(queue: Queue<EmailJob>, redis: Redis, config: MtaConfig) {
	return {
		// Per-IP connection cap — mirrors the bounce server so the AUTH paths
		// can't be brute-forced by opening many parallel connections.
		async onConnect(
			session: { remoteAddress: string },
			callback: (err?: Error | null) => void,
		): Promise<void> {
			const remoteIp = session.remoteAddress;
			try {
				const allowed = await checkConnectionRateLimit(
					redis,
					remoteIp,
					config.submissionMaxConnectionsPerIp
				);
				if (!allowed) {
					logger.warn({ remoteIp }, 'Submission server connection rate limited');
					return callback(new Error('Too many connections from your IP'));
				}
				callback();
			} catch (err) {
				logger.error({ err, remoteIp }, 'Error in submission onConnect rate limit check');
				callback(); // Fail-open so a Redis hiccup doesn't block legitimate clients
			}
		},

		// Release the per-IP connection counter on disconnect.
		onClose(session: { remoteAddress: string }): void {
			releaseConnection(redis, session.remoteAddress).catch(() => {
				// Non-critical
			});
		},

		// Auth: master key → per-org credential → Postbox app password
		async onAuth(
			auth: SmtpAuth,
			session: object,
			callback: AuthCallback,
		): Promise<void> {
			await buildOnAuth({ redis, config })(
				{ username: auth.username, password: auth.password },
				session,
				callback
			);
		},

		// Process submitted emails
		async onData(
			stream: Parameters<typeof collectDataStream>[0],
			session: object,
			callback: DataCallback,
		): Promise<void> {
			await buildOnData({ queue })(stream, session, callback);
		},
	};
}

/**
 * Create the SMTP submission server (port 587 — STARTTLS upgrade).
 *
 * Built with `secure: false` (and crucially WITHOUT `needsUpgrade`): the
 * connection opens in plaintext, the server advertises STARTTLS, and
 * smtp-server refuses AUTH until STARTTLS has upgraded the channel (RFC 3207 /
 * RFC 4954 §4 / RFC 8314 §3.3). An `AUTH` issued before STARTTLS is rejected by
 * the library with `538 Error: Must issue a STARTTLS command first` and never
 * reaches our `onAuth`.
 *
 * NOTE: `needsUpgrade: true` is deliberately NOT set. With that flag
 * smtp-server upgrades the raw socket to TLS *before* any banner — i.e. it
 * turns 587 into an implicit-TLS port, which (a) never speaks STARTTLS and (b)
 * breaks plain SMTP clients that expect a plaintext greeting on 587. Implicit
 * TLS belongs on its own port (465) — see
 * {@link createImplicitTlsSubmissionServer}.
 *
 * Known limitation: smtp-server advertises the `AUTH` capability in the
 * pre-STARTTLS EHLO response even though it refuses the verb. This is the
 * library's behavior; the gate that matters — refusing the AUTH command
 * itself before TLS — is enforced and regression-locked in the tests.
 */
export function createSubmissionServer(
	queue: Queue<EmailJob>,
	redis: Redis,
	config: MtaConfig
): SMTPServer {
	// Refuse to construct an insecure listener: without TLS material STARTTLS
	// cannot be required before AUTH, so credentials would be offered over
	// plaintext (RFC 8314 §3.3). Fail fast rather than booting a broken
	// listener. config.loadConfig() already guards this, but enforce it here
	// too so the listener can never be built without TLS.
	const tlsOptions = submissionTlsOptions(config);

	const server = new SMTPServer({
		secure: false, // Plaintext greeting; STARTTLS upgrade required before AUTH
		authMethods: ['PLAIN', 'LOGIN'],
		// The SMTP greeting + EHLO response open with this name (RFC 5321 §4.2).
		// It MUST be the FQDN that matches the IP's reverse-DNS PTR record, NOT
		// smtp-server's `os.hostname()` default (the container/host name has no
		// PTR), so the announced identity stays consistent with reverse DNS.
		name: config.ehloHostname,
		banner: `${config.ehloHostname} Owlat SMTP Submission`,
		size: MAX_SUBMISSION_BYTES, // advertised via EHLO SIZE; enforced in onData
		maxClients: config.submissionMaxClients,
		key: tlsOptions.key,
		cert: tlsOptions.cert,
		minVersion: tlsOptions.minVersion,
		ciphers: tlsOptions.ciphers,
		honorCipherOrder: tlsOptions.honorCipherOrder,
		...submissionHandlers(queue, redis, config),
	});

	return server;
}

/**
 * Create the implicit-TLS SMTP submission server (port 465).
 *
 * RFC 8314 §3.3 / §7.3 makes implicit TLS (the whole connection is wrapped in
 * TLS from the first byte) the PREFERRED submission transport over STARTTLS:
 * the client never speaks a plaintext byte, so there is no cleartext window in
 * which AUTH could be stripped/downgraded. Built with `secure: true` — the
 * 220 banner and every subsequent command travel over the encrypted channel.
 *
 * Shares the exact AUTH chain, DATA fan-out, per-IP connection cap and TLS
 * hardening with the 587 listener (see {@link submissionHandlers} /
 * {@link submissionTlsOptions}); only the transport differs.
 */
export function createImplicitTlsSubmissionServer(
	queue: Queue<EmailJob>,
	redis: Redis,
	config: MtaConfig
): SMTPServer {
	const tlsOptions = submissionTlsOptions(config);

	const server = new SMTPServer({
		secure: true, // Implicit TLS — encrypted from the first byte (RFC 8314 §3.3)
		authMethods: ['PLAIN', 'LOGIN'],
		// The SMTP greeting + EHLO response open with this name (RFC 5321 §4.2).
		// It MUST be the FQDN that matches the IP's reverse-DNS PTR record, NOT
		// smtp-server's `os.hostname()` default (the container/host name has no
		// PTR), so the announced identity stays consistent with reverse DNS.
		name: config.ehloHostname,
		banner: `${config.ehloHostname} Owlat SMTP Submission`,
		size: MAX_SUBMISSION_BYTES, // advertised via EHLO SIZE; enforced in onData
		maxClients: config.submissionMaxClients,
		key: tlsOptions.key,
		cert: tlsOptions.cert,
		minVersion: tlsOptions.minVersion,
		ciphers: tlsOptions.ciphers,
		honorCipherOrder: tlsOptions.honorCipherOrder,
		...submissionHandlers(queue, redis, config),
	});

	return server;
}

/**
 * Start the submission server on the configured port
 */
export function startSubmissionServer(server: SMTPServer, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		server.listen(port, () => {
			logger.info({ port }, 'SMTP submission server listening');
			resolve();
		});
		server.on('error', (err) => {
			logger.error({ err, port }, 'SMTP submission server error');
			reject(err);
		});
	});
}
