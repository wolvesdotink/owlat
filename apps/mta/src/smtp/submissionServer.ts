/**
 * SMTP Submission Server (587 STARTTLS + 465 implicit-TLS)
 *
 * Accepts authenticated outbound email for traditional mail clients and apps.
 * Built on the in-house `@owlat/smtp-listener` (replacing `smtp-server`) and
 * `@owlat/mail-message` (`parseMessage`, replacing `mailparser`): the byte
 * budget, the STARTTLS / implicit-TLS transports, the no-oracle SASL exchange
 * and the RFC 3207 state reset are the listener's; this module supplies the
 * submission-specific policy as typed listener hooks —
 *
 *   - the AUTH chain (master key -> per-org credential -> Postbox app password)
 *     as the listener's single `authenticate` hook, gated by the per-IP
 *     failed-AUTH throttle (RFC 4954 §4, OWASP brute-force);
 *   - a require-auth-before-MAIL gate (submission never relays unauthenticated);
 *   - per-recipient job fan-out off the authenticated SMTP envelope, the From
 *     forgery 553 5.7.1 guard for Postbox sessions, and AMP `text/x-amp-html`
 *     recovery, all in the DATA hook;
 *   - connection admission (the global cap and the per-IP counter in
 *     lib/connectionSlots.ts), which the listener applies on 587 and, before
 *     the TLS handshake, on 465.
 *
 * The old `sessionAuth` WeakMap is gone: the authenticated identity lives in the
 * listener's typed per-connection session state ({@link SubmissionSessionState}).
 */

import {
	createSmtpListener,
	type SmtpListener,
	type SmtpSession,
	type SmtpHandlerResult,
	type SmtpAuthOutcome,
	type SmtpAddress,
	type SmtpTlsConfig,
	type SmtpAdmission,
} from '@owlat/smtp-listener';
import {
	parseMessage,
	parseMimeTree,
	walkLeaves,
	transferDecode,
	type AddressObject,
} from '@owlat/mail-message';
import { secretMatches } from '@owlat/shared/constantTimeEqual';
import type { Queue } from 'groupmq';
import type Redis from 'ioredis';
import type { EmailJob } from '../types.js';
import type { MtaConfig } from '../config.js';
import { assertSubmissionTlsConfigured } from '../config.js';
import { lookupCredential } from '../auth/credentials.js';
import { verifyPostboxAppPassword } from '../auth/postboxAuth.js';
import { buildGroupKey, extractDomain } from '../queue/groups.js';
import { mapToPriority, priorityToOrderMs } from '../intelligence/engagementPriority.js';
import { logger } from '../monitoring/logger.js';
import { MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import { emailDomain } from '@owlat/shared/spfAlignment';
import { enqueueReconciledIntake } from '../queue/intakeEnqueue.js';
import { checkAuthThrottle, recordAuthFailure } from './submissionSecurity.js';
import { createConnectionLimiter } from '../lib/connectionSlots.js';
import {
	bindSubmissionClientRequest,
	normalizeEnvelopeAddress,
	resolveSubmissionIdentity,
	SUBMISSION_DEDUPLICATION_MAIL_PARAMETER,
	SUBMISSION_IDEMPOTENCY_MAIL_PARAMETER,
	submissionRecipientJobId,
} from './submissionIdentity.js';

/**
 * Hard cap for buffered submitted MIME (advertised via EHLO SIZE AND enforced by
 * the listener's byte budget — I4). Tracks the shared per-attachment cap so a
 * message can always carry a max-size file.
 */
const MAX_SUBMISSION_BYTES = MAX_ATTACHMENT_BYTES;

/** Deliberate 587/465 command-idle policy (the listener default is 5 minutes). */
export const SUBMISSION_COMMAND_TIMEOUT_MS = 120_000;

/** The authenticated identity of a submission session. */
export interface AuthenticatedSession {
	organizationId: string;
	credentialName: string;
	/**
	 * The organization's verified sending domains (lowercased) for a per-org
	 * credential session. When present, the DATA hook rejects a From whose domain
	 * is not in this set (H2 cross-tenant From-forgery guard). Absent for the
	 * master session (broad send) and for legacy credentials created before the
	 * field existed — see {@link OrgCredential.allowedDomains}.
	 */
	allowedDomains?: readonly string[];
	/** Set when authenticated via a Postbox app password (per-user). */
	postbox?: {
		mailboxId: string;
		mailboxAddress: string;
		appPasswordId: string;
		userId: string;
	};
}

/**
 * Typed per-connection listener state. Replaces the old `sessionAuth` WeakMap:
 * the `authenticate` hook writes {@link SubmissionSessionState.auth} on success
 * and the DATA hook reads it back — no side table, no forgeable posture.
 */
export interface SubmissionSessionState {
	auth?: AuthenticatedSession;
}

type Session = SmtpSession<SubmissionSessionState>;

/** Dependencies for the exported handler factories (DI for tests). */
export interface SubmissionDeps {
	queue: Queue<EmailJob>;
	redis: Redis;
	config: MtaConfig;
}

/**
 * Best-effort client identifier for the app-password "Last used" column — the
 * EHLO/HELO name the client announced. (The old smtp-server path also consulted
 * a reverse-DNS `clientHostname`; the in-house listener performs no reverse DNS,
 * so the announced EHLO name is the single source — see the PR body.)
 */
function clientName(session: Session): string | undefined {
	const ehlo = typeof session.clientHostname === 'string' ? session.clientHostname.trim() : '';
	return ehlo || undefined;
}

/** Best-effort remote IP from the session (for throttling / limiting). */
function sessionRemoteIp(session: Session): string {
	return session.remoteAddress || 'unknown';
}

function submissionRecipients(session: Session): string[] {
	const seen = new Set<string>();
	const recipients: string[] = [];
	for (const recipient of session.rcptTo) {
		const normalized = normalizeEnvelopeAddress(recipient.address);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		recipients.push(normalized);
	}
	return recipients;
}

/**
 * AUTH handler: master key -> per-org credential -> Postbox app password.
 * Exported (factory form) so the auth chain is unit-testable.
 *
 * Every path that fails records a per-IP failure and is gated by a per-IP
 * failed-attempt throttle, so the master key and per-org credentials cannot be
 * brute-forced by reconnecting (RFC 4954 §4). A successful AUTH leaves the
 * counter alone, so it cannot be used to refill the budget. The listener
 * collapses every failure to one `535 5.7.8` on the wire (no auth oracle — D6),
 * so the throttle rejection is byte-identical to a wrong secret.
 */
export function buildAuthenticate(deps: Pick<SubmissionDeps, 'redis' | 'config'>) {
	const { redis, config } = deps;
	return async function authenticate(
		credentials: { username: string; password: string },
		session: Session
	): Promise<SmtpAuthOutcome> {
		const remoteIp = sessionRemoteIp(session);
		// Record the failure and fail generically so we never leak which AUTH path
		// the secret was rejected by.
		const fail = async (logCtx?: Record<string, unknown>): Promise<SmtpAuthOutcome> => {
			try {
				await recordAuthFailure(redis, remoteIp);
			} catch (err) {
				logger.error({ err, remoteIp }, 'Failed to record SMTP auth failure');
			}
			if (logCtx) logger.warn(logCtx, 'SMTP auth failed');
			return { ok: false };
		};

		// Throttle gate: refuse AUTH once an IP has burned its failure budget within
		// the window, checked before any secret comparison so a flood of guesses is
		// cut off rather than running the full chain each time.
		let allowed = true;
		try {
			allowed = await checkAuthThrottle(redis, remoteIp, config.submissionMaxAuthFailuresPerIp);
		} catch (err) {
			// Fail-open on throttle-store errors so Redis hiccups don't lock out
			// legitimate clients; the master-key compare is still constant-time-safe.
			logger.error({ err, remoteIp }, 'SMTP auth throttle check failed');
		}
		if (!allowed) {
			logger.warn({ remoteIp }, 'SMTP auth throttled — too many failed attempts');
			return { ok: false };
		}

		const apiKey = credentials.password;
		const username = credentials.username;
		if (!apiKey) {
			return fail();
		}

		try {
			// Master key — constant-time compare like every other secret check.
			if (secretMatches(apiKey, config.apiKey)) {
				session.state.auth = { organizationId: '__master__', credentialName: 'master' };
				return { ok: true, user: 'master' };
			}

			// Per-org credential (campaigns / transactional path).
			const credential = await lookupCredential(redis, apiKey);
			if (credential) {
				session.state.auth = {
					organizationId: credential.organizationId,
					credentialName: credential.name,
					...(credential.allowedDomains ? { allowedDomains: credential.allowedDomains } : {}),
				};
				return { ok: true, user: credential.name };
			}

			// Postbox app password (per-user) — username MUST be the mailbox address.
			// Skip the round-trip if it doesn't look like an email.
			if (username && username.includes('@')) {
				const result = await verifyPostboxAppPassword(config, username, apiKey, 'smtp', {
					clientName: clientName(session),
					remoteIp,
				});
				if (result) {
					session.state.auth = {
						organizationId: result.organizationId,
						credentialName: `postbox:${username.toLowerCase()}`,
						postbox: {
							mailboxId: result.mailboxId,
							mailboxAddress: username.toLowerCase(),
							appPasswordId: result.appPasswordId,
							userId: result.userId,
						},
					};
					return { ok: true, user: username };
				}
			}

			return fail({ username, remoteIp });
		} catch (err) {
			logger.error({ err }, 'SMTP auth error');
			return fail();
		}
	};
}

/** The first From address, lowercased (identity for the forgery guard + DKIM domain). */
function firstFrom(field: AddressObject | AddressObject[] | undefined): string {
	if (!field) return '';
	const obj = Array.isArray(field) ? field[0] : field;
	return obj?.value[0]?.address?.toLowerCase() ?? '';
}

/**
 * Recover the AMP alternative (`text/x-amp-html`) from a raw (binary-string)
 * message, if present. `parseMessage` neither folds a `text/x-amp-html` part
 * into `html`/`text` nor (absent a filename/attachment disposition) surfaces it
 * in `attachments`, so the AMP alternative is recovered by walking the MIME tree
 * directly — preserving the behavior the old `mailparser`-attachment path
 * provided (RFC 2046 §5.1.4).
 *
 * The first `text/x-amp-html` leaf in document order wins, decoded with the
 * package's single `transferDecode` (7bit / QP / base64 — one decoder, no second
 * copy). NOTE (sanctioned divergence, PR body): `MimeNode.rawBody` is CRLF→LF
 * normalized for nested non-`message/*` leaves, so a multi-line
 * AMP document's `job.amp` carries LF line endings rather than the wire's CRLF.
 * This is immaterial: the sender re-encodes the part when re-emitting it, applying
 * canonical CRLF + transfer-encoding on the way out.
 */
function extractAmpHtml(binary: string): string | undefined {
	let amp: string | undefined;
	walkLeaves(parseMimeTree(binary), (leaf) => {
		if (amp !== undefined) return; // first-in-document-order wins
		if (leaf.contentType.value !== 'text/x-amp-html') return;
		const bytes = transferDecode(leaf.rawBody, leaf.headers.last('content-transfer-encoding'));
		amp = Buffer.from(bytes).toString('utf-8');
	});
	return amp;
}

/**
 * DATA handler: parse the body, extract recipients, enforce the From-forgery
 * guard for Postbox sessions, and fan out one queue job per recipient. Exported
 * for tests. Returns a rejection {@link SmtpHandlerResult} to refuse, or nothing
 * to accept with the listener's default 250.
 */
export function buildOnData(deps: Pick<SubmissionDeps, 'queue' | 'redis'>) {
	const { queue, redis } = deps;
	return async function onData(message: Buffer, session: Session): Promise<SmtpHandlerResult> {
		try {
			const authData = session.state.auth;
			if (!authData) {
				return { code: 530, enhanced: '5.7.0', text: 'Authentication required' };
			}

			// The listener hands us the fully-buffered, byte-budget-bounded (I4),
			// dot-decoded message. `parseMessage` reads it as a binary string.
			const binary = message.toString('latin1');
			const parsed = parseMessage(binary);

			const recipients = submissionRecipients(session);

			if (recipients.length === 0) {
				return { code: 554, enhanced: '5.5.0', text: 'No valid recipients' };
			}

			const fromAddress = firstFrom(parsed.from);
			const fromDomain = emailDomain(fromAddress);
			const envelope = session.mailFrom;
			if (!envelope?.address) {
				return { code: 503, enhanced: '5.5.1', text: 'MAIL FROM required' };
			}
			const identity = resolveSubmissionIdentity(authData, envelope, parsed.headers, message);
			if (!identity.ok) {
				return { code: 554, enhanced: '5.5.4', text: identity.message };
			}

			// RFC 2046 §5.1.4: preserve the AMP alternative so the sender re-emits the
			// `text/x-amp-html` part (see {@link extractAmpHtml}).
			const amp = extractAmpHtml(binary);

			// Postbox sessions MUST send From: their bound mailbox. Anyone who
			// exfiltrates an app password should not be able to forge identities.
			if (authData.postbox && fromAddress !== authData.postbox.mailboxAddress) {
				logger.warn(
					{ expected: authData.postbox.mailboxAddress, got: fromAddress },
					'SMTP submission rejected — From-address mismatch'
				);
				return {
					code: 553,
					enhanced: '5.7.1',
					text: 'From address must match authenticated mailbox',
				};
			}

			// Per-org credential sessions (not Postbox, not the master key) MUST send
			// From a domain in their organization's verified-sending-domain set (H2).
			// Otherwise a per-org credential could send From any domain and — before
			// the org-scoped DKIM guard — have it signed with another tenant's key.
			// The master session (organizationId '__master__') carries no allowedDomains
			// and keeps broad send; legacy credentials with none recorded stay unscoped
			// here (the DKIM signer is the fail-closed backstop). A present-but-empty
			// set authorizes no domain (fail-closed).
			if (!authData.postbox && authData.allowedDomains) {
				const allowed = new Set(authData.allowedDomains.map((domain) => domain.toLowerCase()));
				if (!allowed.has(fromDomain)) {
					logger.warn(
						{ organizationId: authData.organizationId, fromDomain },
						'SMTP submission rejected — From domain not in organization verified set'
					);
					return {
						code: 553,
						enhanced: '5.7.1',
						text: 'From domain is not authorized for this organization',
					};
				}
			}

			const clientRequestBinding = await bindSubmissionClientRequest(redis, identity, recipients);
			if (clientRequestBinding === 'conflict' || clientRequestBinding === 'recipient-expansion') {
				return {
					code: 554,
					enhanced: '5.5.4',
					text:
						clientRequestBinding === 'conflict'
							? 'Idempotency key is already bound to different message content or sender'
							: 'Idempotency key cannot add recipients after first use',
				};
			}

			// Fan out: one job per recipient.
			let queued = 0;
			for (const to of recipients) {
				// Postbox-prefixed messageId so the bounce/sent webhook can look the
				// row back up — same convention as the webmail dispatch path.
				const prefix = authData.postbox ? `pb-smtp-${authData.postbox.mailboxId}` : 'smtp';
				const messageId = submissionRecipientJobId(prefix, identity.fingerprint, to);
				const job: EmailJob & { intakeReceiptId: string } = {
					messageId,
					intakeReceiptId: messageId,
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

				await enqueueReconciledIntake(queue, redis, {
					groupId,
					data: job,
					orderMs: priorityToOrderMs(priority),
				});
				queued++;
			}

			logger.info(
				{
					from: fromAddress,
					recipients: recipients.length,
					queued,
					submissionIdentityMode: identity.mode,
				},
				'SMTP submission accepted'
			);
			return;
		} catch (err) {
			logger.error({ err }, 'SMTP submission processing error');
			return { code: 451, enhanced: '4.3.0', text: 'Processing failed' };
		}
	};
}

/** Per-IP connection counters for 587 and 465 (key prefix and window are deploy-stable). */
const SUBMISSION_CONNECTION_PREFIX = 'mta:submission:conn:';
const SUBMISSION_CONNECTION_TTL_SECONDS = 300;

/**
 * Connection admission for both submission listeners, so the AUTH paths cannot
 * be brute-forced over many parallel connections. The global `maxClients` cap
 * answers a real `421 4.7.0` retry-later reply rather than node's silent
 * `net.Server.maxConnections` destroy, and the per-IP cap answers `421 4.7.0`
 * too. A Redis fault fails open inside the listener. On 465 the listener admits
 * before the TLS handshake, where no reply is possible and refused sockets are
 * destroyed; 587 and 465 share one counter per IP.
 */
function submissionAdmission(config: MtaConfig, redis: Redis): SmtpAdmission {
	return {
		maxClients: config.submissionMaxClients,
		overCapacityReply: {
			code: 421,
			enhanced: '4.7.0',
			text: 'Too many connected clients, try again in a moment',
		},
		perIp: {
			...createConnectionLimiter(
				redis,
				SUBMISSION_CONNECTION_PREFIX,
				SUBMISSION_CONNECTION_TTL_SECONDS,
				config.submissionMaxConnectionsPerIp
			),
			rejectReply: { code: 421, enhanced: '4.7.0', text: 'Too many connections from your IP' },
		},
		onRefused: (peer, reason) =>
			logger.warn(
				{ remoteIp: peer.remoteAddress },
				reason === 'capacity'
					? 'Submission server at max concurrent clients'
					: 'Submission server connection rate limited'
			),
	};
}

/**
 * Require-auth-before-MAIL gate: submission never relays unauthenticated, so
 * MAIL FROM is refused with `530 5.7.0` until AUTH has succeeded on the (already
 * TLS-secured) channel. Exported as a factory for symmetry with the other hook
 * factories and so the gate is directly testable.
 */
export function buildOnMailFrom() {
	return function onMailFrom(_address: SmtpAddress, session: Session): SmtpHandlerResult {
		return session.authenticated
			? undefined
			: { code: 530, enhanced: '5.7.0', text: 'Authentication required' };
	};
}

/**
 * Hardened TLS material shared by both submission listeners. The STARTTLS (587)
 * and implicit-TLS (465) flavors present the same cert and inherit the listener's
 * AEAD-only TLS 1.2+ cipher floor (copied verbatim from this file's former inline
 * policy — see `@owlat/smtp-listener` `DEFAULT_SMTP_CIPHERS`). Asserts the
 * cert/key are present first so neither listener can be built over plaintext
 * (RFC 8314 §3.3).
 *
 * `handshakeTimeoutMs` is the pre-session sibling of the listener's
 * `timeouts.commandMs`: on the implicit-TLS listener the command idle timer does
 * not exist yet, so this is the ONLY bound on a peer that completes the TCP
 * handshake and then stalls. It is ignored on the 587 listener, whose STARTTLS
 * upgrade runs with the explicit 120 s command idle timer already armed.
 *
 * 30 SECONDS, and it is a policy number, not a tuning knob — hence a literal
 * rather than an env var:
 *
 *  - The floor is set by legitimate LOSS, not by slow clients. The server does
 *    the expensive part of a handshake, so the pathological honest case is a
 *    lossy mobile link retransmitting the ClientHello: RFC 6298 starts the RTO
 *    at 1 s and doubles it, so three consecutive losses cost ~7 s and four cost
 *    ~15 s. A single-digit window would cut off a real client at three or four
 *    losses; 30 s leaves ~2x headroom over four.
 *  - The ceiling is set by LOG VOLUME. The teardown in `@owlat/smtp-listener`'s
 *    `server.ts` logs on exactly this path, so the sustained attacker-driven
 *    line rate is (connections they can hold) / (this window): every factor
 *    shaved off the window multiplies it, into a container log with no rotation
 *    policy. 30 s is 4x node's 120 s default, which is a bounded, deliberate
 *    increase rather than an open-ended one.
 *  - It is conservative against every comparable: Postfix `smtpd_starttls_timeout`
 *    300 s (10 s only in stress mode), Dovecot ~3 min, nginx
 *    `ssl_handshake_timeout` 60 s, node 120 s — and the `smtp-server` package
 *    this path replaced had NO handshake timeout at all. In-repo precedent for
 *    rejecting a library's long default is `bounce/server.ts`, which pins its
 *    idle timers at 60 s.
 *
 * Read `createImplicitTlsServer`'s note in `@owlat/smtp-listener` before going
 * lower: enforcing the deadline resets a handshake that is merely slow, which is
 * free today (no `SNICallback` is supplied anywhere) but would not be for a
 * multi-cert deployment whose SNI resolver does a network or database lookup.
 */
function submissionTls(config: MtaConfig): SmtpTlsConfig {
	assertSubmissionTlsConfigured(config.submissionTlsCert, config.submissionTlsKey);
	return {
		cert: config.submissionTlsCert!,
		key: config.submissionTlsKey!,
		handshakeTimeoutMs: 30_000,
	};
}

/**
 * Build a submission listener. The 587 (STARTTLS) and 465 (implicit-TLS) flavors
 * are behaviorally identical post-AUTH — only the transport differs
 * (`implicitTls`). AUTH is refused until the channel is secure (`requireTls`),
 * MAIL is refused until AUTH succeeds, and delivery recipients come from the
 * authenticated SMTP envelope; To/Cc/Bcc headers are display content only.
 */
function buildSubmissionListener(
	queue: Queue<EmailJob>,
	redis: Redis,
	config: MtaConfig,
	implicitTls: boolean
): SmtpListener {
	// Refuse to construct an insecure listener: without TLS material STARTTLS
	// cannot be required before AUTH (RFC 8314 §3.3). Fail fast.
	const tls = submissionTls(config);

	return createSmtpListener<SubmissionSessionState>({
		// The 220 greeting + EHLO open with this name (RFC 5321 §4.2). It MUST be
		// the FQDN that matches the IP's reverse-DNS PTR record so the announced
		// identity stays consistent with reverse DNS.
		hostname: config.ehloHostname,
		banner: `${config.ehloHostname} Owlat SMTP Submission`,
		extensions: [SUBMISSION_IDEMPOTENCY_MAIL_PARAMETER, SUBMISSION_DEDUPLICATION_MAIL_PARAMETER],
		maxMessageBytes: MAX_SUBMISSION_BYTES, // advertised via EHLO SIZE; enforced in the loop
		// A silent 587/STARTTLS peer should not occupy a submission slot for the
		// listener default of five minutes. Two minutes still leaves ample room for
		// an authenticated client sending DATA over a slow link.
		timeouts: { commandMs: SUBMISSION_COMMAND_TIMEOUT_MS },
		tls,
		implicitTls,
		auth: {
			mechanisms: ['PLAIN', 'LOGIN'],
			requireTls: true, // AUTH only after the channel is encrypted (RFC 4954 §4)
			authenticate: buildAuthenticate({ redis, config }),
		},
		createSession: () => ({}),
		admission: submissionAdmission(config, redis),
		// Submission never relays unauthenticated: refuse MAIL FROM until AUTH.
		onMailFrom: buildOnMailFrom(),
		onData: buildOnData({ queue, redis }),
		onError: (err) => logger.error({ err }, 'SMTP submission listener error'),
	});
}

/**
 * Create the SMTP submission listener (port 587 — STARTTLS upgrade).
 *
 * The connection opens in plaintext, the listener advertises STARTTLS, and AUTH
 * is refused until STARTTLS has upgraded the channel (RFC 3207 / RFC 4954 §4 /
 * RFC 8314 §3.3). Unlike the old smtp-server path, AUTH is NOT advertised in the
 * pre-STARTTLS EHLO response (the listener gates the capability on the live TLS
 * posture), so the capability list and the refusal agree.
 */
export function createSubmissionServer(
	queue: Queue<EmailJob>,
	redis: Redis,
	config: MtaConfig
): SmtpListener {
	return buildSubmissionListener(queue, redis, config, false);
}

/**
 * Create the implicit-TLS SMTP submission listener (port 465).
 *
 * RFC 8314 §3.3 / §7.3 makes implicit TLS (the whole connection wrapped in TLS
 * from the first byte) the PREFERRED submission transport: the client never
 * speaks a plaintext byte, so there is no cleartext window in which AUTH could be
 * stripped. Shares the exact AUTH chain, DATA fan-out, per-IP connection cap and
 * TLS hardening with the 587 listener; only the transport differs.
 */
export function createImplicitTlsSubmissionServer(
	queue: Queue<EmailJob>,
	redis: Redis,
	config: MtaConfig
): SmtpListener {
	return buildSubmissionListener(queue, redis, config, true);
}

/** Start a submission listener on the configured port. */
export function startSubmissionServer(server: SmtpListener, port: number): Promise<void> {
	return server.listen(port).then(() => {
		logger.info({ port }, 'SMTP submission server listening');
	});
}
