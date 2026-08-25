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
 * which ACKs malformed/unattributed input but returns a transient 451 when
 * authenticated feedback cannot reach durable storage.
 */

import {
	createSmtpListener,
	type SmtpListener,
	type SmtpSession,
	type SmtpHandlerResult,
	type SmtpTlsConfig,
} from '@owlat/smtp-listener';
import { parseMessage } from '@owlat/mail-message';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';
import { checkConnectionRateLimit, releaseConnection } from './inboundSecurity.js';
import { createSlotTracker } from '../lib/connectionSlots.js';
import { evaluateDmarc, dnsDmarcLookup, verifyDkim } from '@owlat/mail-auth';
import { createInboundAuthResolvers } from './inboundAuthResolver.js';
import { verifyArcChain } from './inboundArc.js';
import { lookupOstrIpTier, type OstrLookupDeps, type OstrLookupOutcome } from './ostrLookup.js';
import { resolveOstrMessageContext, startBounceOstr } from './ostrWiring.js';
import { createOstrEvidenceCapture } from './ostrEvidence.js';
import { runPipeline } from './pipeline.js';
import { mainPipeline } from './phases/index.js';
import { dmarcFromIdentity } from '../inbound/parsedAddress.js';
import type { SpfVerdict } from './types.js';
import { isLocalAddress } from './serverHelpers.js';
import { TransientFeedbackProcessingError } from './transientFeedbackError.js';
import { processBounceAttempt } from './attemptProcessor.js';
import { recordDeliverabilityProbeIfPresent } from './deliverabilityProbe.js';
import { buildOnRcptTo } from './recipientGate.js';
import { buildOnMailFrom } from './senderGate.js';
export { buildOnRcptTo } from './recipientGate.js';
// The onMailFrom half lives beside the onRcptTo one (senderGate.ts /
// recipientGate.ts); re-exported so existing importers are unaffected.
export { buildOnMailFrom } from './senderGate.js';

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
	deliverabilityProbeToken?: string;
}

/**
 * Per-CONNECTION state, distinct from {@link BounceTransaction} because what it
 * holds is a fact about the peer rather than about one message: the OSTR tier
 * of the connecting IP, looked up once in `onConnect` (plan §12.2 — "IP tier
 * consulted at connection time") and read back by every transaction on the
 * connection. Keeping it off `transaction`, which the listener resets after
 * DATA, is what makes it once-per-connection rather than once-per-message.
 */
interface BounceConnection {
	/** In flight from `onConnect`; resolves to `none` when OSTR is off. */
	ostrIpTier?: Promise<OstrLookupOutcome>;
}

type BounceSession = SmtpSession<BounceConnection, BounceTransaction>;

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

	// OSTR (plan §12.2): one consumer client for the process — see ostrWiring.ts.
	const ostrWiring = startBounceOstr(config, authResolvers.ostrTxt);
	const ostr = ostrWiring.deps;

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

	const listener = createSmtpListener<BounceConnection, BounceTransaction>({
		// Per-connection state (see {@link BounceConnection}). Created empty for
		// EVERY connection so `onConnect` can record the OSTR IP lookup without
		// each handler having to wonder whether the object exists.
		createSession: () => ({}),
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
			() => liveConnections.count > config.bounceMaxClients,
			ostr
		),

		// Inbound-TLS gate + SPF authentication of the envelope sender.
		onMailFrom: buildOnMailFrom(config, redis, authResolvers),

		// VERP / personal-mailbox / route RCPT gate with structured 552/550 replies.
		onRcptTo: buildOnRcptTo(config, redis),

		// The Bounce intake pipeline over a `ParsedMessage`.
		onData: buildOnData(config, redis, authResolvers, ostr),

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

	// The snapshot refresh belongs to this listener: nothing else consumes the
	// registry, so a closed listener must not leave an hourly fetch behind it.
	listener.raw.once('close', () => ostrWiring.stop());

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
 *
 * It is also where the OSTR IP tier is asked for (plan §12.2), once per
 * admitted connection — see {@link BounceConnection}.
 */
export function buildOnConnect(
	config: MtaConfig,
	redis: Redis,
	onSlotHeld: (session: BounceSession) => void,
	isOverCapacity: () => boolean,
	ostr: OstrLookupDeps = { config, client: null }
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

			// OSTR §12.2: the IP half, at connection time, for an ADMITTED peer —
			// a refused connection is told nothing and asks nothing. Deliberately
			// not awaited: it resolves under the tarpit and the transaction that
			// follows, so by the time `onData` reads it the answer is in hand and
			// the per-message path carries at most the domain lookup.
			// `lookupOstrIpTier` neither throws nor rejects (see its module doc), so
			// this promise cannot become an unhandled rejection while it waits.
			if (session.state !== undefined) {
				session.state.ostrIpTier = lookupOstrIpTier(ostr, remoteIp);
			}

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
 * The Bounce intake pipeline over a fully-received `ParsedMessage` (onData). The
 * listener hands the buffered, byte-budget-bounded (I4), dot-decoded message;
 * `parseMessage` reads it (replacing `mailparser`'s `simpleParser`). SPF / DKIM /
 * DMARC / ARC are evaluated over the raw bytes before parsing mangles
 * canonicalization, then the intake pipeline (parseFblOrDsn → resolveRoute →
 * stageAttachments) classifies and the reducer runs the effects. The handler
 * ACKs by default, with a narrow transient-storage 451 exception — see
 * {@link AckAndSwallowErrors}.
 */
export function buildOnData(
	config: MtaConfig,
	redis: Redis,
	authResolvers: ReturnType<typeof createInboundAuthResolvers>,
	ostr: OstrLookupDeps = { config, client: null }
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

			// Observer mode (OSTR §7.2): tap the verifier as it works so the signature
			// that decided the verdict can be substantiated later. The tap is passive —
			// `@owlat/mail-auth` swallows anything the callback throws — and it is armed
			// only when the operator turned observer mode on, because it captures raw
			// signed headers and a point-in-time DNS key record.
			const evidenceCapture = config.ostrObserverEnabled ? createOstrEvidenceCapture() : undefined;

			// Verify inbound DKIM (RFC 6376) over the raw bytes before parsing mangles
			// canonicalization. Fail-open: a crash yields `temperror`, never a NACK.
			const dkim = config.inboundDkimEnabled
				? await verifyDkim(rawBuffer, {
						resolver: authResolvers.dkim,
						...(evidenceCapture !== undefined
							? { onSignatureEvidence: evidenceCapture.onSignatureEvidence }
							: {}),
					})
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

			// OSTR (plan §12.2): the registry signal for this message plus the DKIM
			// evidence an observer may later report on — both in ostrWiring.ts, which
			// also owns the "which signature is this message judged on" pick.
			const ostrContext = await resolveOstrMessageContext(ostr, {
				...(dkim?.passingDomains !== undefined ? { dkimPassingDomains: dkim.passingDomains } : {}),
				...(passingSignature?.domain !== undefined
					? { passingSignatureDomain: passingSignature.domain }
					: {}),
				fromDomain: fromIdentity.domain,
				...(session.state?.ostrIpTier !== undefined
					? { connectionIpTier: session.state.ostrIpTier }
					: {}),
				...(evidenceCapture !== undefined ? { evidenceCapture } : {}),
				...(parsed.messageId !== undefined ? { messageId: parsed.messageId } : {}),
				verifiedAt: new Date(),
			});

			const deps = { redis, config };
			// One ctx for both the pipeline and the effect runner: they classify and
			// act over the SAME message, so a field added to one must never be able to
			// go missing from the other.
			const ctx = {
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
				// Spread rather than assigned `undefined`: with OSTR off the payload
				// Convex receives must be byte-identical to the pre-OSTR one.
				...ostrContext,
			};
			const piped = await runPipeline(deps, mainPipeline, ctx);

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

			await processBounceAttempt(deps, piped.attempt, ctx);

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
