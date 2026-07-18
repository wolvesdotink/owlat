/**
 * Inbound MX / bounce SMTP listener (port 25) for bounce DSNs, ARF/FBL reports,
 * personal-mailbox (Postbox) mail and routed inbound mail.
 *
 * Built on the in-house `@owlat/smtp-listener` (replacing `smtp-server`) and
 * `@owlat/mail-message` (`parseMessage`, replacing `mailparser`): the byte budget
 * (I4), the STARTTLS transport, the RFC 3207 state reset and the hostile-input
 * hardening are the listener's. This module supplies the MX-specific policy as
 * typed listener hooks — a per-IP connection cap + tarpit (onConnect, limiter
 * state in inboundSecurity.ts, I8); the inbound-TLS gate + SPF authentication of
 * a non-null MAIL FROM (onMailFrom), stashing the RFC 7208 verdict on the typed
 * {@link BounceTransaction} state (replacing the old `SessionWithSpf` widening);
 * the VERP / personal-mailbox / route RCPT gate with structured 552/550 replies
 * (onRcptTo); and the Bounce intake pipeline over a `ParsedMessage` (onData),
 * which always ACKs (the explicit {@link AckAndSwallowErrors} decision).
 */

import {
	createSmtpListener,
	type SmtpListener,
	type SmtpSession,
	type SmtpAddress,
	type SmtpHandlerResult,
	type SmtpReply,
	type SmtpTlsConfig,
} from '@owlat/smtp-listener';
import { parseMessage } from '@owlat/mail-message';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import { findRoute } from '../inbound/router.js';
import { findMailboxRoute } from '../inbound/mailboxResolver.js';
import { logger } from '../monitoring/logger.js';
import { emailDomain } from '@owlat/shared/spfAlignment';
import { checkConnectionRateLimit, releaseConnection } from './inboundSecurity.js';
import { createSlotTracker } from '../lib/connectionSlots.js';
import { checkSpf, evaluateDmarc, dnsDmarcLookup, verifyDkim } from '@owlat/mail-auth';
import { createInboundAuthResolvers } from './inboundAuthResolver.js';
import { verifyArcChain } from './inboundArc.js';
import { runPipeline } from './pipeline.js';
import { mainPipeline } from './phases/index.js';
import { reduce } from './outcome.js';
import { applyEffects } from './effects.js';
import { firstAddress } from '../inbound/parsedAddress.js';
import type { SpfVerdict } from './types.js';
import { inboundTlsRequiredReply, isInboundTlsRequired } from '../inbound/inboundTlsPolicy.js';
import { logAttempt, isLocalAddress } from './serverHelpers.js';

/** Hard cap for buffered inbound MIME (advertised via EHLO SIZE AND wire-enforced by the listener). */
const MAX_INBOUND_BYTES = 10 * 1024 * 1024;

/**
 * Per-transaction session state carried through the listener. The SPF verdict
 * and envelope MAIL FROM domain are computed in `onMailFrom` (RFC 7208 §2.6) and
 * read back in `onData` to thread into the bounce ctx (RFC 8601). This replaces
 * the old `SessionWithSpf` widening of `smtp-server`'s untyped `SMTPServerSession`
 * — the listener resets `session.transaction` on RSET / after DATA / on a fresh
 * MAIL FROM, so the verdict cannot leak across transactions.
 */
interface BounceTransaction {
	spfResult?: SpfVerdict;
	envelopeFromDomain?: string;
}

type BounceSession = SmtpSession<unknown, BounceTransaction>;

/**
 * AckAndSwallowErrors — the explicit at-least-once decision (I2 e). The MX
 * listener ALWAYS answers a received message with the default 250, even when
 * downstream parsing / pipeline processing throws: a remote MTA must never be
 * told to retry a bounce/DSN whose bytes we already consumed (backscatter
 * amplification). Returning `undefined` emits the default 250 data-accepted reply.
 */
const AckAndSwallowErrors: SmtpHandlerResult = undefined;

/**
 * Create the MX / bounce processing SMTP listener.
 */
export function createBounceServer(config: MtaConfig, redis: Redis): SmtpListener {
	// One Redis-backed DNS cache shared across every inbound SPF/DMARC/DKIM
	// lookup this listener performs (verdict-equivalent caching, I2 f): a name
	// resolved for one check is served from cache for the next, and the SPF
	// §4.6.4 lookup budget — which counts real resolver CALLS — is unaffected.
	const authResolvers = createInboundAuthResolvers(redis);

	// STARTTLS is offered only when cert+key are configured. The listener applies
	// the hardened TLS floor by default (TLSv1.2, AEAD-only ECDHE, honorCipherOrder —
	// `@owlat/smtp-listener` DEFAULT_SMTP_CIPHERS), matching the former inline policy.
	const tls: SmtpTlsConfig | undefined =
		config.bounceServerTlsCert && config.bounceServerTlsKey
			? { cert: config.bounceServerTlsCert, key: config.bounceServerTlsKey }
			: undefined;
	if (tls) {
		logger.info('Bounce server TLS configured — STARTTLS will be offered (TLSv1.2+ enforced)');
	}

	// Reconciles per-IP connection increments against socket lifetime so every kept
	// increment is released EXACTLY once — the same held-slot bookkeeping the
	// submission listener uses. `checkConnectionRateLimit` nets 0 for a rejected
	// connection (increment-then-decrement) and +1 for an allowed one, so only the
	// allowed connections are marked for release on close; a connection that RSTs
	// while its async rate-limit check is still in flight self-heals.
	const slots = createSlotTracker(redis, releaseConnection);

	// Live concurrent-connection count for the global `maxClients` cap. Every
	// accepted socket increments it on the raw `connection` event and decrements
	// it on close. `createSmtpListener` registers its OWN accept handler first
	// (via `createServer(opts, cb)`), and that handler synchronously runs
	// `handleConnection → runCommandLoop`, writing the banner and executing the
	// synchronous prefix of `onConnect` — including `isOverCapacity()` — before
	// its first `await`. So the counting handler MUST run ahead of the accept
	// handler (`prependListener`, below) or the increment lands after the
	// capacity check and the connection under decision is excluded from its own
	// count (off-by-one: the cap would be `maxClients + 1`). Prepending makes
	// `onConnect` see a count that includes the deciding connection — matching
	// smtp-server's `connections.size > maxClients`.
	const liveConnections = { count: 0 };

	const listener = createSmtpListener<unknown, BounceTransaction>({
		// The 220 greeting + EHLO open with this name (RFC 5321 §4.2). It MUST be
		// the FQDN that matches the IP's reverse-DNS PTR record, or a connecting
		// MTA's banner/PTR consistency check fails.
		hostname: config.ehloHostname,
		banner: `${config.ehloHostname} Owlat MTA Bounce Processor`,
		maxMessageBytes: MAX_INBOUND_BYTES, // advertised via EHLO SIZE; enforced in the loop (I4)
		// Bounce/inbound intake is intentionally single-recipient: onData routes the
		// message using rcptTo[0]. Refuse any extra envelope recipient instead of
		// accepting and silently ignoring it, and keep hostile transaction state O(1).
		maxRecipients: 1,
		// Idle timeouts preserve the pre-cutover smtp-server `socketTimeout` (60 s,
		// one inactivity timer for the whole socket) rather than the listener's long
		// library defaults — a stalled command / DATA phase is torn down with the
		// listener's 421, not held for minutes.
		timeouts: {
			commandMs: config.bounceSocketTimeoutMs,
			dataMs: config.bounceSocketTimeoutMs,
		},
		...(tls ? { tls } : {}),

		// Global concurrent-connection cap + per-IP connection cap + tarpit.
		onConnect: buildOnConnect(
			config,
			redis,
			(session) => slots.hold(session),
			() => liveConnections.count > config.bounceMaxClients
		),

		// Inbound-TLS gate + SPF authentication of the envelope sender.
		onMailFrom: buildOnMailFrom(config, redis, authResolvers),

		// VERP / personal-mailbox / route RCPT gate with structured 552/550 replies.
		onRcptTo: buildOnRcptTo(config, redis),

		// The Bounce intake pipeline over a `ParsedMessage`.
		onData: buildOnData(config, redis, authResolvers),

		onError: (err) => logger.error({ err }, 'Bounce SMTP listener error'),
	});

	// Track every accepted connection: maintain the live-connection count for the
	// global cap, and release its per-IP slot on socket close — but ONLY for
	// connections that actually took a slot. The limiter state lives in
	// inboundSecurity.ts (I8); the listener exposes only the raw socket.
	// `prependListener` puts this AHEAD of the listener's internal accept handler
	// so `count` includes the connection under decision when `onConnect` runs its
	// synchronous `isOverCapacity()` check (see the `liveConnections` note above).
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
 * Per-IP connection cap (onConnect). Over the GLOBAL `maxClients` cap the
 * connection is refused with a real `421` retry-later reply (matching
 * smtp-server's `421 … Too many connected clients` — a remote MTA re-queues on a
 * 421 rather than treating a bare close as a hard failure); over the PER-IP cap
 * it is refused with `554` (byte-preserving the pre-cutover smtp-server
 * connect-reject default). Fails open on a Redis hiccup so a store fault can't
 * lock out senders. An admitted non-local peer is tarpitted before proceeding.
 * `onSlotHeld` runs only when a slot was actually held (net +1), so close
 * releases exactly that slot.
 */
export function buildOnConnect(
	config: MtaConfig,
	redis: Redis,
	onSlotHeld: (session: BounceSession) => void,
	isOverCapacity: () => boolean
) {
	return async function onConnect(session: BounceSession): Promise<SmtpHandlerResult> {
		const remoteIp = session.remoteAddress;
		// Global concurrent-connection cap first (smtp-server order): a real 421 so
		// the peer retries later instead of reading an abrupt close as a failure.
		if (isOverCapacity()) {
			logger.warn({ remoteIp }, 'Bounce server at max concurrent clients');
			return { code: 421, text: 'Too many connected clients, try again in a moment' };
		}
		try {
			const allowed = await checkConnectionRateLimit(
				redis,
				remoteIp,
				config.bounceMaxConnectionsPerIp
			);
			if (!allowed) {
				logger.warn({ remoteIp }, 'Bounce server connection rate limited');
				return { code: 554, text: 'Too many connections from your IP' };
			}
			onSlotHeld(session); // net +1 held — release exactly this slot on close

			// Tarpit: deliberately slow non-local connections down.
			if (config.bounceTarpitEnabled && !isLocalAddress(remoteIp)) {
				await new Promise((resolve) => setTimeout(resolve, config.bounceTarpitDelayMs));
			}
			return;
		} catch (err) {
			logger.error({ err, remoteIp }, 'Error in onConnect rate limit check');
			return; // Fail-open so a Redis hiccup doesn't block legitimate bounces.
		}
	};
}

/**
 * Inbound-TLS gate + SPF authentication of the envelope sender (onMailFrom).
 *
 * A plaintext transaction is refused when the dynamic inbound-TLS policy requires
 * encryption (RFC 3207). A genuine DSN uses the null reverse-path (`MAIL FROM:<>`,
 * surfaced by the listener as the empty address), which SPF cannot authenticate —
 * so it is accepted without an SPF lookup. A non-empty MAIL FROM is an identity
 * claim: when `inboundSpfEnabled` and SPF returns `fail` the transaction is
 * rejected (RFC 7208 §8.4). The full RFC 7208 §2.6 verdict is stashed on the
 * typed transaction state so `onData` can thread softfail / temperror / neutral
 * into the mailbox payload (RFC 8601).
 */
export function buildOnMailFrom(
	config: MtaConfig,
	redis: Redis,
	authResolvers: ReturnType<typeof createInboundAuthResolvers>
) {
	return async function onMailFrom(
		address: SmtpAddress,
		session: BounceSession
	): Promise<SmtpHandlerResult> {
		if ((await isInboundTlsRequired(redis)) && !session.secure) {
			logger.warn(
				{ remoteIp: session.remoteAddress, from: address.address },
				'Plaintext inbound SMTP transaction rejected — STARTTLS required'
			);
			return inboundTlsRequiredReply();
		}

		if (!config.inboundSpfEnabled) {
			return;
		}

		// Skip SPF for the null return path (DSN) — nothing to authenticate.
		if (!address.address || address.address === '<>') {
			return;
		}

		try {
			const spfResult = await checkSpf(
				session.remoteAddress,
				address.address,
				session.clientHostname || config.ehloHostname,
				authResolvers.spf
			);

			// Record the full verdict (not just fail/accept) plus the envelope MAIL
			// FROM domain so `onData` can thread them into the payload for DMARC
			// alignment (RFC 7489 §3.1 — SPF authenticates the envelope, not From).
			session.transaction = {
				spfResult: spfResult.result,
				envelopeFromDomain: emailDomain(address.address),
			};

			if (spfResult.result === 'fail') {
				logger.warn(
					{ remoteIp: session.remoteAddress, from: address.address, spf: spfResult },
					'SPF check failed — rejecting'
				);
				return { code: 550, text: 'SPF authentication failed' };
			}

			if (spfResult.result === 'softfail') {
				logger.info(
					{ remoteIp: session.remoteAddress, from: address.address, spf: spfResult },
					'SPF softfail — flagged but accepting'
				);
			}

			return;
		} catch (err) {
			// On SPF lookup failure, accept the message (fail-open to not block
			// bounces) but record the transient verdict so it is not silently lost.
			session.transaction = { spfResult: 'temperror' };
			logger.warn({ err, from: address.address }, 'SPF lookup error — accepting anyway');
			return;
		}
	};
}

/**
 * VERP / personal-mailbox / route RCPT gate (onRcptTo). VERP bounce/FBL addresses
 * are always accepted. A personal-mailbox hit is pre-flight quota-checked and
 * refused over quota with `552 5.2.2`. Everything else falls through to the
 * inbound route table (plus the TLS-RPT `_smtp._tls` rua system route, RFC 8460);
 * an unrouted or `reject`-mode recipient is refused `550`, a store fault `550`
 * (byte-preserving the pre-cutover smtp-server default).
 */
export function buildOnRcptTo(config: MtaConfig, redis: Redis) {
	return function onRcptTo(address: SmtpAddress): Promise<SmtpHandlerResult> | SmtpHandlerResult {
		// 1. VERP bounce/FBL addresses — always accept.
		if (address.address.startsWith('bounce+') || address.address.startsWith('fbl+')) {
			return;
		}

		// 2. Personal-mailbox lookup (Postbox) — Redis cache only.
		return findMailboxRoute(redis, address.address)
			.then((mailboxEntry): Promise<SmtpHandlerResult> | SmtpHandlerResult => {
				if (mailboxEntry) {
					// Pre-flight quota check (best-effort; SIZE may be unknown). The old
					// smtp-server path emitted `550 552 5.2.2 …` (its 550 default prefixed
					// the code embedded in the message); the structured reply corrects
					// this to the intended `552 5.2.2` (I2 c — corrected real SMTP codes).
					if (
						mailboxEntry.quotaBytes != null &&
						mailboxEntry.usedBytes >= mailboxEntry.quotaBytes
					) {
						return { code: 552, enhanced: '5.2.2', text: 'Mailbox over quota' };
					}
					return;
				}

				// 3. Fall through to the inbound route table + the TLS-RPT system route
				//    for the operator's `_smtp._tls` rua address (RFC 8460). The system
				//    config MUST be threaded here too, or the rua address is rejected
				//    "Mailbox not found" before onData ever runs.
				return findRoute(redis, address.address, {
					ruaAddress: config.tlsRptRua,
					convexSiteUrl: config.convexSiteUrl,
					webhookSecret: config.webhookSecret,
				})
					.then((route): SmtpHandlerResult => {
						if (route && route.mode !== 'reject') {
							return;
						}
						return { code: 550, text: 'Mailbox not found' };
					})
					.catch((): SmtpReply => ({ code: 550, text: 'Temporary error' }));
			})
			.catch((): SmtpReply => ({ code: 550, text: 'Temporary error' }));
	};
}

/**
 * The Bounce intake pipeline over a fully-received `ParsedMessage` (onData). The
 * listener hands the buffered, byte-budget-bounded (I4), dot-decoded message;
 * `parseMessage` reads it (replacing `mailparser`'s `simpleParser`). SPF / DKIM /
 * DMARC / ARC are evaluated over the raw bytes before parsing mangles
 * canonicalization, then the intake pipeline (parseFblOrDsn → resolveRoute →
 * stageAttachments) classifies and the reducer runs the effects. The handler
 * ALWAYS ACKs — see {@link AckAndSwallowErrors}.
 */
export function buildOnData(
	config: MtaConfig,
	redis: Redis,
	authResolvers: ReturnType<typeof createInboundAuthResolvers>
) {
	return async function onData(
		message: Buffer,
		session: BounceSession
	): Promise<SmtpHandlerResult> {
		try {
			// The raw bytes double as the parse input AND the original MIME forwarded
			// to Convex storage for personal-mailbox deliveries.
			const rawBuffer = message;
			const parsed = parseMessage(rawBuffer);
			const rcptTo = session.rcptTo[0]?.address;
			// SPF verdict + envelope MAIL FROM domain computed in `onMailFrom`.
			const spfResult = session.transaction?.spfResult;
			const envelopeFromDomain = session.transaction?.envelopeFromDomain;
			// SMTP envelope sender (RFC 5321 MAIL FROM). The listener surfaces the null
			// sender (`<>`) as the empty address; normalize to `''` so the vacation hook
			// suppresses auto-replies off the *envelope* (RFC 3834 §2), not `From:`.
			const envelopeFrom = session.mailFrom;
			const returnPath = envelopeFrom && envelopeFrom.address !== '<>' ? envelopeFrom.address : '';

			// Verify inbound DKIM (RFC 6376) over the raw bytes before parsing mangles
			// canonicalization. Fail-open: a crash yields `temperror`, never a NACK.
			const dkim = config.inboundDkimEnabled
				? await verifyDkim(rawBuffer, { resolver: authResolvers.dkim })
				: undefined;
			const dkimResult = dkim?.result;

			// Evaluate DMARC (RFC 7489): bind SPF + DKIM to the RFC5322.From domain via
			// alignment + the From-domain policy. Fail-open on a crash.
			const fromDomain = emailDomain(firstAddress(parsed.from) ?? '');
			const dmarc =
				config.inboundDmarcEnabled && fromDomain
					? await evaluateDmarc({
							fromDomain,
							spf: { result: spfResult ?? 'none', domain: envelopeFromDomain },
							dkim: { result: dkim?.result ?? 'none', domain: dkim?.domain },
							policyLookup: (domain) => dnsDmarcLookup(domain, authResolvers.dmarcTxt),
							logger,
						})
					: undefined;
			const dmarcResult = dmarc?.result;
			const dmarcPolicy = dmarc?.policy;

			// Verify the ARC chain (RFC 8617) over the raw bytes (Sealed Mail A5). The MTA
			// extracts the honest verdict; Convex applies the trusted-forwarder override.
			const arcVerdict = config.inboundArcEnabled
				? await verifyArcChain(rawBuffer, { resolver: authResolvers.arc })
				: undefined;
			const arcCv = arcVerdict?.cv;
			const arcSealerDomain = arcVerdict?.sealerDomain;
			const arcAttestsOriginalPass = arcVerdict?.attestsOriginalPass;

			const deps = { redis, config };
			const piped = await runPipeline(deps, mainPipeline, {
				parsed,
				rawBuffer,
				rcptTo,
				dkimResult,
				dmarcResult,
				dmarcPolicy,
				arcCv,
				arcSealerDomain,
				arcAttestsOriginalPass,
				spfResult,
				envelopeFromDomain,
				dkimSigningDomain: dkim?.domain,
				returnPath,
			});

			if (piped.kind === 'dropSilently') {
				return AckAndSwallowErrors;
			}

			if (piped.kind === 'continue') {
				// The main pipeline always classifies (the final phase always
				// `bounceTo`s). Reaching this branch means a future pipeline edit broke
				// that invariant — log and ACK.
				logger.warn(
					{ rcptTo, subject: parsed.subject },
					'Bounce pipeline returned continue without a classification'
				);
				return AckAndSwallowErrors;
			}

			logAttempt(piped.attempt, parsed);

			const { effects } = reduce(piped.attempt, {
				parsed,
				rawBuffer,
				rcptTo,
				dkimResult,
				dmarcResult,
				dmarcPolicy,
				arcCv,
				arcSealerDomain,
				arcAttestsOriginalPass,
				spfResult,
				envelopeFromDomain,
				dkimSigningDomain: dkim?.domain,
				returnPath,
			});
			await applyEffects(effects, deps);

			return AckAndSwallowErrors;
		} catch (err) {
			logger.error({ err }, 'Error processing inbound email');
			return AckAndSwallowErrors; // Accept anyway to prevent sender retries.
		}
	};
}

/**
 * Start the bounce listener on the configured port.
 */
export function startBounceServer(server: SmtpListener, port: number): Promise<void> {
	return server.listen(port).then(() => {
		logger.info({ port }, 'Bounce SMTP server listening');
	});
}
