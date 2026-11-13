/**
 * The vocabulary of the delivery readiness verdict: what it is derived from
 * (`ReadinessInput` and the query-shaped sources folded into it) and what comes
 * out (`DeliveryReadiness`, one `StreamVerdict` per stream).
 *
 * Pure types: no Convex client, no DOM.
 */

import type { OutboundTransportFacts } from '@owlat/shared';
import type {
	SendingIpPools,
	SendingIpPosture,
	SendingIpPostureInput,
} from '@owlat/shared/ipReadiness';
import type { ReadinessDualArmSummary } from '~/utils/dualArmAlignment';
import type { HealthTone } from '~/utils/healthTone';
import type { LocalizedText } from '~/utils/localizedText';
import type { MailStream, ReadinessGate } from '~/utils/readinessGate';

/** Overall readiness level for the panel's headline chip. */
export type ReadinessLevel = 'ready' | 'blocked' | 'incomplete';

/** One stream's verdict: can this kind of mail go out, and if not, what first? */
export type StreamLevel = 'ready' | 'attention' | 'blocked';

export interface StreamVerdict {
	stream: MailStream;
	level: StreamLevel;
	tone: HealthTone;
	/** The verdict in a word, e.g. "Ready". Never conveyed by colour alone. */
	label: LocalizedText;
	/** One sentence: the first open gate for this stream, or what is in place. */
	sentence: LocalizedText;
	/** Where the first open gate is fixed, or `null` when nothing is open. */
	actionHref: string | null;
	actionLabel: LocalizedText | null;
}

export interface DeliveryReadiness {
	/** The real gate: transport configured AND a verified sending domain. */
	canSend: boolean;
	/** The worst of the stream verdicts, as the panel's single headline. */
	level: ReadinessLevel;
	tone: HealthTone;
	/** Headline verdict, e.g. "Ready to send". */
	headline: LocalizedText;
	/** One sentence naming the single next thing to do (or an all-clear line). */
	summary: LocalizedText;
	gates: ReadinessGate[];
	/** One verdict per enabled stream, transactional first. */
	streams: StreamVerdict[];
}

/** The transport facts of one stream (`getTransportSummary.streams.*`). */
export interface StreamTransportFacts {
	/** `isDeliveryConfigured` for this message type. */
	canSend: boolean;
	/** The catalog labels of the transports carrying this type. */
	providerLabels: readonly string[];
	/** Whether the built-in MTA is one of them, so its gates apply. */
	usesOwnMta: boolean;
}

/** The built-in MTA's health, classified as the Delivery health roll-up does. */
export type MailServerState =
	| 'healthy'
	| 'degraded'
	| 'signing_held'
	| 'unreachable'
	| 'stale'
	| 'unchecked';

/** Today's campaign capacity: paced by warm-up, or not capped at all. */
export type MarketingCapacity = { paced: true; today: number } | { paced: false };

/** The derived facts the readiness verdict is computed from. */
export interface ReadinessInput {
	/**
	 * The real send-path gate — `getTransportSummary.canSend`, itself
	 * `isDeliveryConfigured` on the backend. True only when a usable transport
	 * (provider + credentials, or an advanced route) is configured.
	 */
	transportConfigured: boolean;
	/** Whether any sending domain is configured at all. */
	hasDomains: boolean;
	/** Whether at least one sending domain has fully verified. */
	domainVerified: boolean;
	/** For the best-configured domain: are SPF, DKIM AND DMARC all present? */
	authComplete: boolean;
	/** Auth record names still missing for that domain, in display order. */
	authMissing: string[];
	/**
	 * The deployment is publishing an MTA-STS policy in `enforce` mode, but the
	 * `_mta-sts` TXT record / served policy isn't verified yet. Optional and
	 * defaults to "no warning" — deployments that publish nothing (the default)
	 * or are still in `testing` leave it unset, so this never touches their
	 * verdict. When true it downgrades an otherwise-ready instance to a warning:
	 * enforce without the record in place can bounce inbound mail from senders
	 * that honour the policy.
	 */
	mtaStsEnforceWithoutRecord?: boolean;
	/**
	 * The active transport signs/bounces mail as a domain that doesn't align with
	 * one or more of the configured sending domains, so DMARC fails for that mail
	 * (RFC 7489). Typical cause: a generic SMTP relay signing as its OWN domain
	 * instead of the operator's. Optional and defaults to "no warning" — the
	 * built-in MTA and a correctly-configured relay leave it unset. When true it
	 * downgrades an otherwise-ready instance to a warning: the instance CAN send,
	 * but that mail is at risk of being treated as spam.
	 */
	transportMisaligned?: boolean;
	/** The sending domains the active transport is misaligned for, in display order. */
	misalignedDomains?: string[];
	/** One plain-language line on WHY the transport is misaligned (per-transport guidance). */
	alignmentReason?: string | null;
	/**
	 * The dual-transport ramp's alignment pre-flight, or `undefined` when
	 * there is nothing to say — no reference transport, no verdict yet, or every
	 * domain reporting `single_arm`. Undefined renders NO gate at all: running on
	 * the own MTA alone is a supported configuration, never an unfinished setup.
	 */
	dualArmAlignment?: ReadinessDualArmSummary | undefined;
	/**
	 * Per-stream transport facts. Absent means the overall `transportConfigured`
	 * stands for both streams and no transport is named.
	 */
	streamTransport?: Readonly<Record<MailStream, StreamTransportFacts>>;
	/** Streams whose feature is switched off get no verdict. Absent means both on. */
	streamsEnabled?: Partial<Record<MailStream, boolean>>;
	/** The built-in MTA's health; `null` when no stream is sent through it. */
	mailServer?: MailServerState | null;
	/** Each stream's sending-IP posture; `null` or absent before IPs are synced. */
	sendingIps?: Partial<Record<MailStream, SendingIpPosture | null>>;
	/** The MTA reports the campaign warm-up halted (`plateau`). */
	warmupHalted?: boolean;
	/** The transactional default sender; `null` or absent when unknown. */
	defaultSender?: { address: string | null; isDomainVerified: boolean } | null;
	/** Today's campaign capacity; `null` or absent when it cannot be measured. */
	marketingCapacity?: MarketingCapacity | null;
	/** Rolling complaint rate; `null` or absent with no sending activity. */
	complaintRate?: number | null;
	/**
	 * The checklist's one-click unsubscribe check, for viewers who may read the
	 * checklist; `null` or absent when unknown, which is never shown as a failure.
	 */
	oneClickUnsubscribe?: 'pass' | 'fail' | null;
}

/**
 * The per-stream half of the sources: what `getTransportSummary`,
 * `getSendingOverview`, `getSendingReadiness` and (for admins) the deliverability
 * checklist report, narrowed to what the stream verdicts read.
 */
export interface ReadinessStreamSources {
	streams: { transactional: StreamTransportFacts; campaign: StreamTransportFacts };
	mailServer: MailServerState | null;
	transactionalSender: { address: string | null; isDomainVerified: boolean } | null;
	enabled?: Partial<Record<MailStream, boolean>>;
	warming?: {
		phase: string;
		ips: readonly SendingIpPostureInput[];
		pools?: SendingIpPools | null;
	} | null;
	sendingReadiness?: { capped: false } | { capped: true; today: number } | null;
	reputation?: { complaintRate: number } | null;
	oneClickUnsubscribe?: 'pass' | 'fail' | null;
}

/**
 * The transport half of the two go-live sources: the non-secret
 * `getTransportSummary` — only `canSend` (the real send-path gate) matters here.
 */
export interface ReadinessTransportSummary {
	canSend: boolean;
}

/**
 * The domain half: one row of `getDeliveryDomainTable`, narrowed to the two
 * facts readiness needs — whether it's verified and which auth records are still
 * missing. Structural on purpose so this stays free of the Convex client.
 */
export interface ReadinessDomainRow {
	status: 'registering' | 'pending' | 'verified' | 'failed';
	missing: string[];
}

/**
 * The MTA-STS half: the deployment's current inbound-TLS publishing state,
 * narrowed to the two facts readiness needs. Structural on purpose (no import of
 * the shared `MtaStsMode`) so this stays a pure primitive-in helper. Optional —
 * a viewer who can't read the admin-gated guidance (or a deployment that
 * publishes nothing) passes `null` and the MTA-STS gate never appears.
 */
export interface ReadinessMtaStsSource {
	/** Current publishing mode (`none` | `testing` | `enforce`). */
	mode: 'none' | 'testing' | 'enforce';
	/** The `_mta-sts` record + served policy verified live against what we serve. */
	recordVerified: boolean;
}

/**
 * The outbound-alignment half: the active transport's effective identities plus
 * the sending domains to check them against. Optional — a viewer or deployment
 * without the transport facts (or with no sending domains yet) passes `null` and
 * the alignment gate never appears. Structural on purpose so this stays a pure
 * primitive-in helper.
 */
export interface ReadinessAlignmentSource {
	/** The active transport's effective DKIM / return-path identities. */
	facts: OutboundTransportFacts;
	/** The configured sending domains to test alignment against. */
	fromDomains: readonly string[];
}
