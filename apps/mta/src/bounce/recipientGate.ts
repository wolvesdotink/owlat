import type Redis from 'ioredis';
import type { SmtpAddress, SmtpHandlerResult, SmtpReply, SmtpSession } from '@owlat/smtp-listener';
import { isReturnPathProbeRecipient } from '@owlat/shared/verp';
import type { MtaConfig } from '../config.js';
import { findMailboxRoute } from '../inbound/mailboxResolver.js';
import { findRoute } from '../inbound/router.js';
import { deliverabilityProbeRecipientDecision } from './deliverabilityProbe.js';

export interface RecipientGateTransaction {
	deliverabilityProbeToken?: string;
}

/** Gate system recipients and configured mailbox/routes at RCPT time. */
export function buildOnRcptTo(config: MtaConfig, redis: Redis) {
	return function onRcptTo(
		address: SmtpAddress,
		session: SmtpSession<unknown, RecipientGateTransaction>
	): Promise<SmtpHandlerResult> | SmtpHandlerResult {
		if (session.transaction?.deliverabilityProbeToken && session.rcptTo.length > 0) {
			return {
				code: 550,
				enhanced: '5.5.3',
				text: 'Deliverability probes must be the only recipient',
			};
		}
		const probeDecision = deliverabilityProbeRecipientDecision(
			address.address,
			session.rcptTo.map((recipient) => recipient.address),
			config.returnPathDomain,
			config.webhookSecret
		);
		if (probeDecision.kind === 'mixed') {
			return {
				code: 550,
				enhanced: '5.5.3',
				text: 'Deliverability probes must be the only recipient',
			};
		}
		if (probeDecision.kind === 'invalid_reserved_probe') {
			return {
				code: 550,
				enhanced: '5.7.1',
				text: 'Invalid or expired deliverability probe',
			};
		}
		if (probeDecision.kind === 'probe') {
			session.transaction = {
				...session.transaction,
				deliverabilityProbeToken: probeDecision.token,
			};
			return;
		}
		if (address.address.startsWith('bounce+') || address.address.startsWith('fbl+')) return;

		// Reserved: a return-path capability probe is addressed here PRECISELY so
		// that it is refused and the relay generates a DSN we can attribute. The
		// refusal is explicit rather than incidental — without this rule a
		// catch-all route or a mailbox at the bounce domain would swallow every
		// probe, no DSN would ever be produced, and every relay would grade
		// "unsupported" forever with no diagnostic.
		if (isReturnPathProbeRecipient(address.address, config.returnPathDomain)) {
			return { code: 550, enhanced: '5.1.1', text: 'Mailbox not found' };
		}

		return findMailboxRoute(redis, address.address)
			.then((mailboxEntry): Promise<SmtpHandlerResult> | SmtpHandlerResult => {
				if (mailboxEntry) {
					if (
						mailboxEntry.quotaBytes != null &&
						mailboxEntry.usedBytes >= mailboxEntry.quotaBytes
					) {
						return { code: 552, enhanced: '5.2.2', text: 'Mailbox over quota' };
					}
					return;
				}
				return findRoute(redis, address.address, {
					ruaAddress: config.tlsRptRua,
					convexSiteUrl: config.convexSiteUrl,
					webhookSecret: config.webhookSecret,
				})
					.then((route): SmtpHandlerResult => {
						if (route && route.mode !== 'reject') return;
						return { code: 550, text: 'Mailbox not found' };
					})
					.catch((): SmtpReply => ({ code: 451, enhanced: '4.3.0', text: 'Temporary error' }));
			})
			.catch((): SmtpReply => ({ code: 451, enhanced: '4.3.0', text: 'Temporary error' }));
	};
}
