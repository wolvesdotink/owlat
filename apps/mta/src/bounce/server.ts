/**
 * Inbound MX / bounce SMTP listener (port 25) for bounce DSNs, ARF/FBL reports,
 * personal-mailbox (Postbox) mail and routed inbound mail.
 *
 * Built on the in-house `@owlat/smtp-listener` (replacing `smtp-server`) and
 * `@owlat/mail-message` (`parseMessage`, replacing `mailparser`): the byte budget
 * (I4), the STARTTLS transport, the RFC 3207 state reset and the hostile-input
 * hardening are the listener's. This module supplies the MX-specific policy as
 * typed listener hooks and admission: the global and per-IP connection caps
 * (the listener's `admission`, counter in lib/connectionSlots.ts, I8) and the
 * tarpit for admitted external peers (onConnect); the inbound-TLS gate + SPF authentication of
 * a non-null MAIL FROM (onMailFrom), stashing the RFC 7208 verdict on the typed
 * {@link BounceTransaction} state (replacing the old `SessionWithSpf` widening);
 * the VERP / personal-mailbox / route RCPT gate with structured 552/550 replies
 * (onRcptTo); and the Bounce intake pipeline over a `ParsedMessage` (onData),
 * which ACKs malformed/unattributed input but returns a transient 451 when
 * authenticated feedback cannot reach durable storage.
 */

import {
	createSmtpListener,
	type SmtpListener,
	type SmtpSession,
	type SmtpAddress,
	type SmtpHandlerResult,
	type SmtpTlsConfig,
	type SmtpAdmission,
} from '@owlat/smtp-listener';
import { parseMessage } from '@owlat/mail-message';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';
import { emailDomain } from '@owlat/shared/spfAlignment';
import { isPrivateOrLoopbackIp, unmapIpv4 } from '@owlat/shared/ipAddress';
import { MAX_INBOUND_MESSAGE_BYTES } from '@owlat/shared/attachments';
import { createConnectionLimiter } from '../lib/connectionSlots.js';
import { checkSpf, evaluateDmarc, dnsDmarcLookup, verifyDkim } from '@owlat/mail-auth';
import { createInboundAuthResolvers } from './inboundAuthResolver.js';
import { verifyArcChain } from './inboundArc.js';
import { runPipeline } from './pipeline.js';
import { mainPipeline } from './phases/index.js';
import { dmarcFromIdentity } from '../inbound/parsedAddress.js';
import type { SpfVerdict } from './types.js';
import { inboundTlsRequiredReply, isInboundTlsRequired } from '../inbound/inboundTlsPolicy.js';
import { TransientFeedbackProcessingError } from './transientFeedbackError.js';
import { processBounceAttempt } from './attemptProcessor.js';
import { recordDeliverabilityProbeIfPresent } from './deliverabilityProbe.js';
import { buildOnRcptTo } from './recipientGate.js';
export { buildOnRcptTo } from './recipientGate.js';

/**
 * Hard cap for buffered inbound MIME (advertised via EHLO SIZE AND
 * wire-enforced by the listener).
 *
 * Shared with the backend rather than spelled here: the API's per-attachment
 * AI-ingest ceiling is only a real gate while it stays under what this listener
 * can deliver, and a local copy is how the two drift apart.
 */
const MAX_INBOUND_BYTES = MAX_INBOUND_MESSAGE_BYTES;

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
	deliverabilityProbeToken?: string;
}

type BounceSession = SmtpSession<unknown, BounceTransaction>;

/**
 * AckAndSwallowErrors — the explicit at-least-once decision (I2 e). The MX
 * listener answers malformed, unattributed, and best-effort processing failures
 * with the default 250: a remote MTA must not amplify backscatter by retrying
 * bytes we cannot act on. Authenticated feedback whose durable storage is
 * transiently unavailable is the narrow exception and receives 451. Returning
 * `undefined` emits the default 250 data-accepted reply.
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

	// STARTTLS is offered when cert+key are configured, or from the moment
	// bounce/tlsReload.ts installs a pair published after boot. The listener applies
	// the hardened TLS floor by default (TLSv1.2, AEAD-only ECDHE, honorCipherOrder —
	// `@owlat/smtp-listener` DEFAULT_SMTP_CIPHERS), matching the former inline policy.
	const tls: SmtpTlsConfig | undefined =
		config.bounceServerTlsCert && config.bounceServerTlsKey
			? { cert: config.bounceServerTlsCert, key: config.bounceServerTlsKey }
			: undefined;
	if (tls) {
		logger.info('Bounce server TLS configured — STARTTLS will be offered (TLSv1.2+ enforced)');
	}

	return createSmtpListener<unknown, BounceTransaction>({
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

		// Global concurrent-connection cap + per-IP connection cap.
		admission: bounceAdmission(config, redis),

		// Tarpit for admitted peers outside loopback and RFC 1918.
		onConnect: buildOnConnect(config),

		// Inbound-TLS gate + SPF authentication of the envelope sender.
		onMailFrom: buildOnMailFrom(config, redis, authResolvers),

		// VERP / personal-mailbox / route RCPT gate with structured 552/550 replies.
		onRcptTo: buildOnRcptTo(config, redis),

		// The Bounce intake pipeline over a `ParsedMessage`.
		onData: buildOnData(config, redis, authResolvers),

		onError: (err) => logger.error({ err }, 'Bounce SMTP listener error'),
	});
}

/** Per-IP connection counters for port 25 (key prefix and window are deploy-stable). */
const BOUNCE_CONNECTION_PREFIX = 'mta:bounce:conn:';
const BOUNCE_CONNECTION_TTL_SECONDS = 300;

/**
 * Connection admission for the MX listener. Over the GLOBAL `maxClients` cap the
 * connection gets a real `421` retry-later reply (smtp-server's `421 … Too many
 * connected clients`: a remote MTA re-queues on a 421 rather than treating a
 * bare close as a hard failure), and over the PER-IP cap it gets `421 4.7.0`
 * for the same reason: the sender retries later instead of failing the
 * delivery. The per-IP cap counts each address on its own, IPv6 included,
 * because large senders deliver from many hosts in one /64. A Redis fault fails
 * open inside the listener, so a store hiccup cannot block legitimate bounces.
 */
function bounceAdmission(config: MtaConfig, redis: Redis): SmtpAdmission {
	return {
		maxClients: config.bounceMaxClients,
		overCapacityReply: { code: 421, text: 'Too many connected clients, try again in a moment' },
		perIp: {
			...createConnectionLimiter(
				redis,
				BOUNCE_CONNECTION_PREFIX,
				BOUNCE_CONNECTION_TTL_SECONDS,
				config.bounceMaxConnectionsPerIp,
				unmapIpv4
			),
			rejectReply: { code: 421, enhanced: '4.7.0', text: 'Too many connections from your IP' },
		},
		onRefused: (peer, reason) =>
			logger.warn(
				{ remoteIp: peer.remoteAddress },
				reason === 'capacity'
					? 'Bounce server at max concurrent clients'
					: 'Bounce server connection rate limited'
			),
	};
}

/**
 * Tarpit (onConnect): deliberately slow down admitted peers outside loopback
 * and RFC 1918. Admission has already run, so this hook sees admitted
 * connections only.
 */
export function buildOnConnect(config: MtaConfig) {
	return async function onConnect(session: BounceSession): Promise<SmtpHandlerResult> {
		if (config.bounceTarpitEnabled && !isPrivateOrLoopbackIp(session.remoteAddress)) {
			await new Promise((resolve) => setTimeout(resolve, config.bounceTarpitDelayMs));
		}
	};
}

/**
 * Inbound-TLS gate + SPF authentication of the envelope sender (onMailFrom).
 *
 * A plaintext transaction is refused when the dynamic inbound-TLS policy requires
 * encryption (RFC 3207). For a null reverse-path (`MAIL FROM:<>`), SPF evaluates
 * the RFC5321.HELO identity instead of skipping authentication (RFC 7208 §2.4).
 * When `inboundSpfEnabled` and the applicable identity returns `fail`, the
 * transaction is rejected (RFC 7208 §8.4). The full RFC 7208 §2.6 verdict is stashed on the
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

		try {
			const heloIdentity = session.clientHostname || config.ehloHostname;
			const spfResult = await checkSpf(
				session.remoteAddress,
				address.address,
				heloIdentity,
				authResolvers.spf
			);

			// Record the full verdict (not just fail/accept) plus the envelope MAIL
			// FROM domain so `onData` can thread them into the payload for DMARC
			// alignment (RFC 7489 §3.1 — SPF authenticates the envelope, not From).
			session.transaction = {
				spfResult: spfResult.result,
				envelopeFromDomain:
					emailDomain(address.address) || heloIdentity.trim().toLowerCase().replace(/\.$/, ''),
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
 * The Bounce intake pipeline over a fully-received `ParsedMessage` (onData). The
 * listener hands the buffered, byte-budget-bounded (I4), dot-decoded message;
 * `parseMessage` reads it (replacing `mailparser`'s `simpleParser`). SPF / DKIM /
 * DMARC / ARC are evaluated over the raw bytes before parsing mangles
 * canonicalization, then the intake pipeline (parseFblOrDsn → resolveRoute →
 * attachmentMeta) classifies and the reducer runs the effects. The handler
 * ACKs by default, with a narrow transient-storage 451 exception — see
 * {@link AckAndSwallowErrors}.
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
			const fromIdentity = dmarcFromIdentity(parsed.from, parsed.rawFrom);
			const dmarc = config.inboundDmarcEnabled
				? await evaluateDmarc({
						fromDomain: fromIdentity.domain,
						fromAmbiguous: fromIdentity.invalid,
						spf: { result: spfResult ?? 'none', domain: envelopeFromDomain },
						dkim: {
							result: dkim?.result ?? 'none',
							domain: dkim?.domain,
							passingDomains: dkim?.passingDomains,
						},
						policyLookup: (domain) => dnsDmarcLookup(domain, authResolvers.dmarcTxt),
						logger,
					})
				: undefined;
			const dmarcResult = dmarc?.result;
			const dmarcPolicy = dmarc?.policy;

			const passingSignature = dkim?.signatures.find((signature) => signature.verdict === 'pass');
			if (
				await recordDeliverabilityProbeIfPresent(
					{
						recipientCount: session.rcptTo.length,
						...(session.transaction?.deliverabilityProbeToken
							? { acceptedToken: session.transaction.deliverabilityProbeToken }
							: {}),
						spfResult: spfResult ?? 'unknown',
						dkimResult: dkimResult ?? 'unknown',
						dmarcResult: dmarcResult ?? 'unknown',
						...(passingSignature?.selector ? { dkimSelector: passingSignature.selector } : {}),
						remoteAddress: session.remoteAddress,
						...(session.tlsProtocol ? { tlsProtocol: session.tlsProtocol } : {}),
					},
					config,
					redis
				)
			) {
				return AckAndSwallowErrors;
			}

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

			await processBounceAttempt(deps, piped.attempt, {
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

			return AckAndSwallowErrors;
		} catch (err) {
			logger.error({ err }, 'Error processing inbound email');
			if (err instanceof TransientFeedbackProcessingError) {
				return {
					code: 451,
					enhanced: '4.3.0',
					text: 'Attributed feedback persistence unavailable',
				};
			}
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
