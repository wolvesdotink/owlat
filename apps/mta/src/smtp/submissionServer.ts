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
 *
 * The AUTH hook lives in submissionAuth.ts, the DATA hook in submissionData.ts
 * and the session state they share in submissionSession.ts; this module
 * assembles them into the 587 and 465 listeners.
 */

import {
	createSmtpListener,
	type SmtpListener,
	type SmtpHandlerResult,
	type SmtpAddress,
	type SmtpTlsConfig,
	type SmtpAdmission,
} from '@owlat/smtp-listener';
import type { Queue } from 'groupmq';
import type Redis from 'ioredis';
import type { EmailJob } from '../types.js';
import type { MtaConfig } from '../config.js';
import { assertSubmissionTlsConfigured } from '../config.js';
import { logger } from '../monitoring/logger.js';
import { MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import { ipRateLimitKey } from '@owlat/shared/ipAddress';
import { createConnectionLimiter } from '../lib/connectionSlots.js';
import {
	SUBMISSION_DEDUPLICATION_MAIL_PARAMETER,
	SUBMISSION_IDEMPOTENCY_MAIL_PARAMETER,
} from './submissionIdentity.js';
import { buildAuthenticate } from './submissionAuth.js';
import { buildOnData } from './submissionData.js';
import type { SubmissionSession, SubmissionSessionState } from './submissionSession.js';

/**
 * Hard cap for buffered submitted MIME (advertised via EHLO SIZE AND enforced by
 * the listener's byte budget — I4). Tracks the shared per-attachment cap so a
 * message can always carry a max-size file.
 */
const MAX_SUBMISSION_BYTES = MAX_ATTACHMENT_BYTES;

/** Deliberate 587/465 command-idle policy (the listener default is 5 minutes). */
export const SUBMISSION_COMMAND_TIMEOUT_MS = 120_000;

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
				config.submissionMaxConnectionsPerIp,
				ipRateLimitKey
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
	return function onMailFrom(_address: SmtpAddress, session: SubmissionSession): SmtpHandlerResult {
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
