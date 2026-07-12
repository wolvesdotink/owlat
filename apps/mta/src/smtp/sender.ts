/**
 * Direct MX SMTP sender
 *
 * Delivers emails directly to recipient mail servers by resolving MX records,
 * connecting via SMTP port 25, and sending with DKIM signing.
 */

import { randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import type { EmailJob, EmailJobResult } from '../types.js';
import type { MtaConfig } from '../config.js';
import { resolveEhloForIp } from '../config.js';
import { getMxHostnames } from './mxResolver.js';
import { getDkimOptions } from './dkim.js';
import { getStsTlsOptions, isMxAllowed } from './mtaSts.js';
import { resolveTlsRequirements } from './tlsPolicy.js';
import { resolveOutboundTlsMode } from './outboundTlsOverrides.js';
import { buildVerpAddress } from '../bounce/verp.js';
import { extractDomain } from '../queue/groups.js';
import { extractDomainOrNull } from '@owlat/shared';
import { logger } from '../monitoring/logger.js';
import { pool, PoolOverCapError } from './connectionPool.js';
import {
	recordTlsResult,
	buildStsPolicyString,
	type TlsPolicyContext,
	type TlsResultType,
} from './tlsRpt.js';
import {
	classifyTlsFailure,
	parseEnhancedCode,
	stsAttributedResultType,
} from './tlsFailureClassification.js';
import { withSecuredCapture } from './tlsSecuredCapture.js';

/**
 * Strip HTML tags and decode entities to produce a plain text fallback.
 * Used when the caller doesn't provide an explicit text part.
 */
function stripHtml(html: string): string {
	return html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n\n')
		.replace(/<\/div>/gi, '\n')
		.replace(/<\/h[1-6]>/gi, '\n\n')
		.replace(/<\/li>/gi, '\n')
		.replace(/<\/tr>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#039;/gi, "'")
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * Build an RFC 5322 §3.6.4 Message-ID `<unique@domain>` whose right-hand-side
 * domain is the From sending domain. Mirrors `apps/api/convex/mail/rfc822.ts`
 * `buildMessageId` (ms timestamp + 48 random bits = collision-resistant).
 *
 * The bulk/campaign/transactional path never sets Message-ID, so nodemailer
 * auto-derives it from `envelope.from` — which is the VERP return-path
 * (`bounces.<domain>`), NOT the From domain. Stamping it explicitly here
 * From-aligns the Message-ID for brand/deliverability consistency with the
 * postbox path and short-circuits nodemailer's `getHeader('Message-ID')`
 * default (mime-node:922-929).
 */
function buildMessageId(domain: string): string {
	return `<${Date.now().toString(36)}.${randomBytes(6).toString('hex')}@${domain}>`;
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
	bindIp: string
): Promise<EmailJobResult> {
	const recipientDomain = extractDomain(job.to);
	const mxHosts = await getMxHostnames(redis, recipientDomain);

	if (mxHosts.length === 0) {
		return {
			success: false,
			error: `No MX records found for ${recipientDomain}`,
			bounceType: 'hard',
			smtpCode: 550,
		};
	}

	const dkimConfig = await getDkimOptions(redis, job.dkimDomain);
	const verpAddress = buildVerpAddress(job.messageId, config.returnPathDomain);

	// RFC 5322 §3.6.4: stamp an explicit From-aligned Message-ID so nodemailer
	// does not auto-generate one scoped to the VERP return-path domain
	// (`envelope.from` = bounces.<domain>). A caller-supplied Message-ID header
	// wins (e.g. agent replies that already carry one). Computed once per send
	// so a retry across MX hosts ships the same id.
	const hasMessageIdHeader = Object.keys(job.headers ?? {}).some(
		(h) => h.toLowerCase() === 'message-id'
	);
	const fromDomain = extractDomainOrNull(job.from) ?? '';
	const messageIdHeader =
		!hasMessageIdHeader && fromDomain ? buildMessageId(fromDomain) : undefined;

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
	// behaviour; `require` / `require-verified` raise the handshake demand. DANE
	// is plumbed as null until T3 lands.
	const localTlsMode = await resolveOutboundTlsMode(
		redis,
		recipientDomain,
		config.outboundTlsMode ?? 'opportunistic'
	);
	const tlsRequirements = resolveTlsRequirements({
		localMode: localTlsMode,
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
	 * the outcome. Records the TLS result (success or, on a TLS negotiation
	 * failure, the STS-attributed failure type) under the day's policy context.
	 * Returns a discriminated outcome so the caller decides whether to return,
	 * try the next MX, or (testing mode) retry the same MX opportunistically.
	 */
	async function attemptSend(
		mxHost: string,
		requireTLS: boolean,
		rejectUnauthorized: boolean
	): Promise<
		| { kind: 'sent'; result: EmailJobResult }
		| { kind: 'smtp'; result: EmailJobResult }
		| { kind: 'tls-failure'; resultType: TlsResultType; response: string }
		| { kind: 'connection'; response: string }
		| { kind: 'over-cap' }
	> {
		let acquired: Awaited<ReturnType<typeof pool.acquire>>;
		try {
			acquired = await pool.acquire(mxHost, bindIp, {
				port: 25,
				secure: false, // Use STARTTLS opportunistically
				requireTLS,
				// Pin a TLSv1.2 floor: RFC 8996 deprecates TLS 1.0/1.1 and RFC 9325
				// mandates 1.2+. Inbound submission/bounce servers already pin this;
				// without it the outbound floor is Node's env-fragile process default.
				tls: { rejectUnauthorized, minVersion: 'TLSv1.2' },
				name: ehloHostname,
				connectionTimeout: 30_000,
				greetingTimeout: 30_000,
				socketTimeout: 60_000,
				dkim: dkimConfig,
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
		const { key, transport } = acquired;

		try {
			// `secured` reports whether this delivery's connection negotiated TLS.
			// nodemailer surfaces no secured flag on `info`, so we run the send inside
			// a per-call capture scope (see tlsSecuredCapture.ts) and read it back to
			// record the right TLS-RPT result type below.
			const { result: info, secured } = await withSecuredCapture(false, () =>
				transport.sendMail({
					from: job.from,
					to: job.to,
					subject: job.subject,
					html: job.html,
					text: job.text || stripHtml(job.html),
					// nodemailer emits AMP as a `text/x-amp-html` alternative part,
					// ordered so non-AMP clients fall through to the HTML part.
					...(job.amp ? { amp: job.amp } : {}),
					// Internally-generated mail (e.g. TLS-RPT reports) may carry binary
					// attachments. base64-encoded on the job so they survive Redis JSON.
					...(job.attachments && job.attachments.length > 0
						? {
								attachments: job.attachments.map((a) => ({
									filename: a.filename,
									contentType: a.contentType,
									content: Buffer.from(a.contentBase64, 'base64'),
								})),
							}
						: {}),
					replyTo: job.replyTo,
					headers: {
						...job.headers,
						...(messageIdHeader ? { 'Message-ID': messageIdHeader } : {}),
						'X-Owlat-Message-Id': job.messageId,
						'X-Owlat-Org-Id': job.organizationId,
					},
					envelope: {
						from: verpAddress,
						to: job.to,
					},
				})
			);

			// Record the TLS-RPT result for this successful delivery (RFC 8460 §4.3).
			// A delivery that negotiated TLS is a genuine 'success'; a delivery that
			// went out in cleartext — the MX did not advertise STARTTLS and no policy
			// required it (opportunistic TLS, requireTLS:false) — is NOT a success.
			// Recording it as success would overstate our TLS coverage to the recipient
			// domain owner. Without an STS policy a cleartext delivery is
			// 'starttls-not-supported'; under a testing/enforce policy it is escalated
			// to the STS-specific type (RFC 8460 §4.4), mirroring the failure path.
			// (A requireTLS / enforce send can never reach here in cleartext: nodemailer
			// errors out instead, which is handled on the failure path below.)
			const successResultType: TlsResultType = secured
				? 'success'
				: stsAttributedResultType('starttls-not-supported', stsOptions.policyMode);
			recordTlsResult(
				redis,
				recipientDomain,
				successResultType,
				mxHost,
				bindIp,
				policyContext
			).catch(() => {});

			// Parse remote message ID from SMTP response
			// Gmail: "250 2.0.0 OK 1234567890 abc123.google.com"
			// Outlook: "250 2.6.0 <msgid@outlook.com> [Hostname=...]"
			const remoteIdMatch = info.response?.match(/<([^>]+)>/);
			const remoteMessageId = remoteIdMatch?.[1];

			return {
				kind: 'sent',
				result: {
					success: true,
					smtpResponse: info.response,
					remoteMessageId,
					smtpCode: 250,
				},
			};
		} catch (err: unknown) {
			const error = err as {
				responseCode?: number;
				response?: string;
				message?: string;
				code?: string;
			};
			const smtpCode = error.responseCode;
			const response = error.response ?? error.message ?? 'Unknown error';
			const enhancedCode = parseEnhancedCode(response);

			// Record TLS failures for TLS-RPT. Under an MTA-STS policy a generic TLS
			// failure is escalated to the STS-specific result type (RFC 8460 §4.4):
			// a cert/WebPKI problem becomes 'sts-webpki-invalid', a STARTTLS-
			// stripping/other TLS failure becomes 'sts-policy-invalid'.
			const baseType = classifyTlsFailure(error);
			let stsResultType: TlsResultType | null = null;
			if (baseType) {
				stsResultType = stsAttributedResultType(baseType, stsOptions.policyMode);
				recordTlsResult(redis, recipientDomain, stsResultType, mxHost, bindIp, policyContext).catch(
					() => {}
				);
			}

			// 5xx = permanent failure (hard bounce) — don't try next MX
			if (smtpCode && smtpCode >= 500 && smtpCode < 600) {
				// Special case: 5.2.2 is "mailbox full" — soft bounce despite 5xx
				const isSoftDespite5xx = enhancedCode === '5.2.2';

				return {
					kind: 'smtp',
					result: {
						success: false,
						error: response,
						bounceType: isSoftDespite5xx ? 'soft' : 'hard',
						smtpCode,
						enhancedCode,
					},
				};
			}

			// 4xx = temporary failure — don't try next MX, return for retry
			if (smtpCode && smtpCode >= 400 && smtpCode < 500) {
				return {
					kind: 'smtp',
					result: {
						success: false,
						error: response,
						bounceType: 'deferred',
						smtpCode,
						enhancedCode,
					},
				};
			}

			// A TLS negotiation failure with no SMTP status: surface it so testing
			// mode can record-then-retry opportunistically (delivery must proceed).
			if (stsResultType) {
				return { kind: 'tls-failure', resultType: stsResultType, response };
			}

			// Connection error (no SMTP code) — try next MX host
			logger.warn(
				{ mxHost, recipientDomain, error: response },
				'Connection failed to MX host, trying next'
			);
			return { kind: 'connection', response };
		} finally {
			pool.release(key);
		}
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

	// Try each MX host in priority order
	for (const mxHost of mxHosts) {
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
			if (probe.kind === 'sent' || probe.kind === 'smtp') {
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
				if (retry.kind === 'sent' || retry.kind === 'smtp') {
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
		if (outcome.kind === 'sent' || outcome.kind === 'smtp') {
			return outcome.result;
		}
		if (outcome.kind === 'tls-failure' && tlsRequirements.requireTLS) {
			lastTlsFailureResponse = outcome.response;
		}
		// over-cap / connection / tls-failure (no SMTP code) → try the next MX
		continue;
	}

	// Every MX failed a TLS-required handshake: surface the TLS failure rather
	// than a generic connection error. Soft/deferred so the message is retried
	// until the receiver's TLS is fixed or the message expires — a TLS-required
	// floor never falls back to cleartext.
	if (lastTlsFailureResponse) {
		return {
			success: false,
			error: `TLS required but no MX for ${recipientDomain} completed a usable TLS handshake: ${lastTlsFailureResponse}`,
			bounceType: 'soft',
		};
	}

	// All MX hosts failed at connection level
	return {
		success: false,
		error: `All MX hosts failed for ${recipientDomain}: ${mxHosts.join(', ')}`,
		bounceType: 'soft',
	};
}
