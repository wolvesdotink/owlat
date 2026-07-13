/**
 * Inbound SMTP server for receiving bounce DSNs and ARF/FBL reports
 *
 * Listens on port 25 (configurable) and processes incoming emails to
 * VERP return-path addresses (bounce+{id}@bounces.owlat.com).
 *
 * Security features:
 * - Per-IP connection rate limiting
 * - Global maxClients cap
 * - Tarpit (deliberate slowdown) for suspicious connections
 * - SPF validation for inbound sender identity
 * - TLS minimum version enforcement
 */

import { SMTPServer } from 'smtp-server';
import { collectDataStream, messageTooLargeError } from '../lib/dataStream.js';
import { simpleParser } from 'mailparser';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import { findRoute } from '../inbound/router.js';
import { findMailboxRoute } from '../inbound/mailboxResolver.js';
import { logger } from '../monitoring/logger.js';
import { resolveTxt as dnsResolveTxt } from 'dns/promises';
import { emailDomain } from '@owlat/shared/spfAlignment';
import { checkConnectionRateLimit, releaseConnection, checkSpf } from './inboundSecurity.js';
import { verifyDkim } from './inboundDkim.js';
import { evaluateDmarc, dnsDmarcLookup } from './inboundDmarc.js';
import { verifyArcChain } from './inboundArc.js';
import { runPipeline } from './pipeline.js';
import { mainPipeline } from './phases/index.js';
import { reduce } from './outcome.js';
import { applyEffects } from './effects.js';
import type { BounceAttempt, SpfVerdict } from './types.js';
import type { SMTPServerSession } from 'smtp-server';
import { inboundTlsRequiredError, isInboundTlsRequired } from '../inbound/inboundTlsPolicy.js';

/** Hard cap for buffered inbound MIME (advertised AND wire-enforced). */
const MAX_INBOUND_BYTES = 10 * 1024 * 1024;

/**
 * The SMTP session, widened to carry the SPF verdict computed in
 * `onMailFrom`. `smtp-server` exposes no typed slot for per-transaction
 * state, so we stash the verdict here and read it back in `onData` to
 * thread it into the bounce ctx (RFC 7208 §2.6 / RFC 8601).
 */
interface SessionWithSpf extends SMTPServerSession {
	owlatSpfResult?: SpfVerdict;
	/**
	 * The envelope MAIL FROM domain, captured in `onMailFrom` so `onData` can
	 * test SPF alignment against the RFC5322.From domain for DMARC (RFC 7489
	 * §3.1 — SPF authenticates the envelope, not the header From).
	 */
	owlatEnvelopeFromDomain?: string;
}

/**
 * Create and start the bounce processing SMTP server
 */
export function createBounceServer(config: MtaConfig, redis: Redis): SMTPServer {
	// Build TLS options if cert+key are provided (enables STARTTLS)
	const tlsOptions: Record<string, unknown> = {};
	if (config.bounceServerTlsCert && config.bounceServerTlsKey) {
		tlsOptions['key'] = Buffer.from(config.bounceServerTlsKey);
		tlsOptions['cert'] = Buffer.from(config.bounceServerTlsCert);
		// Harden TLS configuration
		tlsOptions['minVersion'] = 'TLSv1.2';
		tlsOptions['ciphers'] = [
			'ECDHE-ECDSA-AES128-GCM-SHA256',
			'ECDHE-RSA-AES128-GCM-SHA256',
			'ECDHE-ECDSA-AES256-GCM-SHA384',
			'ECDHE-RSA-AES256-GCM-SHA384',
			'ECDHE-ECDSA-CHACHA20-POLY1305',
			'ECDHE-RSA-CHACHA20-POLY1305',
		].join(':');
		tlsOptions['honorCipherOrder'] = true;
		logger.info('Bounce server TLS configured — STARTTLS will be offered (TLSv1.2+ enforced)');
	}

	const server = new SMTPServer({
		secure: false, // Plain SMTP; STARTTLS is auto-offered when key+cert provided
		...tlsOptions,
		authOptional: true,
		disabledCommands: ['AUTH'],
		// The SMTP greeting + EHLO response open with this name (RFC 5321 §4.2).
		// It MUST be the FQDN that matches the IP's reverse-DNS PTR record, NOT
		// smtp-server's `os.hostname()` default (the container/host name has no
		// PTR), or a connecting MTA's banner/PTR consistency check fails.
		name: config.ehloHostname,
		banner: `${config.ehloHostname} Owlat MTA Bounce Processor`,
		size: MAX_INBOUND_BYTES, // advertised via EHLO SIZE; enforced in onData
		maxClients: config.bounceMaxClients,

		// Per-IP connection rate limiting
		async onConnect(session, callback) {
			const remoteIp = session.remoteAddress;

			try {
				const allowed = await checkConnectionRateLimit(
					redis,
					remoteIp,
					config.bounceMaxConnectionsPerIp
				);

				if (!allowed) {
					logger.warn({ remoteIp }, 'Bounce server connection rate limited');
					return callback(new Error('Too many connections from your IP'));
				}

				// Tarpit: add deliberate delay for non-local connections
				if (config.bounceTarpitEnabled && !isLocalAddress(remoteIp)) {
					await new Promise((resolve) => setTimeout(resolve, config.bounceTarpitDelayMs));
				}

				callback();
			} catch (err) {
				logger.error({ err, remoteIp }, 'Error in onConnect rate limit check');
				callback(); // Allow on error to prevent blocking legitimate bounces
			}
		},

		// Release connection counter on close
		onClose(session) {
			const remoteIp = session.remoteAddress;
			releaseConnection(redis, remoteIp).catch(() => {
				// Non-critical
			});
		},

		// Log TLS handshake (if STARTTLS is used)
		onSecure(socket, _session, callback) {
			logger.debug(
				{
					remoteAddress: socket.remoteAddress,
					protocol: (socket as unknown as { getProtocol?: () => string }).getProtocol?.(),
					cipher: (socket as unknown as { getCipher?: () => { name: string } }).getCipher?.()?.name,
				},
				'Bounce server TLS connection established'
			);
			callback();
		},

		// SPF validation on MAIL FROM
		async onMailFrom(address, session, callback) {
			if ((await isInboundTlsRequired(redis)) && !session.secure) {
				logger.warn(
					{ remoteIp: session.remoteAddress, from: address.address },
					'Plaintext inbound SMTP transaction rejected — STARTTLS required'
				);
				return callback(inboundTlsRequiredError());
			}

			if (!config.inboundSpfEnabled) {
				return callback();
			}

			// Skip SPF check for bounce/FBL addresses and empty return path (DSN)
			if (!address.address || address.address === '<>') {
				return callback();
			}

			try {
				const spfResult = await checkSpf(
					session.remoteAddress,
					address.address,
					session.hostNameAppearsAs || config.ehloHostname
				);

				// Record the full RFC 7208 §2.6 verdict on the session (not just
				// the fail/accept decision) so `onData` can thread softfail /
				// temperror / neutral / etc. into the mailbox payload (RFC 8601).
				(session as SessionWithSpf).owlatSpfResult = spfResult.result;
				// Capture the envelope MAIL FROM domain for DMARC SPF alignment.
				(session as SessionWithSpf).owlatEnvelopeFromDomain = emailDomain(address.address);

				if (spfResult.result === 'fail') {
					logger.warn(
						{ remoteIp: session.remoteAddress, from: address.address, spf: spfResult },
						'SPF check failed — rejecting'
					);
					return callback(new Error('SPF authentication failed'));
				}

				if (spfResult.result === 'softfail') {
					logger.info(
						{ remoteIp: session.remoteAddress, from: address.address, spf: spfResult },
						'SPF softfail — flagged but accepting'
					);
				}

				callback();
			} catch (err) {
				// On SPF lookup failure, accept the message (fail-open to not block
				// bounces) but record the transient error verdict so it is not
				// silently lost downstream.
				(session as SessionWithSpf).owlatSpfResult = 'temperror';
				logger.warn({ err, from: address.address }, 'SPF lookup error — accepting anyway');
				callback();
			}
		},

		// Accept VERP bounce addresses and routable inbound addresses
		onRcptTo(address, _session, callback) {
			// 1. VERP bounce/FBL addresses — always accept
			if (address.address.startsWith('bounce+') || address.address.startsWith('fbl+')) {
				callback();
				return;
			}

			// 2. Personal-mailbox lookup (Postbox) — Redis cache only
			findMailboxRoute(redis, address.address)
				.then((mailboxEntry) => {
					if (mailboxEntry) {
						// Pre-flight quota check (best-effort; SIZE may be unknown)
						if (
							mailboxEntry.quotaBytes != null &&
							mailboxEntry.usedBytes >= mailboxEntry.quotaBytes
						) {
							callback(new Error('552 5.2.2 Mailbox over quota'));
							return;
						}
						callback();
						return;
					}

					// 3. Fall through to existing inbound route table (AI shared inbox,
					//    etc.) — plus the TLS-RPT system route for the operator's
					//    `_smtp._tls` rua address (RFC 8460). The system config MUST be
					//    threaded here too: onData/resolveRoutePhase knows the system
					//    route, but without it at the RCPT gate the rua address is
					//    rejected "Mailbox not found" before onData ever runs, so inbound
					//    TLS reports would never arrive.
					findRoute(redis, address.address, {
						ruaAddress: config.tlsRptRua,
						convexSiteUrl: config.convexSiteUrl,
						webhookSecret: config.webhookSecret,
					})
						.then((route) => {
							if (route) {
								if (route.mode === 'reject') {
									callback(new Error('Mailbox not found'));
								} else {
									callback();
								}
							} else {
								callback(new Error('Mailbox not found'));
							}
						})
						.catch(() => {
							callback(new Error('Temporary error'));
						});
				})
				.catch(() => {
					callback(new Error('Temporary error'));
				});
		},

		// Process incoming bounce/FBL emails — runs the Bounce intake pipeline
		// (parseFblOrDsn → resolveRoute → stageAttachments), then hands the
		// typed classification to the reducer and runs the resulting effects.
		// See `docs/adr/0007-mta-dispatch-modules.md` follow-up #4.
		async onData(stream, session, callback) {
			try {
				// Buffer raw bytes so we can both parse AND forward the original MIME
				// to Convex storage for personal-mailbox deliveries. Bounded: the
				// `size` option does not enforce streamed bytes (see dataStream.ts).
				const collected = await collectDataStream(stream, MAX_INBOUND_BYTES);
				if (!collected.ok) {
					callback(messageTooLargeError(MAX_INBOUND_BYTES));
					return;
				}
				const rawBuffer = collected.buffer;
				const parsed = await simpleParser(rawBuffer);
				const rcptTo = session.envelope.rcptTo[0]?.address;
				// SPF verdict + envelope MAIL FROM domain computed in `onMailFrom`.
				const spfResult = (session as SessionWithSpf).owlatSpfResult;
				const envelopeFromDomain = (session as SessionWithSpf).owlatEnvelopeFromDomain;
				// SMTP envelope sender (RFC 5321 MAIL FROM). `mailFrom` is `false`
				// for the null sender (`<>`) of a bounce/DSN; normalize that and an
				// explicit `<>` to `''` so the downstream vacation hook can suppress
				// auto-replies to bounces off the *envelope* (RFC 3834 §2), not the
				// spoofable `From:` header.
				const envelopeFrom = session.envelope.mailFrom;
				const returnPath =
					envelopeFrom && envelopeFrom.address !== '<>' ? envelopeFrom.address : '';

				// Verify inbound DKIM (RFC 6376) over the raw bytes before parsing
				// mangles canonicalization. The verdict is threaded onto the
				// personal-mailbox payload's `dkimResult`. Fail-open: a verify
				// crash yields `temperror`, never a NACK of accepted bytes.
				const dkim = config.inboundDkimEnabled ? await verifyDkim(rawBuffer) : undefined;
				const dkimResult = dkim?.result;

				// Evaluate DMARC (RFC 7489): bind the (envelope-authenticated) SPF
				// and (d=-authenticated) DKIM results to the RFC5322.From domain via
				// alignment + the From-domain's published policy. A quarantine/reject
				// fail is recorded as `dmarcResult` so Convex routes spoofed mail to
				// Spam. Fail-open: a lookup crash yields `temperror`, never a NACK.
				const fromDomain = emailDomain(parsed.from?.value?.[0]?.address ?? '');
				const dmarc =
					config.inboundDmarcEnabled && fromDomain
						? await evaluateDmarc({
								fromDomain,
								spf: { result: spfResult ?? 'none', domain: envelopeFromDomain },
								dkim: { result: dkim?.result ?? 'none', domain: dkim?.domain },
								policyLookup: (domain) => dnsDmarcLookup(domain, dnsResolveTxt),
							})
						: undefined;
				const dmarcResult = dmarc?.result;
				const dmarcPolicy = dmarc?.policy;

				// Verify the ARC chain (RFC 8617) over the raw bytes (Sealed Mail A5).
				// A mailing list / forwarder that broke DKIM but sealed a valid chain
				// attesting the original passed lets the Convex delivery path rescue
				// the DMARC fail — but ONLY when the sealer is a TRUSTED forwarder, a
				// decision made in Convex against the operator's editable allow-list.
				// The MTA only extracts the honest verdict here. Fail-open: a crash
				// yields `cv: 'none'` (no rescue), never a NACK of accepted bytes.
				// Reuse the ARC seed `verifyDkim` already parsed from these bytes so we
				// verify DKIM once, not twice, on the hot ingest path. When DKIM is
				// disabled the seed is absent and `verifyArcChain` parses it itself.
				const arcVerdict = config.inboundArcEnabled
					? await verifyArcChain(rawBuffer, { arcSeed: dkim?.arcSeed })
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
					callback();
					return;
				}

				if (piped.kind === 'continue') {
					// The main pipeline always classifies (the final phase
					// always `bounceTo`s). Reaching this branch means a future
					// pipeline edit broke that invariant — log and ACK.
					logger.warn(
						{ rcptTo, subject: parsed.subject },
						'Bounce pipeline returned continue without a classification'
					);
					callback();
					return;
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

				callback();
			} catch (err) {
				logger.error({ err }, 'Error processing inbound email');
				callback(); // Accept anyway to prevent sender retries
			}
		},
	});

	return server;
}

/**
 * Per-classification log line. Replaces the inline `logger.info(...)`
 * calls that lived inside each branch of the old `onData` switch.
 */
function logAttempt(attempt: BounceAttempt, parsed: import('mailparser').ParsedMail): void {
	switch (attempt.kind) {
		case 'fbl':
			logger.info(
				{ messageId: attempt.arf.originalMessageId, type: 'complaint' },
				'FBL complaint processed'
			);
			return;
		case 'dsn_attributed':
			logger.info(
				{
					messageId: attempt.bounce.originalMessageId,
					bounceType: attempt.bounce.bounceType,
					type: 'bounce',
				},
				'Bounce DSN processed'
			);
			return;
		case 'route_hold':
			logger.info({ rcptTo: attempt.rcptTo, from: parsed.from?.text }, 'Inbound email held');
			return;
		case 'route_bounce':
			logger.info({ rcptTo: attempt.rcptTo }, 'Inbound email bounced by route');
			return;
		case 'unrecognized':
			logger.warn(
				{ rcptTo: attempt.rcptTo, subject: parsed.subject },
				'Received unrecognized inbound email'
			);
			return;
		case 'dsn_unattributed':
		case 'mailbox':
		case 'endpoint_forward':
		case 'inbound_accept':
			// No top-level log line in the pre-deepening handler.
			return;
	}
}

/**
 * Check if an IP is a local/loopback address (skip tarpit for these)
 */
function isLocalAddress(ip: string): boolean {
	return (
		ip === '127.0.0.1' ||
		ip === '::1' ||
		ip === '::ffff:127.0.0.1' ||
		ip.startsWith('10.') ||
		ip.startsWith('172.16.') ||
		ip.startsWith('192.168.')
	);
}

/**
 * Start the bounce server on the configured port
 */
export function startBounceServer(server: SMTPServer, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		server.listen(port, () => {
			logger.info({ port }, 'Bounce SMTP server listening');
			resolve();
		});
		server.on('error', (err) => {
			logger.error({ err, port }, 'Bounce SMTP server error');
			reject(err);
		});
	});
}
