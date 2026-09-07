/**
 * MTA webhook event parser registry — the per-kind translation half of
 * `./mta.ts`, split out along the table seam (CONVENTIONS.md — split a file
 * rather than growing it past ~500 LOC).
 *
 * `MTA_EVENT_PARSERS` is an exhaustive registry over `MtaWebhookEventType`
 * (the `../dispatcher.ts` DispatchTable pattern): a kind added to
 * `MTA_WEBHOOK_EVENT_TYPES` without an entry here is a compile error, never a
 * silently 200-acked discard. Exactly one kind, `inbound.mailbox.received`,
 * is an explicit documented ignore — the MTA's notifier delivers it to
 * `POST /webhooks/mta-mailbox` (`mail/webhook.ts`), never to this surface.
 */

import { getInboundChannelAdapter } from '@owlat/channels';
import { isRecord } from '@owlat/shared';
import type {
	MtaWebhookEventType,
	ValidatedMtaWebhookEvent,
} from '@owlat/mta-protocol/webhookEvent';
import { type InboundEvent, postmasterStatsMetrics } from '../types';
import { logWarn } from '../../lib/runtimeLog';
import type { WorkerEnvelopeInput } from '../../delivery/workerEnvelope';

/** The four wire kinds that collapse into one `internal.ip_event`. */
const IP_EVENT_SUBKIND = {
	'ip.blocklisted': 'blocklisted',
	'ip.delisted': 'delisted',
	'ip.warming_complete': 'warming_complete',
	all_ips_blocked: 'all_blocked',
} as const;

type IpWebhookEventType = keyof typeof IP_EVENT_SUBKIND;

/** The validated payload variant for one wire kind. */
type MtaEventOf<K extends MtaWebhookEventType> = Extract<ValidatedMtaWebhookEvent, { event: K }>;

/**
 * Exhaustive parser registry type — `{ [K in MtaWebhookEventType]: parser }`.
 * An entry may still return null for a payload that fails its own
 * trust-boundary re-checks.
 */
type MtaEventParserTable = {
	[K in MtaWebhookEventType]: (payload: MtaEventOf<K>) => InboundEvent | null;
};

function parseIpEvent(payload: MtaEventOf<IpWebhookEventType>): InboundEvent {
	return {
		kind: 'internal.ip_event',
		subkind: IP_EVENT_SUBKIND[payload.event],
		...(payload.ip ? { ip: payload.ip } : {}),
		...(payload.blocklists ? { blocklists: payload.blocklists } : {}),
		...(payload.severity ? { severity: payload.severity } : {}),
		...(payload.message ? { message: payload.message } : {}),
	};
}

/**
 * `satisfies`, not a type annotation: it checks the table against
 * {@link MtaEventParserTable} — a missing kind is an error HERE — while
 * keeping the literal key set, so the never-assertion below reads the keys
 * that were actually written rather than the ones the annotation promised.
 */
export const MTA_EVENT_PARSERS = {
	'routing.reentry': (payload) => {
		const reentry = isRecord(payload.routingReentry) ? payload.routingReentry : null;
		const retryState = reentry && isRecord(reentry['retryState']) ? reentry['retryState'] : null;
		// The optional fields are part of the callback digest issued by
		// `issueSnapshot`, so they must round-trip byte-for-byte. Dropping
		// them turns every acceptance-reconciliation re-entry into a
		// permanent `binding_mismatch` and strands the Send in `queued`.
		const reentryWorkAttemptId = retryState?.['workAttemptId'];
		const acceptanceReconciliation = retryState?.['acceptanceReconciliation'];
		if (
			!payload.messageId ||
			typeof payload.routingReentryToken !== 'string' ||
			payload.routingReentryToken.length < 1 ||
			payload.routingReentryToken.length > 512 ||
			typeof payload.workAttemptId !== 'string' ||
			payload.workAttemptId.length < 1 ||
			payload.workAttemptId.length > 128 ||
			!reentry ||
			!isRecord(reentry['envelopeInput']) ||
			!retryState ||
			typeof retryState['attempt'] !== 'number' ||
			!Number.isInteger(retryState['attempt']) ||
			retryState['attempt'] < 1 ||
			retryState['attempt'] > 9 ||
			typeof retryState['startedAt'] !== 'number' ||
			!Number.isFinite(retryState['startedAt']) ||
			retryState['idempotencyKey'] !== payload.messageId ||
			(reentryWorkAttemptId !== undefined &&
				(typeof reentryWorkAttemptId !== 'string' ||
					reentryWorkAttemptId.length < 1 ||
					reentryWorkAttemptId.length > 128)) ||
			(acceptanceReconciliation !== undefined && typeof acceptanceReconciliation !== 'boolean') ||
			(payload.routingReentryReason !== 'routing_lease_stale' &&
				payload.routingReentryReason !== 'circuit_breaker_changed' &&
				payload.routingReentryReason !== 'warming_capacity_changed')
		)
			return null;
		return {
			kind: 'internal.routing_reentry',
			providerMessageId: payload.messageId,
			token: payload.routingReentryToken,
			workAttemptId: payload.workAttemptId,
			envelopeInput: reentry['envelopeInput'] as WorkerEnvelopeInput,
			retryState: {
				attempt: retryState['attempt'],
				startedAt: retryState['startedAt'],
				idempotencyKey: payload.messageId,
				...(typeof reentryWorkAttemptId === 'string'
					? { workAttemptId: reentryWorkAttemptId }
					: {}),
				...(typeof acceptanceReconciliation === 'boolean' ? { acceptanceReconciliation } : {}),
			},
			reason: payload.routingReentryReason,
		};
	},
	'postmaster.authorize_domain': (payload) => {
		if (!payload.domain) return null;
		return {
			kind: 'internal.postmaster_authorize_domain',
			domain: payload.domain,
		};
	},
	bounced: (payload) => {
		if (!payload.messageId) return null;
		return {
			kind: 'email.bounced',
			providerMessageId: payload.messageId,
			at: payload.timestamp,
			bounceType: payload.bounceType === 'hard' ? 'hard' : 'soft',
			...(payload.message ? { bounceMessage: payload.message } : {}),
			...(payload.deliveryDomain ? { deliveryDomain: payload.deliveryDomain } : {}),
			providerType: 'mta',
		};
	},
	failed: (payload) => {
		// Terminal, NON-bounce failure (for example a screened message or an
		// ambiguous post-DATA drop). Map to
		// the `failed` send status — distinct from `bounced`, so the dispatcher
		// applies NO recipient suppression and NO reputation penalty.
		if (!payload.messageId) return null;
		const errorCode =
			typeof payload.errorCode === 'string' &&
			payload.errorCode.length > 0 &&
			payload.errorCode.length <= 128
				? payload.errorCode
				: 'ambiguous_post_data';
		return {
			kind: 'email.failed',
			providerMessageId: payload.messageId,
			at: payload.timestamp ?? Date.now(),
			errorMessage: payload.message ?? 'Delivery failed (ambiguous post-DATA drop)',
			errorCode,
			...(payload.deliveryDomain ? { deliveryDomain: payload.deliveryDomain } : {}),
			providerType: 'mta',
		};
	},
	complained: (payload) => {
		// Prefer Message-ID attribution; fall back to the recipient
		// address (RFC 5965 §3.2) so a Gmail-redacted FBL still
		// suppresses the complainer. Drop only when neither is present.
		//
		// `reportedDomain` / `sourceIsp` ride along on BOTH shapes: they say
		// which of our DKIM domains the report named and which ISP filed it,
		// independent of which attribution handle the report carried. NOT to be
		// confused with `arf.feedbackProvenance` (production vs member-preview
		// delivery domain) — hence the `fblReport` prefix.
		const fblReportProvenance = {
			...(payload.reportedDomain ? { reportedDomain: payload.reportedDomain } : {}),
			...(payload.sourceIsp ? { sourceIsp: payload.sourceIsp } : {}),
		};
		if (payload.messageId) {
			return {
				kind: 'email.complained',
				providerMessageId: payload.messageId,
				at: payload.timestamp,
				providerType: 'mta',
				...(payload.deliveryDomain ? { deliveryDomain: payload.deliveryDomain } : {}),
				...fblReportProvenance,
			};
		}
		if (payload.recipient) {
			return {
				kind: 'email.complained',
				recipient: payload.recipient,
				at: payload.timestamp,
				providerType: 'mta',
				...(payload.deliveryDomain ? { deliveryDomain: payload.deliveryDomain } : {}),
				...fblReportProvenance,
			};
		}
		return null;
	},
	sent: (payload) => {
		if (!payload.messageId) return null;
		return {
			// The MTA emits this only after the destination SMTP server has
			// accepted DATA. POST /send queue acceptance is recorded separately
			// by the worker as `sent`; this is the truthful delivered denominator.
			kind: 'email.delivered',
			providerMessageId: payload.messageId,
			at: payload.timestamp ?? Date.now(),
			providerType: 'mta',
			...(payload.organizationId ? { organizationId: payload.organizationId } : {}),
			...(payload.recipient ? { recipient: payload.recipient } : {}),
			...(payload.destinationProvider ? { destinationProvider: payload.destinationProvider } : {}),
			...(payload.primarySendingDomain
				? { primarySendingDomain: payload.primarySendingDomain }
				: {}),
			...(payload.deliveryDomain ? { deliveryDomain: payload.deliveryDomain } : {}),
		};
	},
	'inbound.received': (payload) => {
		if (!payload.inboundPayload) return null;
		// Delegate envelope normalization to @owlat/channels so the
		// MTA SMTP server and webhook share one parser.
		const normalized = getInboundChannelAdapter('mta').parseInbound(payload);
		return { kind: 'inbound.received', mail: normalized };
	},
	'inbound.mailbox.received': () => {
		// EXPLICIT IGNORE, not a parser. Personal-mailbox inbound is served by
		// `POST /webhooks/mta-mailbox` (`mail/webhook.ts`): the MTA's notifier
		// (`apps/mta/src/webhooks/convexNotifier.ts`) branches this kind to that
		// route before it can ever reach `POST /webhooks/mta`. The entry exists so
		// the table stays total over the wire union; an event of this kind landing
		// HERE is a producer routing bug, so trace it before the pipeline acks.
		logWarn(
			'[mta Webhook] inbound.mailbox.received arrived on /webhooks/mta; it is served by /webhooks/mta-mailbox — acknowledging without dispatch'
		);
		return null;
	},
	'org.circuit_breaker': (payload) => {
		return {
			kind: 'internal.circuit_breaker_tripped',
			message: payload.message ?? 'high bounce rate',
			...(payload.bounceRate !== undefined ? { bounceRate: payload.bounceRate } : {}),
		};
	},
	'dkim.rotated': (payload) => {
		if (
			!payload.domain ||
			!payload.selector ||
			!payload.dnsRecord ||
			(payload.phase !== 'pending' && payload.phase !== 'activated')
		) {
			return null;
		}
		return {
			kind: 'internal.dkim_rotated',
			domain: payload.domain,
			selector: payload.selector,
			dnsRecord: payload.dnsRecord,
			phase: payload.phase,
		};
	},
	'campaign.complaint_rate': (payload) => {
		return {
			kind: 'internal.campaign_complaint_rate',
			eventId: payload.eventId,
			message: payload.message,
			campaignId: payload.campaignId,
			complaintRate: payload.complaintRate,
			at: payload.timestamp,
		};
	},
	'ip.blocklisted': parseIpEvent,
	'ip.delisted': parseIpEvent,
	'ip.warming_complete': parseIpEvent,
	all_ips_blocked: parseIpEvent,
	'smtp.classified': (payload) => {
		// Both fields are already narrowed by `isMtaWebhookEvent` — the category
		// against the SHARED vocabulary, never re-derived from `message` here.
		// The re-check is the adapter's own trust boundary, the shape every entry
		// in this table keeps.
		if (!payload.messageId || !payload.smtpCategory) return null;
		return {
			kind: 'internal.smtp_classified',
			providerMessageId: payload.messageId,
			category: payload.smtpCategory,
			observedAt: payload.timestamp,
		};
	},
	'ip.readiness_regressed': (payload) => {
		return {
			kind: 'internal.ip_readiness_regressed',
			eventId: payload.eventId,
			ip: payload.ip,
			readinessCheck: payload.readinessCheck,
			readinessReason: payload.readinessReason,
			eligibilityGeneration: payload.eligibilityGeneration,
			observedAt: payload.timestamp,
			message: payload.message,
		};
	},
	'deliverability.probe_observed': (payload) => {
		const authResult = (value: string | undefined) =>
			value === 'pass'
				? ('pass' as const)
				: value === 'fail'
					? ('fail' as const)
					: ('unknown' as const);
		return {
			kind: 'internal.deliverability_probe_observed',
			token: payload.probeToken,
			spf: authResult(payload.spfResult),
			dkim: authResult(payload.dkimResult),
			dmarc: authResult(payload.dmarcResult),
			...(payload.selector ? { dkimSelector: payload.selector } : {}),
			tlsVersion: payload.tlsVersion,
			sendingIp: payload.ip,
			ptr: payload.ptr,
		};
	},
	'postmaster.stats': (payload) => {
		if (
			!payload.domain ||
			!payload.date ||
			typeof payload.userReportedSpamRatio !== 'number' ||
			!Number.isFinite(payload.userReportedSpamRatio) ||
			payload.userReportedSpamRatio < 0 ||
			payload.userReportedSpamRatio > 1
		) {
			return null;
		}
		return {
			kind: 'internal.postmaster_stats',
			domain: payload.domain,
			date: payload.date,
			userReportedSpamRatio: payload.userReportedSpamRatio,
			...postmasterStatsMetrics(payload),
			fetchedAt: payload.timestamp,
		};
	},
	'postmaster.compliance': (payload) => {
		// The shared contract already bounded and shape-checked `checks`.
		if (!payload.domain || !payload.date || payload.checks === undefined) return null;
		return {
			kind: 'internal.postmaster_compliance',
			domain: payload.domain,
			date: payload.date,
			checks: payload.checks,
			fetchedAt: payload.timestamp,
		};
	},
} satisfies MtaEventParserTable;

/** Resolves only when its argument is `true`; otherwise it is a build error. */
type AssertTotal<T extends true> = T;

/**
 * Compile-time never-assertion (the `domains/providers/registerAction.ts`
 * gate). The `satisfies` above already makes a missing kind an error where the
 * table is written; this states the totality as a fact of its own, read off
 * the literal keys actually written, so weakening or dropping that `satisfies`
 * later cannot silently reopen the default-arm hole this registry replaced —
 * every kind `MTA_WEBHOOK_EVENT_TYPES` declares must be a key here, or the
 * build fails on this line.
 */
export type _MtaEventParsersAreTotal = AssertTotal<
	Exclude<MtaWebhookEventType, keyof typeof MTA_EVENT_PARSERS> extends never ? true : false
>;
