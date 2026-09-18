/**
 * Direct MX SMTP sender
 *
 * Delivers emails directly to recipient mail servers by resolving MX records,
 * connecting via SMTP port 25 with the in-house @owlat/smtp-client, and sending
 * with DKIM signing. The message is composed and signed ONCE per job and the
 * SAME signed bytes are retried across every MX host and TLS profile —
 * byte-identical, DKIM-stable retries.
 *
 * The send runs as four phases, each in its own module under `send/`:
 * route (MX + provider policy), compose (VERP, CFBL, DKIM-signed bytes), TLS
 * plan (the strictest-wins floor), and per-MX attempts (connect, DATA journal,
 * outcome classification). This module owns only the MX loop that sequences
 * them and the terminal bounce.
 */

import type Redis from 'ioredis';
import type { EmailJob, EmailJobResult } from '../types.js';
import type { MtaConfig } from '../config.js';
import { resolveEhloForIp } from '../config.js';
import { logger } from '../monitoring/logger.js';
import { isIpEligibilityLeaseValid, type IpEligibilityLease } from '../scaling/ipPool.js';
import { fireAndForget } from '../lib/fireAndForget.js';
import { prepareDaneAttempt } from './daneVerify.js';
import { buildAllMxFailedResult } from './mxBounce.js';
import { isMxAllowed } from './mtaSts.js';
import { recordTlsResult } from './tlsRpt.js';
import type { DestinationSnapshot } from './destinationProvider.js';
import { resolveDeliveryRoute } from './send/route.js';
import { prepareSignedMessage } from './send/compose.js';
import { resolveSendTlsPlan } from './send/tlsPlan.js';
import { attemptSend, type AttemptContext } from './send/attempt.js';
import { terminalResult } from './send/outcome.js';

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
	resolvedDestination?: DestinationSnapshot,
	/**
	 * Awaited after a recipient server accepts DATA with 354 and immediately
	 * before the message body and terminator are written.
	 */
	beforeDataBodyWrite?: () => Promise<void>
): Promise<EmailJobResult> {
	if (eligibilityLease && !(await isIpEligibilityLeaseValid(redis, eligibilityLease))) {
		return {
			success: false,
			error: 'Selected outbound IP is no longer eligible',
			bounceType: 'deferred',
			smtpCode: 451,
		};
	}

	const routing = await resolveDeliveryRoute(redis, config, job.to, resolvedDestination);
	if (routing.kind === 'undeliverable') return routing.result;
	const { recipientDomain, mxHosts, routeProvider, providerPolicy } = routing.route;

	const message = await prepareSignedMessage(job, config, redis);
	const tls = await resolveSendTlsPlan(redis, config, recipientDomain, providerPolicy.tlsMode);

	const ctx: AttemptContext = {
		redis,
		recipientDomain,
		bindIp,
		stsPolicyMode: tls.stsPolicyMode,
		eligibilityLease,
		// Announce the EHLO name that matches THIS bind IP's PTR record. In a
		// multi-IP deployment each IP has its own reverse DNS, so a single static
		// name would let only one IP pass FCrDNS — resolveEhloForIp picks the
		// per-IP override (falling back to the global name for unmapped IPs).
		ehloHostname: resolveEhloForIp(config, bindIp),
		routeProvider,
		providerPolicy,
		dkimDomain: message.dkimDomain,
		verpAddress: message.verpAddress,
		recipient: job.to,
		signedBytes: message.signedBytes,
		policyContext: tls.policyContext,
		beforeDataBodyWrite,
	};

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
		// certificate against it at the DANE floor. A `none` decision (flag off / no
		// usable TLSA) leaves the MTA-STS / local-floor path below untouched; a
		// `defer` decision (lookup failed) skips this MX without ever falling back
		// to cleartext.
		const daneDecision = routing.route.daneDiscoveryAuthenticated
			? await prepareDaneAttempt(
					redis,
					mxHost,
					recipientDomain,
					config,
					routing.route.daneDestinations.get(mxHost)
				)
			: ({ kind: 'none' } as const);
		if (daneDecision.kind === 'defer') {
			lastDaneDeferResponse = daneDecision.reason;
			continue;
		}
		if (daneDecision.kind === 'proceed') {
			// Enforce mode: requireTLS + verified TLS, with the DanePlan supplying the
			// TLSA cert-authentication hook (RFC 7672 §2, supersedes MTA-STS).
			const outcome = await attemptSend(
				ctx,
				mxHost,
				tls.daneRequirements.requireTLS,
				tls.daneRequirements.rejectUnauthorized,
				daneDecision.plan
			);
			const finished = terminalResult(outcome);
			if (finished) return finished;
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
			// floor so delivery is unaffected. Report-only is observability only, and
			// DANE never bounces mail by default.
			const probe = await attemptSend(
				ctx,
				mxHost,
				tls.daneRequirements.requireTLS,
				tls.daneRequirements.rejectUnauthorized,
				daneDecision.plan
			);
			const probeFinished = terminalResult(probe);
			if (probeFinished) return probeFinished;
			if (probe.kind === 'tls-failure') {
				// The validation-failure (tlsa policy) has already been recorded inside
				// attemptSend. Deliver anyway at the normal floor — report-only never
				// blocks mail on a DANE outcome.
				logger.debug(
					{ mxHost, recipientDomain, resultType: probe.resultType },
					'DANE report-only: TLSA result recorded; delivering at the normal TLS floor'
				);
				const retry = await attemptSend(
					ctx,
					mxHost,
					tls.requirements.requireTLS,
					tls.requirements.rejectUnauthorized
				);
				const retryFinished = terminalResult(retry);
				if (retryFinished) return retryFinished;
				if (retry.kind === 'tls-failure' && tls.requirements.requireTLS) {
					lastTlsFailureResponse = retry.response;
				}
				continue; // retry failed too — try the next MX
			}
			// over-cap / connection → try the next MX (same as the non-DANE path).
			continue;
		}

		// MTA-STS enforcement: skip MX hosts not listed in the policy
		if (tls.stsPolicyMode === 'enforce' && !isMxAllowed(mxHost, tls.allowedMxHosts)) {
			logger.warn(
				{ mxHost, recipientDomain, allowedMx: tls.allowedMxHosts },
				'MX host not permitted by MTA-STS policy, skipping'
			);
			// RFC 8460 §4.3: an MX that is not in the enforce policy is a policy
			// failure — record it, so an STS MX-mismatch is visible in our TLS-RPT
			// reports rather than a silent skip.
			void fireAndForget(
				recordTlsResult(
					redis,
					recipientDomain,
					'sts-policy-invalid',
					mxHost,
					bindIp,
					tls.policyContext
				),
				logger,
				'record_tls_result'
			);
			continue;
		}

		// MTA-STS testing mode (RFC 8461 §5.2, RFC 8460 §4.3) is report-only: it
		// must NOT block delivery, but a TLS failure that an enforce policy WOULD
		// have caught (e.g. a STARTTLS-stripping server) must still be reported.
		// So in testing mode we make ONE verifying probe attempt (requireTLS +
		// verifying); if it fails on TLS we have already recorded the result and
		// fall through to an opportunistic retry on the SAME MX so the mail is
		// still delivered.
		if (tls.stsPolicyMode === 'testing') {
			const probe = await attemptSend(ctx, mxHost, true, true);
			const probeFinished = terminalResult(probe);
			if (probeFinished) return probeFinished;
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
					ctx,
					mxHost,
					tls.requirements.requireTLS,
					tls.requirements.rejectUnauthorized
				);
				const retryFinished = terminalResult(retry);
				if (retryFinished) return retryFinished;
				if (retry.kind === 'tls-failure' && tls.requirements.requireTLS) {
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
			ctx,
			mxHost,
			tls.requirements.requireTLS,
			tls.requirements.rejectUnauthorized
		);
		const finished = terminalResult(outcome);
		if (finished) return finished;
		if (outcome.kind === 'tls-failure' && tls.requirements.requireTLS) {
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
