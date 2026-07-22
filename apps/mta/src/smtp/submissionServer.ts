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
 *   - per-recipient job fan-out off the RFC5322 header recipients, the From
 *     forgery 553 5.7.1 guard for Postbox sessions, and AMP `text/x-amp-html`
 *     recovery, all in the DATA hook;
 *   - the per-IP connection cap (onConnect) + counter release (socket close),
 *     whose Redis state stays in {@link module:submissionSecurity}.
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
} from '@owlat/smtp-listener';
import {
	parseMessage,
	parseMimeTree,
	walkLeaves,
	transferDecode,
	type AddressObject,
} from '@owlat/mail-message';
import { timingSafeStringEqual } from '../auth/timingSafe.js';
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
import { randomUUID } from 'crypto';
import { reserveNewIntakeReceipt } from '../routes/sendReceipt.js';
import {
	checkConnectionRateLimit,
	releaseConnection,
	checkAuthThrottle,
	recordAuthFailure,
	clearAuthFailures,
} from './submissionSecurity.js';
import { createSlotTracker } from '../lib/connectionSlots.js';

/**
 * Hard cap for buffered submitted MIME (advertised via EHLO SIZE AND enforced by
 * the listener's byte budget — I4). Tracks the shared per-attachment cap so a
 * message can always carry a max-size file.
 */
const MAX_SUBMISSION_BYTES = MAX_ATTACHMENT_BYTES;

/** The authenticated identity of a submission session. */
export interface AuthenticatedSession {
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

/**
 * AUTH handler: master key -> per-org credential -> Postbox app password.
 * Exported (factory form) so the auth chain is unit-testable.
 *
 * Every path that fails records a per-IP failure and is gated by a per-IP
 * failed-attempt throttle, so the master key and per-org credentials cannot be
 * brute-forced by reconnecting (RFC 4954 §4). The listener collapses every
 * failure to one `535 5.7.8` on the wire (no auth oracle — D6), so the throttle
 * rejection is byte-identical to a wrong secret.
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
			if (timingSafeStringEqual(apiKey, config.apiKey)) {
				session.state.auth = { organizationId: '__master__', credentialName: 'master' };
				await clearAuthFailures(redis, remoteIp).catch(() => {});
				return { ok: true, user: 'master' };
			}

			// Per-org credential (campaigns / transactional path).
			const credential = await lookupCredential(redis, apiKey);
			if (credential) {
				session.state.auth = {
					organizationId: credential.organizationId,
					credentialName: credential.name,
				};
				await clearAuthFailures(redis, remoteIp).catch(() => {});
				return { ok: true, user: credential.name };
			}

			// Postbox app password (per-user) — username MUST be the mailbox address.
			// Skip the round-trip if it doesn't look like an email.
			if (username && username.includes('@')) {
				const result = await verifyPostboxAppPassword(
					config,
					username,
					apiKey,
					'smtp',
					clientName(session)
				);
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
					await clearAuthFailures(redis, remoteIp).catch(() => {});
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

/** Collect the bare addresses of a parsed address header into `out`. */
function collectAddresses(field: AddressObject | AddressObject[] | undefined, out: string[]): void {
	if (!field) return;
	const objs = Array.isArray(field) ? field : [field];
	for (const obj of objs) {
		for (const entry of obj.value) {
			if (entry.address) out.push(entry.address);
		}
	}
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
 * normalized for nested non-`message/*` leaves (mailMime parity), so a multi-line
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

			const recipients: string[] = [];
			collectAddresses(parsed.to, recipients);
			collectAddresses(parsed.cc, recipients);
			collectAddresses(parsed.bcc, recipients);

			if (recipients.length === 0) {
				return { code: 554, enhanced: '5.5.0', text: 'No valid recipients' };
			}

			const fromAddress = firstFrom(parsed.from);
			const fromDomain = emailDomain(fromAddress);

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

			// Fan out: one job per recipient.
			let queued = 0;
			for (const to of recipients) {
				// Postbox-prefixed messageId so the bounce/sent webhook can look the
				// row back up — same convention as the webmail dispatch path.
				const messageId = authData.postbox
					? `pb-smtp-${authData.postbox.mailboxId}-${randomUUID()}`
					: `smtp-${randomUUID()}`;
				const job: EmailJob = {
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

				await reserveNewIntakeReceipt(redis, job.intakeReceiptId, job.messageId);
				await queue.add({
					groupId,
					data: job,
					orderMs: priorityToOrderMs(priority),
					jobId: job.intakeReceiptId,
				});
				queued++;
			}

			logger.info(
				{ from: fromAddress, recipients: recipients.length, queued },
				'SMTP submission accepted'
			);
			return;
		} catch (err) {
			logger.error({ err }, 'SMTP submission processing error');
			return { code: 451, enhanced: '4.3.0', text: 'Processing failed' };
		}
	};
}

/**
 * Per-IP connection cap (onConnect) — mirrors the bounce server so the AUTH
 * paths can't be brute-forced by opening many parallel connections. Exported so
 * the limiter is unit-testable. Returns a `421` rejection over the cap, nothing
 * to accept; fails open on a Redis hiccup so a store fault can't lock out
 * legitimate clients.
 *
 * The GLOBAL `maxClients` cap is enforced first (smtp-server order) with a real
 * `421` retry-later reply — NOT a silent socket destroy. `net.Server.maxConnections`
 * would drop an over-cap connection with no banner, so a client sees an abrupt TCP
 * close instead of the `421 Too many connected clients` smtp-server sent (and that a
 * well-behaved client re-queues on). `isOverCapacity` reads the listener's live
 * connection count (wired in {@link buildSubmissionListener}); it is omitted in the
 * direct per-IP unit tests, where the global gate is a no-op.
 *
 * When (and ONLY when) {@link checkConnectionRateLimit} actually holds a slot for
 * this connection (net +1 on the Redis counter — i.e. the connection was allowed,
 * NOT rejected over the cap), `onSlotHeld` is invoked so the caller can release
 * exactly that slot on socket close. This is load-bearing: on 465 the raw TCP
 * `connection` event fires before the TLS handshake, so a plaintext / aborted
 * handshake never reaches this hook (no increment); a rejected connection is
 * incremented-then-decremented inside `checkConnectionRateLimit` (net 0). Neither
 * takes a slot, so neither is marked — and the close handler must not release one,
 * else an attacker could drive a victim IP's counter down (465 cap bypass) or a
 * 421-refused connect could double-decrement (587).
 */
export function buildOnConnect(
	deps: Pick<SubmissionDeps, 'redis' | 'config'>,
	onSlotHeld?: (session: Session) => void,
	isOverCapacity?: () => boolean
) {
	const { redis, config } = deps;
	return async function onConnect(session: Session): Promise<SmtpHandlerResult> {
		const remoteIp = sessionRemoteIp(session);
		// Global concurrent-connection cap first (smtp-server order): a real 421 so
		// the client retries later instead of reading an abrupt close as a failure.
		if (isOverCapacity?.()) {
			logger.warn({ remoteIp }, 'Submission server at max concurrent clients');
			return {
				code: 421,
				enhanced: '4.7.0',
				text: 'Too many connected clients, try again in a moment',
			};
		}
		try {
			const allowed = await checkConnectionRateLimit(
				redis,
				remoteIp,
				config.submissionMaxConnectionsPerIp
			);
			if (!allowed) {
				logger.warn({ remoteIp }, 'Submission server connection rate limited');
				return { code: 421, enhanced: '4.7.0', text: 'Too many connections from your IP' };
			}
			onSlotHeld?.(session); // net +1 held — release exactly this slot on close
			return;
		} catch (err) {
			logger.error({ err, remoteIp }, 'Error in submission onConnect rate limit check');
			return; // Fail-open so a Redis hiccup doesn't block legitimate clients.
		}
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
 */
function submissionTls(config: MtaConfig): SmtpTlsConfig {
	assertSubmissionTlsConfigured(config.submissionTlsCert, config.submissionTlsKey);
	return { cert: config.submissionTlsCert!, key: config.submissionTlsKey! };
}

/**
 * Build a submission listener. The 587 (STARTTLS) and 465 (implicit-TLS) flavors
 * are behaviorally identical post-AUTH — only the transport differs
 * (`implicitTls`). AUTH is refused until the channel is secure (`requireTls`),
 * MAIL is refused until AUTH succeeds, and recipients are taken from the message
 * headers (not the SMTP envelope) exactly as the previous listener did.
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

	// Reconciles per-IP slot increments against socket lifetime. It marks a slot for
	// release only for connections that actually incremented in `onConnect`, so the
	// 465 raw-accept never decrements a slot it never took (cap bypass) and a
	// 421-refused connect never double-decrements (587) — and it self-heals the race
	// where a connection RSTs while its async rate-limit check is still in flight.
	const slots = createSlotTracker(redis, releaseConnection);

	// Live concurrent-connection count for the global `maxClients` cap. Every
	// accepted socket increments it on the raw `connection` event and decrements it
	// on close. `createSmtpListener` registers its OWN accept handler first, and that
	// handler synchronously runs the synchronous prefix of `onConnect` — including
	// `isOverCapacity()` — before its first `await`. So the counting handler MUST run
	// ahead of the accept handler (`prependListener`, below) or the increment lands
	// after the capacity check and the connection under decision is excluded from its
	// own count (off-by-one). Prepending makes `onConnect` see a count that includes
	// the deciding connection — matching smtp-server's `connections.size > maxClients`.
	const liveConnections = { count: 0 };

	const listener = createSmtpListener<SubmissionSessionState>({
		// The 220 greeting + EHLO open with this name (RFC 5321 §4.2). It MUST be
		// the FQDN that matches the IP's reverse-DNS PTR record so the announced
		// identity stays consistent with reverse DNS.
		hostname: config.ehloHostname,
		banner: `${config.ehloHostname} Owlat SMTP Submission`,
		maxMessageBytes: MAX_SUBMISSION_BYTES, // advertised via EHLO SIZE; enforced in the loop
		tls,
		implicitTls,
		auth: {
			mechanisms: ['PLAIN', 'LOGIN'],
			requireTls: true, // AUTH only after the channel is encrypted (RFC 4954 §4)
			authenticate: buildAuthenticate({ redis, config }),
		},
		createSession: () => ({}),
		onConnect: buildOnConnect(
			{ redis, config },
			(session) => {
				// Mark this connection as holding a slot so — and only so — its socket
				// close releases it. If the peer already left while the rate-limit check
				// was in flight, `hold` releases the increment immediately instead.
				slots.hold(session);
			},
			() => liveConnections.count > config.submissionMaxClients
		),
		// Submission never relays unauthenticated: refuse MAIL FROM until AUTH.
		onMailFrom: buildOnMailFrom(),
		onData: buildOnData({ queue, redis }),
		onError: (err) => logger.error({ err }, 'SMTP submission listener error'),
	});

	// Global concurrent-connection cap — preserves smtp-server's `maxClients`, but as
	// a REAL `421 Too many connected clients` reply (see `buildOnConnect`), not node's
	// silent `net.Server.maxConnections` socket destroy which drops an over-cap client
	// with no banner. Maintain the live-connection count here and register every
	// accepted connection with the slot tracker, which releases the per-IP counter on
	// socket close — but ONLY for connections that actually took a slot. The limiter
	// state lives in submissionSecurity.ts (I8); the listener exposes only the socket,
	// so the release is wired here on the raw server's `connection` event (emitted for
	// both the plaintext 587 and implicit-TLS 465 servers). The raw event fires on TCP
	// accept — for 465 that is BEFORE the TLS handshake, so a failed/plaintext
	// handshake connection never reaches `onConnect` and thus never releases a slot it
	// never incremented (cap bypass). Tracking the live connection at accept also lets
	// `hold` self-heal a connection that RSTs while its async rate-limit check is still
	// pending. `prependListener` runs this AHEAD of the listener's internal accept
	// handler so `count` includes the connection under decision when `onConnect` runs
	// its synchronous `isOverCapacity()` check (see the `liveConnections` note above).
	listener.raw.prependListener('connection', (socket) => {
		liveConnections.count += 1;
		socket.once('close', () => {
			liveConnections.count -= 1;
		});
		slots.track(socket);
	});

	return listener;
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
