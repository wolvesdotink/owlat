/**
 * The submission AUTH chain (master key -> per-org credential -> Postbox app
 * password) as the listener's single `authenticate` hook, gated by the per-IP
 * failed-AUTH throttle (RFC 4954 §4, OWASP brute-force).
 */

import type { SmtpAuthOutcome } from '@owlat/smtp-listener';
import { secretMatches } from '@owlat/shared/constantTimeEqual';
import { lookupCredential } from '../auth/credentials.js';
import { verifyPostboxAppPassword } from '../auth/postboxAuth.js';
import { logger } from '../monitoring/logger.js';
import { checkAuthThrottle, recordAuthFailure } from './submissionSecurity.js';
import type { SubmissionDeps, SubmissionSession } from './submissionSession.js';

/**
 * Best-effort client identifier for the app-password "Last used" column — the
 * EHLO/HELO name the client announced. (The old smtp-server path also consulted
 * a reverse-DNS `clientHostname`; the in-house listener performs no reverse DNS,
 * so the announced EHLO name is the single source — see the PR body.)
 */
function clientName(session: SubmissionSession): string | undefined {
	const ehlo = typeof session.clientHostname === 'string' ? session.clientHostname.trim() : '';
	return ehlo || undefined;
}

/** Best-effort remote IP from the session (for throttling / limiting). */
function sessionRemoteIp(session: SubmissionSession): string {
	return session.remoteAddress || 'unknown';
}

/**
 * AUTH handler: master key -> per-org credential -> Postbox app password.
 * Exported (factory form) so the auth chain is unit-testable.
 *
 * Every path that fails records a per-IP failure and is gated by a per-IP
 * failed-attempt throttle, so the master key and per-org credentials cannot be
 * brute-forced by reconnecting (RFC 4954 §4). A successful AUTH leaves the
 * counter alone, so it cannot be used to refill the budget. The listener
 * collapses every failure to one `535 5.7.8` on the wire (no auth oracle),
 * so the throttle rejection is byte-identical to a wrong secret.
 */
export function buildAuthenticate(deps: Pick<SubmissionDeps, 'redis' | 'config'>) {
	const { redis, config } = deps;
	return async function authenticate(
		credentials: { username: string; password: string },
		session: SubmissionSession
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
