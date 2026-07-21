/**
 * Direct MX SMTP sender
 *
 * Delivers emails directly to recipient mail servers by resolving MX records,
 * connecting via SMTP port 25 with the in-house @owlat/smtp-client, and sending
 * with DKIM signing. The message is composed and signed ONCE per job (locked
 * decisions W2/W3) and the SAME signed bytes are retried across every MX host
 * and TLS profile — byte-identical, DKIM-stable retries.
 */

import type Redis from 'ioredis';
import { SmtpConnection, sendEnvelope, isSmtpError, type SendResult } from '@owlat/smtp-client';
import {
	composeMessage,
	signMessage,
	stripHtml,
	type ComposeAttachment,
} from '@owlat/mail-message';
import type { EmailJob, EmailJobResult } from '../types.js';
import type { MtaConfig } from '../config.js';
import { resolveEhloForIp } from '../config.js';
import type { DaneMxDestination } from './daneMxResolver.js';
import { getDkimOptions, type DkimSigningKey } from './dkim.js';
import { getReturnPathHost } from './dkimStore.js';
import { getStsTlsOptions, isMxAllowed } from './mtaSts.js';
import { resolveTlsRequirements } from './tlsPolicy.js';
import { resolveOutboundTlsMode } from './outboundTlsOverrides.js';
import { buildVerpAddress } from '../bounce/verp.js';
import { extractDomain } from '../queue/groups.js';
import { extractDomainOrNull } from '@owlat/shared';
import { logger } from '../monitoring/logger.js';
import { pool, PoolOverCapError } from './connectionPool.js';
import { prepareDaneAttempt, type DanePlan } from './daneVerify.js';
import { buildAllMxFailedResult } from './mxBounce.js';
import {
	recordTlsResult,
	buildStsPolicyString,
	type TlsPolicyContext,
	type TlsResultType,
} from './tlsRpt.js';
import { classifyTlsFailure, stsAttributedResultType } from './tlsFailureClassification.js';
import { isIpEligibilityLeaseValid, type IpEligibilityLease } from '../scaling/ipPool.js';
import {
	providerFromMxHostnames,
	resolveDestinationSnapshot,
	type DestinationSnapshot,
} from './destinationProvider.js';
import { getProfile } from '../config/ispProfiles.js';
import type { DestinationProviderProfile } from '../types.js';

/** The discriminated outcome of one delivery attempt to a single MX host. */
type AttemptOutcome =
	| { kind: 'sent'; result: EmailJobResult }
	| { kind: 'smtp'; result: EmailJobResult }
	// A post-DATA drop with no server reply: the message MAY already have been
	// accepted, so this is TERMINAL — never a next-MX attempt, never an
	// auto-retried soft bounce (W8 AMBIGUOUS_TIMEOUT). Carries its own result.
	| { kind: 'ambiguous'; result: EmailJobResult }
	| { kind: 'tls-failure'; resultType: TlsResultType; response: string }
	| { kind: 'connection'; response: string }
	| { kind: 'over-cap' };

const TLS_MODE_RANK: Record<DestinationProviderProfile['tlsMode'], number> = {
	opportunistic: 0,
	require: 1,
	'require-verified': 2,
};

type DeliveryProviderPolicy = Pick<
	DestinationProviderProfile,
	'tlsMode' | 'maxConnections' | 'maxDeliveriesPerConnection'
>;

function strictestDeliveryProviderPolicy(
	first: DestinationProviderProfile,
	second: DestinationProviderProfile
): DeliveryProviderPolicy {
	return {
		tlsMode:
			TLS_MODE_RANK[second.tlsMode] > TLS_MODE_RANK[first.tlsMode] ? second.tlsMode : first.tlsMode,
		maxConnections: Math.min(first.maxConnections, second.maxConnections),
		maxDeliveriesPerConnection: Math.min(
			first.maxDeliveriesPerConnection,
			second.maxDeliveriesPerConnection
		),
	};
}

/**
 * Build the exact wire bytes for a job ONCE: compose the structured message (or
 * take the sealed-mail raw MIME verbatim), then DKIM-sign over those bytes. The
 * returned buffer is retried byte-identically across MX hosts.
 *
 * A missing DKIM key ships the message UNSIGNED (recoverable), and a signing
 * failure falls back to the unsigned bytes rather than a corrupt signature —
 * exactly the historic `stream`-plugin posture.
 */
function buildSignedBytes(
	job: EmailJob,
	dkimConfig: DkimSigningKey | undefined,
	verpAddress: string
): Buffer {
	const raw = job.sealedMimeBase64
		? Buffer.from(job.sealedMimeBase64, 'base64')
		: composeStructured(job, verpAddress).raw;
	if (!dkimConfig) return raw;
	try {
		return signMessage(raw, dkimConfig);
	} catch (err) {
		logger.error(
			{ err, domain: dkimConfig.domainName, selector: dkimConfig.keySelector },
			'DKIM signing failed; shipping message unsigned'
		);
		return raw;
	}
}

/**
 * Compose a structured (non-sealed) job into RFC 822 bytes via
 * `@owlat/mail-message`. Preserves the historic payload: html/text (with an
 * HTML-derived fallback), the AMP alternative, decoded attachments, the tracing
 * headers, the VERP envelope, and a From-aligned Message-ID (a caller-supplied
 * Message-ID header wins).
 */
function composeStructured(job: EmailJob, verpAddress: string): { raw: Buffer } {
	const suppliedMessageIdKey = job.headers
		? Object.keys(job.headers).find((h) => h.toLowerCase() === 'message-id')
		: undefined;
	const suppliedMessageId =
		suppliedMessageIdKey && job.headers ? job.headers[suppliedMessageIdKey] : undefined;
	const fromDomain = extractDomainOrNull(job.from) ?? '';

	const attachments: ComposeAttachment[] | undefined =
		job.attachments && job.attachments.length > 0
			? job.attachments.map((a) => ({
					filename: a.filename,
					contentType: a.contentType,
					isInline: false,
					data: Buffer.from(a.contentBase64, 'base64'),
				}))
			: undefined;

	return composeMessage({
		from: job.from,
		to: [job.to],
		subject: job.subject,
		html: job.html,
		// Always ship a non-empty text part (multipart/alternative deliverability,
		// RFC 8058 §4): the explicit text when supplied, else an HTML-derived
		// fallback — the historic behaviour.
		text: job.text || stripHtml(job.html),
		...(job.amp ? { amp: job.amp } : {}),
		...(job.replyTo ? { replyTo: job.replyTo } : {}),
		...(attachments ? { attachments } : {}),
		headers: {
			...job.headers,
			'X-Owlat-Message-Id': job.messageId,
			'X-Owlat-Org-Id': job.organizationId,
		},
		// A caller-supplied Message-ID wins; otherwise From-align it (only when the
		// From carries a domain — else the composer derives it from the From addr-spec).
		...(suppliedMessageId !== undefined
			? { messageId: suppliedMessageId }
			: fromDomain
				? { messageIdDomain: fromDomain }
				: {}),
		envelope: { from: verpAddress, to: [job.to] },
	});
}

/**
 * Send an email directly to the recipient's MX server
 *
 * Tries each MX host in priority order until one succeeds or all fail.
 * Returns a structured result with SMTP response details for the
 * intelligence systems to learn from.
 */
export async function sendToMx(
	job: EmailJob,
	config: MtaConfig,
	redis: Redis,
	bindIp: string,
	eligibilityLease?: IpEligibilityLease,
	resolvedDestination?: DestinationSnapshot
): Promise<EmailJobResult> {
	if (eligibilityLease && !(await isIpEligibilityLeaseValid(redis, eligibilityLease))) {
		return {
			success: false,
			error: 'Selected outbound IP is no longer eligible',
			bounceType: 'deferred',
			smtpCode: 451,
		};
	}
	const recipientDomain = extractDomain(job.to);
	// MX routing, DANE discovery, provider shaping, and queue throttling all use
	// this single immutable snapshot. The sender never performs an independent MX
	// lookup after Dispatch has acquired a provider bucket.
	const destination =
		resolvedDestination ?? (await resolveDestinationSnapshot(redis, recipientDomain, { config }));
	if (destination.mx.status === 'temporary-failure') {
		return {
			success: false,
			error: destination.mx.reason,
			bounceType: 'deferred',
			smtpCode: 451,
		};
	}
	if (destination.mx.status === 'domain-not-found') {
		return {
			success: false,
			error: destination.mx.reason,
			bounceType: 'hard',
			smtpCode: 550,
		};
	}
	if (destination.mx.status === 'null-mx') {
		return {
			success: false,
			error: `Recipient domain ${recipientDomain} explicitly does not accept email (Null MX)`,
			bounceType: 'hard',
			smtpCode: 556,
			enhancedCode: '5.1.10',
		};
	}

	const mxHosts = destination.mx.hosts.map((host) => host.exchange);
	const routeProvider = providerFromMxHostnames(mxHosts);
	const snapshotProfile = await getProfile(redis, destination.providerKey);
	const routeProfile =
		routeProvider === destination.providerKey
			? snapshotProfile
			: await getProfile(redis, routeProvider);
	// Defensive strictest-wins reconciliation protects hand-built/legacy snapshots
	// and reverse migrations. Connection scope always follows the actual MX set,
	// so a stale known provider can never poison its shared bucket.
	const providerPolicy = strictestDeliveryProviderPolicy(snapshotProfile, routeProfile);
	const daneDestinations = new Map<string, DaneMxDestination>(
		(destination.daneDestinations ?? []).map((daneDestination) => [
			daneDestination.mxHostname,
			daneDestination,
		])
	);
	const daneDiscoveryAuthenticated = destination.daneDiscoveryAuthenticated;

	const dkimConfig = await getDkimOptions(redis, job.dkimDomain);

	// VERP return-path host (D1): a sending domain may register its own
	// bounce/return-path host, making the MAIL FROM domain per-sending-domain
	// instead of the single global `RETURN_PATH_DOMAIN`. Keyed by the DKIM
	// signing domain (the sender's own domain). Absent → global fallback, so a
	// domain with no override behaves exactly as before. Attribution stays
	// domain-agnostic: the VERP token's HMAC is computed over the message id +
	// time window (never the host), and the bounce server accepts `bounce+…` at
	// ANY host — so a DSN arriving at the per-domain host still verifies and
	// suppresses the right recipient (see bounce/verp.ts, bounce/server.ts).
	const perDomainReturnPath = await getReturnPathHost(redis, job.dkimDomain.toLowerCase());
	const verpAddress = buildVerpAddress(
		job.messageId,
		perDomainReturnPath ?? config.returnPathDomain
	);

	// Compose + sign ONCE per job (W2/W3). The exact wire bytes are built a single
	// time and the SAME signed bytes are retried across every MX host and TLS
	// profile — byte-identical, DKIM-stable retries (a strict improvement over the
	// historic per-attempt recomposition). Both the structured-compose path and
	// the sealed-mail raw path flow through the one signer.
	const signedBytes = buildSignedBytes(job, dkimConfig, verpAddress);

	// Announce the EHLO name that matches THIS bind IP's PTR record. In a
	// multi-IP deployment each IP has its own reverse DNS, so a single static
	// name would let only one IP pass FCrDNS — resolveEhloForIp picks the
	// per-IP override (falling back to the global name for unmapped IPs).
	const ehloHostname = resolveEhloForIp(config, bindIp);

	// Fetch MTA-STS policy for recipient domain (never blocks delivery on failure)
	const stsOptions = await getStsTlsOptions(redis, recipientDomain);

	if (stsOptions.policyMode === 'enforce') {
		logger.debug({ recipientDomain, mx: stsOptions.allowedMxHosts }, 'MTA-STS enforce mode active');
	}

	// Resolve the operator's outbound TLS floor for this recipient (per-domain
	// override, else the global OUTBOUND_TLS_MODE) and combine it with the
	// recipient's MTA-STS state via strictest-wins. `opportunistic` + no policy
	// yields requireTLS:false / verify:false — byte-identical to the historic
	// behaviour; `require` / `require-verified` raise the handshake demand. This
	// non-DANE floor passes `daneResult: null`; the per-MX DANE outcome is resolved
	// through the SAME resolver inside the MX loop below, so one module owns the
	// TLS floor rather than DANE precedence being re-encoded here by hand.
	const localTlsMode = await resolveOutboundTlsMode(
		redis,
		recipientDomain,
		config.outboundTlsMode ?? 'opportunistic'
	);
	const tlsRequirements = resolveTlsRequirements({
		localMode: localTlsMode,
		providerMode: providerPolicy.tlsMode,
		stsPolicy: { policyMode: stsOptions.policyMode },
		daneResult: null,
	});
	if (localTlsMode !== 'opportunistic') {
		logger.debug(
			{ recipientDomain, localTlsMode, reason: tlsRequirements.reason },
			'Outbound TLS floor raised'
		);
	}

	// TLS-RPT policy context: when an MTA-STS policy applies, every recorded TLS
	// result is attributed to policy-type 'sts' with the policy body + MX
	// patterns (RFC 8460 §3). Without a policy, results stay 'no-policy-found'.
	const policyContext: TlsPolicyContext =
		stsOptions.policyMode === 'enforce' || stsOptions.policyMode === 'testing'
			? {
					policyType: 'sts',
					policyString: buildStsPolicyString(stsOptions.policyMode, stsOptions.allowedMxHosts),
					mxHostPatterns: stsOptions.allowedMxHosts,
				}
			: { policyType: 'no-policy-found', policyString: [] };

	/**
	 * Attempt delivery to one MX host with a specific TLS profile and classify
	 * the outcome. Opens ONE fresh {@link SmtpConnection} (W3 one-connection-per-
	 * send) from the pooled connect config, sends the pre-signed bytes, and reads
	 * `conn.secured` directly to record the TLS-RPT result (success, or — on a TLS
	 * negotiation failure — the STS-attributed failure type). Returns a
	 * discriminated outcome so the caller decides whether to return, try the next
	 * MX, or (testing mode) retry the same MX opportunistically.
	 */
	async function attemptSend(
		mxHost: string,
		requireTLS: boolean,
		rejectUnauthorized: boolean,
		danePlan?: DanePlan
	): Promise<AttemptOutcome> {
		const ctx = danePlan?.policyContext ?? policyContext;
		const daneRequired = danePlan !== undefined;

		let acquired: Awaited<ReturnType<typeof pool.acquire>>;
		try {
			// Fence the discovery interval too: no reusable or fresh SMTP connection
			// is acquired after the selection generation becomes ineligible.
			if (eligibilityLease && !(await isIpEligibilityLeaseValid(redis, eligibilityLease))) {
				return {
					kind: 'smtp',
					result: {
						success: false,
						error: 'Selected outbound IP became ineligible before SMTP acquisition',
						bounceType: 'deferred',
						smtpCode: 451,
					},
				};
			}
			acquired = await pool.acquire(mxHost, bindIp, {
				port: 25,
				requireTLS,
				// Pin a TLSv1.2 floor: RFC 8996 deprecates TLS 1.0/1.1 and RFC 9325
				// mandates 1.2+. The pool pins this on every outbound connection so the
				// floor is never Node's env-fragile process default.
				tls: {
					rejectUnauthorized,
					minVersion: 'TLSv1.2',
					// DANE (RFC 7672): authenticate the MX certificate against its TLSA
					// RRset AFTER STARTTLS but before SMTP resumes. It runs even under
					// rejectUnauthorized:false (DANE-EE); a mismatch fails the connection
					// closed (never a cleartext fallback). Absent for non-DANE sends.
					...(danePlan ? { verifyPeerCertificate: danePlan.verifyPeerCertificate } : {}),
					...(danePlan ? { danePolicyFingerprint: danePlan.policyFingerprint } : {}),
				},
				name: ehloHostname,
				connectionTimeout: 30_000,
				greetingTimeout: 30_000,
				socketTimeout: 60_000,
				dkimDomain: dkimConfig?.domainName,
				connectionLimits: {
					scope: routeProvider === 'other' ? `mx:${mxHost}` : `provider:${routeProvider}`,
					maxConnections: providerPolicy.maxConnections,
					maxDeliveriesPerConnection: providerPolicy.maxDeliveriesPerConnection,
				},
			});
		} catch (err) {
			// Over the global per-host connection cap — treat like a connection
			// failure: try the next MX, and if all are capped the loop falls through
			// to a soft bounce so the job is re-queued with backoff.
			if (err instanceof PoolOverCapError) {
				logger.warn(
					{ mxHost, recipientDomain },
					'Global connection cap reached, trying next MX host'
				);
				return { kind: 'over-cap' };
			}
			throw err;
		}
		const { key, config: connectConfig } = acquired;

		// Reuse fast-path (X1 true socket reuse): an idle, RSET-cleaned live socket to
		// this exact {mx,bindIp,dkim,tlsProfile}. `takeConnection` returns undefined —
		// cleanly tearing the parked socket down where needed — when none is parked,
		// when it is over the per-connection / lifetime cap, or when its RSET probe
		// failed (poisoned). In every such case we open a fresh socket below on the
		// SAME pooled entry, whose global slot is retained.
		let conn: SmtpConnection | undefined = await pool.takeConnection(key);
		if (conn === undefined) {
			try {
				// Connect → greeting → EHLO → (STARTTLS + re-EHLO). A TLS/handshake/
				// connection failure throws here, classified from the structured
				// SmtpError (phase/tlsCause/replyCode) — never a log-string match.
				conn = await SmtpConnection.connect(connectConfig);
				if (!pool.attachConnection(key, conn)) {
					return {
						kind: 'connection',
						response: 'Distributed connection lease was lost before SMTP envelope',
					};
				}
			} catch (err) {
				pool.release(key);
				return classifyFailure(err, mxHost, ctx, daneRequired);
			}
		}

		try {
			// Acquisition, RSET, and connect are asynchronous. Fence once more at the
			// last safe boundary before MAIL FROM so quarantine always wins that race,
			// including for a socket already checked out when its pool is invalidated.
			if (eligibilityLease && !(await isIpEligibilityLeaseValid(redis, eligibilityLease))) {
				pool.evictConnection(key, conn);
				return {
					kind: 'smtp',
					result: {
						success: false,
						error: 'Selected outbound IP became ineligible before SMTP envelope',
						bounceType: 'deferred',
						smtpCode: 451,
					},
				};
			}

			// `secured` reports whether this CONNECTION negotiated TLS (STARTTLS
			// upgrade). It is per-connection: every message carried over a reused
			// socket is attributed to the same TLS state. A cleartext delivery to an
			// MX that did not advertise STARTTLS (opportunistic, requireTLS:false) is
			// NOT a TLS success.
			const secured = conn.secured;

			const result: SendResult = await sendEnvelope(conn, {
				from: verpAddress,
				to: [job.to],
				data: signedBytes,
			});

			// Record the TLS-RPT result for this successful delivery (RFC 8460 §4.3).
			// Encrypted → 'success'; cleartext → 'starttls-not-supported' (escalated to
			// the STS-specific type under a testing/enforce policy). Recording a
			// cleartext send as success would overstate our TLS coverage to the domain
			// owner.
			const successResultType: TlsResultType = secured
				? 'success'
				: stsAttributedResultType('starttls-not-supported', stsOptions.policyMode);
			recordTlsResult(redis, recipientDomain, successResultType, mxHost, bindIp, ctx).catch(
				() => {}
			);

			// Healthy delivery: park the socket for the next job to reuse across an RSET
			// boundary (or let the pool cleanly QUIT it at the per-connection / lifetime
			// cap), then release the entry's in-flight reservation.
			pool.storeConnection(key, conn);
			pool.release(key);

			// Parse remote message ID from the final SMTP reply text
			// Gmail: "250 2.0.0 OK 1234567890 abc123.google.com"
			// Outlook: "250 2.6.0 <msgid@outlook.com> [Hostname=...]"
			const responseText = `${result.response.code} ${result.response.text}`.trim();
			const remoteIdMatch = result.response.text.match(/<([^>]+)>/);
			const remoteMessageId = remoteIdMatch?.[1];

			return {
				kind: 'sent',
				result: {
					success: true,
					smtpResponse: responseText,
					remoteMessageId,
					smtpCode: result.response.code,
				},
			};
		} catch (err) {
			if (isCleanPreDataRejection(err)) {
				// A clean pre-DATA reply rejection (every recipient refused, or MAIL FROM
				// bounced) left the SMTP session OPEN and the socket protocol-healthy — it
				// carries a server reply code, no TLS fault, never reached DATA, and was
				// not a 421 channel-close. Pre-X1 a bounce left the pooled entry intact;
				// preserve that (and its Redis slot) by parking the socket for reuse rather
				// than evicting. The next job's RSET boundary aborts the leftover
				// transaction before the socket carries a new one.
				pool.storeConnection(key, conn);
				pool.release(key);
			} else {
				// ANY other failure — a transport/TLS fault, a 421 channel close, or a
				// DATA-phase ambiguity — poisons this socket: evict the entry, release its
				// global slot, and never reuse it. The in-flight job retries on a fresh
				// connection (next MX, or a requeue) exactly once.
				pool.evictConnection(key, conn);
			}
			return classifyFailure(err, mxHost, ctx, daneRequired);
		}
	}

	/**
	 * True for a delivery failure that left the socket protocol-healthy and reusable:
	 * a server reply rejection in a pre-DATA phase (`mail`/`rcpt`), carrying a reply
	 * code, with no TLS fault and not a 421 (which signals the server is closing the
	 * channel). Everything else — transport faults, TLS faults, DATA/DATA-final
	 * ambiguity, 421 — leaves the socket unusable and must evict.
	 */
	function isCleanPreDataRejection(err: unknown): boolean {
		return (
			isSmtpError(err) &&
			err.tlsCause === undefined &&
			err.replyCode !== undefined &&
			err.replyCode !== 421 &&
			(err.phase === 'mail' || err.phase === 'rcpt')
		);
	}

	/**
	 * Classify a structured {@link SmtpError} from a connect or send attempt into a
	 * delivery outcome, recording TLS-RPT along the way. Reads only the
	 * discriminants — `tlsCause`, `replyCode`, `enhancedCode`, `phase` — never a
	 * log-line string (locked decision W7).
	 */
	function classifyFailure(
		err: unknown,
		mxHost: string,
		ctx: TlsPolicyContext,
		daneRequired: boolean
	): AttemptOutcome {
		if (!isSmtpError(err)) {
			const response = err instanceof Error ? err.message : String(err);
			logger.warn(
				{ mxHost, recipientDomain, error: response },
				'Unexpected non-SMTP error during delivery, trying next MX'
			);
			return { kind: 'connection', response };
		}
		const response = err.message;

		// 0. Client-side permanent refusal (no reply code, no TLS cause). Today the
		//    only case is `smtputf8-unavailable`: the envelope carries a non-ASCII
		//    (RFC 6531) mailbox but this MX did not advertise SMTPUTF8. There is no
		//    ASCII downgrade for a UTF-8 local-part, so retrying (this MX or the next)
		//    can never succeed — a HARD bounce, terminal like a 5xx. Read from the
		//    structured discriminant, never a log-line string (W7).
		if (err.clientRefusal === 'smtputf8-unavailable') {
			return {
				kind: 'smtp',
				result: {
					success: false,
					error: response,
					bounceType: 'hard',
				},
			};
		}

		// 1. TLS-phase failure (a structured tlsCause). Under DANE this is an RFC 8460
		//    'validation-failure' attributed to the tlsa policy and never downgrades
		//    to cleartext. Otherwise escalate to the STS-specific type under a policy.
		if (err.tlsCause !== undefined) {
			if (daneRequired) {
				recordTlsResult(redis, recipientDomain, 'validation-failure', mxHost, bindIp, ctx).catch(
					() => {}
				);
				return { kind: 'tls-failure', resultType: 'validation-failure', response };
			}
			const baseType = classifyTlsFailure(err.tlsCause);
			const stsResultType = stsAttributedResultType(baseType, stsOptions.policyMode);
			recordTlsResult(redis, recipientDomain, stsResultType, mxHost, bindIp, ctx).catch(() => {});
			return { kind: 'tls-failure', resultType: stsResultType, response };
		}

		// 2. A server reply code is the DEFINITIVE verdict. 5xx = permanent (hard
		//    bounce) unless 5.2.2 "mailbox full" (soft); 4xx = temporary (deferred).
		if (err.replyCode !== undefined) {
			const smtpCode = err.replyCode;
			const enhancedCode = err.enhancedCode;
			if (smtpCode >= 500 && smtpCode < 600) {
				const isSoftDespite5xx = enhancedCode === '5.2.2';
				return {
					kind: 'smtp',
					result: {
						success: false,
						error: response,
						bounceType: isSoftDespite5xx ? 'soft' : 'hard',
						smtpCode,
						...(enhancedCode !== undefined ? { enhancedCode } : {}),
					},
				};
			}
			if (smtpCode >= 400 && smtpCode < 500) {
				return {
					kind: 'smtp',
					result: {
						success: false,
						error: response,
						bounceType: 'deferred',
						smtpCode,
						...(enhancedCode !== undefined ? { enhancedCode } : {}),
					},
				};
			}
		}

		// 3. Post-DATA ambiguous drop: a `data`/`data-final` phase failure with NO
		//    server reply and no TLS cause. The body (and possibly the terminating
		//    dot) was already written, so the receiver may have accepted the message
		//    before the connection dropped. Retrying — on the next MX or via a
		//    soft-bounce requeue — risks a DOUBLE DELIVERY, so this is the
		//    AMBIGUOUS_TIMEOUT the retry taxonomy must NEVER auto-retry (W8;
		//    smtp-client errors.ts / transaction.ts:312). Terminate the job here with
		//    its OWN `ambiguous` bounceType — NOT `hard` — so the dispatch reducer
		//    stays terminal (no next-MX, no requeue) WITHOUT suppressing the recipient
		//    or fabricating a 5xx: the message may in fact have been delivered.
		if (
			(err.phase === 'data' || err.phase === 'data-final') &&
			err.replyCode === undefined &&
			err.tlsCause === undefined
		) {
			logger.warn(
				{ mxHost, recipientDomain, phase: err.phase, error: response },
				'Ambiguous post-DATA failure with no server reply; not retrying (message may already be delivered)'
			);
			return {
				kind: 'ambiguous',
				result: {
					success: false,
					error: `Ambiguous delivery outcome for ${recipientDomain} (phase ${err.phase}, no server reply): message may already have been accepted — not retrying to avoid a double delivery: ${response}`,
					bounceType: 'ambiguous',
				},
			};
		}

		// 4. No reply, no TLS cause — a connection/greeting-level failure (or a
		//    reply-less ambiguous drop in a retry-safe phase). Try the next MX host.
		//    A required floor never reaches here without a tlsCause, so it is never
		//    silently downgraded (that lives in branch 1).
		logger.warn(
			{ mxHost, recipientDomain, error: response, phase: err.phase },
			'Connection failed to MX host, trying next'
		);
		return { kind: 'connection', response };
	}

	// Remember the last TLS-negotiation failure (no SMTP status) so that, when a
	// TLS-required floor (`require` / `require-verified`, or MTA-STS enforce) makes
	// every MX fail its handshake, the bounce names the TLS failure instead of the
	// generic "all MX failed". Captured ONLY when a TLS floor was actually required
	// — under the default `opportunistic` path a mid-handshake TLS error is not a
	// required-TLS failure and must not change the historic bounce string. It stays
	// a soft/deferred bounce (retried until the receiver fixes its TLS or the
	// message expires): we never fall back to cleartext under a TLS-required policy.
	let lastTlsFailureResponse: string | null = null;

	// Remember a DANE TLSA lookup failure (SERVFAIL / timeout / transport error).
	// Such a failure is NOT a denial of existence, so we must not downgrade to the
	// non-DANE path — we defer this MX. If every MX defers on a lookup failure the
	// bounce names that (soft/deferred) rather than delivering without DANE.
	let lastDaneDeferResponse: string | null = null;

	// Try each MX host in priority order
	for (const mxHost of mxHosts) {
		// DANE (RFC 7672) takes precedence over MTA-STS. When enabled and the MX
		// publishes a usable, DNSSEC-authenticated TLSA RRset, authenticate the MX
		// certificate against it via a TLS floor resolved by the SAME strictest-wins
		// module the non-DANE path uses (so DANE precedence lives in one place). A
		// `none` decision (flag off / no usable TLSA) leaves the MTA-STS / local-floor
		// path below byte-identical to T1; a `defer` decision (lookup failed) skips
		// this MX without ever falling back to cleartext.
		const daneDecision = daneDiscoveryAuthenticated
			? await prepareDaneAttempt(
					redis,
					mxHost,
					recipientDomain,
					config,
					daneDestinations.get(mxHost)
				)
			: ({ kind: 'none' } as const);
		if (daneDecision.kind === 'defer') {
			lastDaneDeferResponse = daneDecision.reason;
			continue;
		}
		if (daneDecision.kind === 'proceed') {
			// Enforce mode: resolve the TLS floor with a usable DANE result —
			// requireTLS + verified TLS (RFC 7672 §2, supersedes MTA-STS).
			// resolveTlsRequirements owns the precedence; the DanePlan supplies the
			// TLSA cert-authentication hook.
			const daneTls = resolveTlsRequirements({
				localMode: localTlsMode,
				providerMode: providerPolicy.tlsMode,
				stsPolicy: { policyMode: stsOptions.policyMode },
				daneResult: { usable: true },
			});
			const outcome = await attemptSend(
				mxHost,
				daneTls.requireTLS,
				daneTls.rejectUnauthorized,
				daneDecision.plan
			);
			if (outcome.kind === 'sent' || outcome.kind === 'smtp' || outcome.kind === 'ambiguous') {
				return outcome.result;
			}
			if (outcome.kind === 'tls-failure') {
				lastTlsFailureResponse = outcome.response;
			}
			// over-cap / connection / tls-failure → try the next MX (never cleartext).
			continue;
		}
		if (daneDecision.kind === 'report') {
			// Report-only DANE (RFC 7672 report mode) — the DANE analogue of MTA-STS
			// testing mode. Make ONE probe attempt at the DANE floor (requireTLS +
			// verify + the TLSA hook) purely to OBSERVE the certificate authentication
			// and emit the TLS-RPT result (success, or a `validation-failure` under the
			// `tlsa` policy on a mismatch). DANE never requires TLS or bounces here: on
			// any probe failure we retry the SAME MX at the normal opportunistic/MTA-STS
			// floor so delivery is unaffected. Report-only is observability only and
			// honours D6 (DANE never bounces mail by default).
			const daneTls = resolveTlsRequirements({
				localMode: localTlsMode,
				providerMode: providerPolicy.tlsMode,
				stsPolicy: { policyMode: stsOptions.policyMode },
				daneResult: { usable: true },
			});
			const probe = await attemptSend(
				mxHost,
				daneTls.requireTLS,
				daneTls.rejectUnauthorized,
				daneDecision.plan
			);
			if (probe.kind === 'sent' || probe.kind === 'smtp' || probe.kind === 'ambiguous') {
				return probe.result;
			}
			if (probe.kind === 'tls-failure') {
				// The validation-failure (tlsa policy) has already been recorded inside
				// attemptSend. Deliver anyway at the normal floor — report-only never
				// blocks mail on a DANE outcome.
				logger.debug(
					{ mxHost, recipientDomain, resultType: probe.resultType },
					'DANE report-only: TLSA result recorded; delivering at the normal TLS floor'
				);
				const retry = await attemptSend(
					mxHost,
					tlsRequirements.requireTLS,
					tlsRequirements.rejectUnauthorized
				);
				if (retry.kind === 'sent' || retry.kind === 'smtp' || retry.kind === 'ambiguous') {
					return retry.result;
				}
				if (retry.kind === 'tls-failure' && tlsRequirements.requireTLS) {
					lastTlsFailureResponse = retry.response;
				}
				continue; // retry failed too — try the next MX
			}
			// over-cap / connection → try the next MX (same as the non-DANE path).
			continue;
		}

		// MTA-STS enforcement: skip MX hosts not listed in the policy
		if (stsOptions.policyMode === 'enforce' && !isMxAllowed(mxHost, stsOptions.allowedMxHosts)) {
			logger.warn(
				{ mxHost, recipientDomain, allowedMx: stsOptions.allowedMxHosts },
				'MX host not permitted by MTA-STS policy, skipping'
			);
			// RFC 8460 §4.3: an MX that is not in the enforce policy is a policy
			// failure — record it (previously this skip recorded nothing, so STS
			// MX-mismatch was invisible in our TLS-RPT reports).
			recordTlsResult(
				redis,
				recipientDomain,
				'sts-policy-invalid',
				mxHost,
				bindIp,
				policyContext
			).catch(() => {});
			continue;
		}

		// MTA-STS testing mode (RFC 8461 §5.2, RFC 8460 §4.3) is report-only: it
		// must NOT block delivery, but a TLS failure that an enforce policy WOULD
		// have caught (e.g. a STARTTLS-stripping server) must still be reported.
		// So in testing mode we make ONE verifying probe attempt (requireTLS +
		// verifying); if it fails on TLS we have already recorded the result and
		// fall through to an opportunistic retry on the SAME MX so the mail is
		// still delivered.
		if (stsOptions.policyMode === 'testing') {
			const probe = await attemptSend(mxHost, true, true);
			if (probe.kind === 'sent' || probe.kind === 'smtp' || probe.kind === 'ambiguous') {
				return probe.result;
			}
			if (probe.kind === 'tls-failure') {
				logger.warn(
					{ mxHost, recipientDomain, resultType: probe.resultType },
					'MTA-STS testing-mode TLS failure recorded; retrying at the local TLS floor'
				);
				// Retry the same MX at the operator's local TLS floor so the report-only
				// STS policy never blocks delivery. With the default `opportunistic`
				// mode this is (no requireTLS / no verify) — historic behaviour. Under a
				// `require` / `require-verified` local mode the floor is preserved and
				// the retry never downgrades below it.
				const retry = await attemptSend(
					mxHost,
					tlsRequirements.requireTLS,
					tlsRequirements.rejectUnauthorized
				);
				if (retry.kind === 'sent' || retry.kind === 'smtp' || retry.kind === 'ambiguous') {
					return retry.result;
				}
				if (retry.kind === 'tls-failure' && tlsRequirements.requireTLS) {
					lastTlsFailureResponse = retry.response;
				}
				continue; // retry failed too — try the next MX
			}
			// over-cap / connection → try the next MX
			continue;
		}

		// Enforce / no-policy path: a single attempt at the resolved TLS floor
		// (strictest of the local mode and the recipient's MTA-STS state).
		const outcome = await attemptSend(
			mxHost,
			tlsRequirements.requireTLS,
			tlsRequirements.rejectUnauthorized
		);
		if (outcome.kind === 'sent' || outcome.kind === 'smtp' || outcome.kind === 'ambiguous') {
			return outcome.result;
		}
		if (outcome.kind === 'tls-failure' && tlsRequirements.requireTLS) {
			lastTlsFailureResponse = outcome.response;
		}
		// over-cap / connection / tls-failure (no SMTP code) → try the next MX
		continue;
	}

	// Every MX has been tried (or skipped). Classify the terminal bounce from the
	// strictest reason recorded along the way — a TLS-required handshake failure,
	// then a DANE TLSA lookup that could not be completed, else a plain
	// connection-level failure. All soft/deferred: a TLS-required or DANE floor
	// never falls back to cleartext (RFC 7672 §2.1).
	return buildAllMxFailedResult(
		recipientDomain,
		mxHosts,
		lastTlsFailureResponse,
		lastDaneDeferResponse
	);
}
