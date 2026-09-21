import type Redis from 'ioredis';
import type { SmtpAddress, SmtpHandlerResult, SmtpSession } from '@owlat/smtp-listener';
import { checkSpf } from '@owlat/mail-auth';
import { emailDomain } from '@owlat/shared/spfAlignment';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';
import { inboundTlsRequiredReply, isInboundTlsRequired } from '../inbound/inboundTlsPolicy.js';
import type { createInboundAuthResolvers } from './inboundAuthResolver.js';
import type { SpfVerdict } from './types.js';

/** The part of the transaction state this gate writes (read back in `onData`). */
export interface SenderGateTransaction {
	spfResult?: SpfVerdict;
	envelopeFromDomain?: string;
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
		session: SmtpSession<unknown, SenderGateTransaction>
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
