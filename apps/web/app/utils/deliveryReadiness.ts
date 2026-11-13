import { summarizeOutboundAlignment, type OutboundTransportFacts } from '@owlat/shared';
import type { HealthTone } from '~/utils/healthTone';
import {
	dualArmAlignmentGate,
	summarizeDualArmAlignment,
	type ReadinessDualArmRow,
	type ReadinessDualArmSummary,
} from '~/utils/dualArmAlignment';
import type {
	MailStream,
	ReadinessGate,
	ReadinessGateKey,
	ReadinessGateStatus,
} from '~/utils/readinessGate';
import type { LocalizedText } from '~/utils/localizedText';
import {
	sendingIpPosture,
	type SendingIpPosture,
	type SendingIpPostureInput,
} from '@owlat/shared/ipReadiness';
import { REPUTATION_THRESHOLDS } from '@owlat/shared/reputation';
import { formatNumber, formatPercentage } from '~/utils/formatters';

export type { ReadinessDualArmRow, ReadinessDualArmSummary };
export type { MailStream, ReadinessGate, ReadinessGateKey, ReadinessGateStatus };
export type { SendingIpPosture };

/**
 * The single source of truth for "can this instance actually send mail, and if
 * not, what is missing?".
 *
 * Go-live for a self-hosted Owlat has two halves set up in two different
 * places — the setup wizard / delivery config (a transport) and the domains page
 * (a verified, authenticated sending domain) — and a banner that re-lists both on
 * its own reads as if the wizard never ran. This helper is where the two halves
 * meet: it DERIVES one combined readiness
 * verdict from the real backend state (`getTransportSummary.canSend` +
 * `getDeliveryDomainTable`), so the Delivery hub leads with it and the onboarding
 * banner can defer its pre-send steps to this one place instead of duplicating
 * them.
 *
 * Kept DOM- and DB-free (pure primitives in, plain data out) so the gate → state
 * mapping is unit-testable without mounting anything or reaching the Convex
 * client.
 */

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
export type MailServerState = 'healthy' | 'degraded' | 'unreachable' | 'stale' | 'unchecked';

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
	warming?: { phase: string; ips: readonly SendingIpPostureInput[] } | null;
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

/**
 * Fold the live query results into the flat `ReadinessInput` the verdict is
 * derived from. This is the small piece of real derivation behind the panel:
 * which domain we report authentication against, plus the conditional
 * MTA-STS warning.
 *
 * `getDeliveryDomainTable` returns rows already sorted most-active first, so we
 * report auth against the most-active VERIFIED domain (the one mail actually
 * sends from), falling back to the most-active configured domain before any has
 * verified, and to nothing at all when there are no domains yet.
 *
 * `mtaSts` is the admin-only inbound-TLS state: only `enforce` published WITHOUT
 * the record verified sets `mtaStsEnforceWithoutRecord` (and thus the warning);
 * `none`/`testing`, an already-verified record, or a `null` source (non-admin or
 * no policy) leave it unset so nothing changes for those deployments.
 */
export function readinessInputFromSources(
	summary: ReadinessTransportSummary,
	rows: readonly ReadinessDomainRow[],
	mtaSts?: ReadinessMtaStsSource | null,
	alignment?: ReadinessAlignmentSource | null,
	dualArmRows?: readonly ReadinessDualArmRow[] | null,
	streamSources?: ReadinessStreamSources | null
): ReadinessInput {
	const verified = rows.filter((row) => row.status === 'verified');
	const primary = verified[0] ?? rows[0] ?? null;
	const alignmentSummary =
		alignment != null ? summarizeOutboundAlignment(alignment.fromDomains, alignment.facts) : null;
	return {
		transportConfigured: summary.canSend,
		hasDomains: rows.length > 0,
		domainVerified: verified.length > 0,
		authComplete: primary ? primary.missing.length === 0 : false,
		authMissing: primary?.missing ?? [],
		mtaStsEnforceWithoutRecord:
			mtaSts != null && mtaSts.mode === 'enforce' && !mtaSts.recordVerified,
		transportMisaligned: alignmentSummary?.misaligned ?? false,
		misalignedDomains: alignmentSummary?.misalignedDomains ?? [],
		alignmentReason: alignmentSummary?.reason ?? null,
		dualArmAlignment: summarizeDualArmAlignment(dualArmRows),
		...(streamSources ? streamInputFromSources(streamSources) : {}),
	};
}

/**
 * The stream facts of a {@link ReadinessInput}. Sending IPs are judged per
 * pool (`transactional`, `campaign`) and only for a stream the MTA carries; the
 * warm-up only paces campaigns, so only the marketing stream reads it.
 */
function streamInputFromSources(sources: ReadinessStreamSources): Partial<ReadinessInput> {
	const streamTransport = {
		transactional: sources.streams.transactional,
		marketing: sources.streams.campaign,
	};
	const ips = sources.warming?.ips ?? [];
	const capacity = sources.sendingReadiness;
	return {
		streamTransport,
		streamsEnabled: sources.enabled ?? {},
		mailServer: sources.mailServer,
		sendingIps: {
			transactional: streamTransport.transactional.usesOwnMta
				? sendingIpPosture(ips, 'transactional')
				: null,
			marketing: streamTransport.marketing.usesOwnMta ? sendingIpPosture(ips, 'campaign') : null,
		},
		warmupHalted: streamTransport.marketing.usesOwnMta && sources.warming?.phase === 'plateau',
		defaultSender: sources.transactionalSender,
		marketingCapacity:
			capacity == null
				? null
				: capacity.capped
					? { paced: true, today: capacity.today }
					: { paced: false },
		complaintRate: sources.reputation?.complaintRate ?? null,
		oneClickUnsubscribe: sources.oneClickUnsubscribe ?? null,
	};
}

const DOMAINS_HREF = '/dashboard/admin/delivery/domains';
const CONFIG_HREF = '/dashboard/admin/delivery/transport';
const DELIVERABILITY_HREF = '/dashboard/admin/delivery/deliverability';
const SENDER_HREF = '/dashboard/admin/instance/general';
const OWN_SERVER: LocalizedText = 'shared.deliveryReadiness.transport.ownServer';

const STREAMS: readonly MailStream[] = ['transactional', 'marketing'];

function isStreamEnabled(input: ReadinessInput, stream: MailStream): boolean {
	return input.streamsEnabled?.[stream] !== false;
}

/** The transport label of one stream ("Amazon SES + Owlat MTA"), or `null`. */
function transportLabel(facts: StreamTransportFacts | undefined): string | null {
	return facts && facts.providerLabels.length > 0 ? facts.providerLabels.join(' + ') : null;
}

/** The enabled streams the built-in MTA carries. */
function ownMtaStreams(input: ReadinessInput): MailStream[] {
	return STREAMS.filter(
		(stream) => isStreamEnabled(input, stream) && input.streamTransport?.[stream].usesOwnMta
	);
}

/**
 * The transport gates. Without stream facts there is one, read off the overall
 * `canSend`. With them, each stream gets the gate its own message type's send
 * path applies, merged into one when both streams agree on transport and state.
 */
function transportGates(input: ReadinessInput): ReadinessGate[] {
	const facts = input.streamTransport;
	if (!facts) return [transportGate(input)];
	const streams = STREAMS.filter((stream) => isStreamEnabled(input, stream));
	if (streams.length === 0) return [transportGate(input)];
	const [first, second] = streams;
	if (
		first !== undefined &&
		second !== undefined &&
		facts[first].canSend === facts[second].canSend &&
		transportLabel(facts[first]) === transportLabel(facts[second])
	) {
		return [
			{
				...transportGate({ ...input, transportConfigured: facts[first].canSend }),
				transport: transportLabel(facts[first]),
			},
		];
	}
	return streams.map((stream) => ({
		...transportGate({ ...input, transportConfigured: facts[stream].canSend }),
		...(facts[stream].canSend
			? {}
			: { detail: `shared.deliveryReadiness.gates.transport.missingFor.${stream}` }),
		streams: [stream],
		transport: transportLabel(facts[stream]),
	}));
}

/** The transport gate: reads the same `canSend` the send path itself uses. */
function transportGate(input: ReadinessInput): ReadinessGate {
	if (input.transportConfigured) {
		return {
			key: 'transport',
			title: 'shared.deliveryReadiness.gates.transport.title',
			detail: 'shared.deliveryReadiness.gates.transport.configured',
			status: 'ready',
			tone: 'success',
			actionHref: null,
			actionLabel: null,
		};
	}
	return {
		key: 'transport',
		title: 'shared.deliveryReadiness.gates.transport.title',
		detail: 'shared.deliveryReadiness.gates.transport.missing',
		status: 'attention',
		tone: 'error',
		actionHref: CONFIG_HREF,
		actionLabel: 'shared.deliveryReadiness.gates.transport.action',
		isBlocking: true,
	};
}

/** The sending-domain gate: needs a domain, then that domain to verify. */
function domainGate(input: ReadinessInput): ReadinessGate {
	if (input.domainVerified) {
		return {
			key: 'domain',
			title: 'shared.deliveryReadiness.gates.domain.title',
			detail: 'shared.deliveryReadiness.gates.domain.verified',
			status: 'ready',
			tone: 'success',
			actionHref: null,
			actionLabel: null,
		};
	}
	if (input.hasDomains) {
		return {
			key: 'domain',
			title: 'shared.deliveryReadiness.gates.domain.title',
			detail: 'shared.deliveryReadiness.gates.domain.unverified',
			status: 'pending',
			tone: 'warning',
			actionHref: DOMAINS_HREF,
			actionLabel: 'shared.deliveryReadiness.gates.domain.actionCheck',
			isBlocking: true,
		};
	}
	return {
		key: 'domain',
		title: 'shared.deliveryReadiness.gates.domain.title',
		detail: 'shared.deliveryReadiness.gates.domain.missing',
		status: 'attention',
		tone: 'warning',
		actionHref: DOMAINS_HREF,
		actionLabel: 'shared.deliveryReadiness.gates.domain.actionAdd',
		isBlocking: true,
	};
}

/** The DMARC record name, as `getDeliveryDomainTable` reports it missing. */
const DMARC = 'DMARC';

/**
 * The email-authentication gate: SPF and DKIM on the sending domain, which
 * every stream needs. DMARC is the marketing stream's own gate (see
 * {@link dmarcGate}): mailbox providers require it of bulk senders.
 */
function authenticationGate(input: ReadinessInput): ReadinessGate {
	// Nothing to authenticate until a domain exists — stay pending, not red, so a
	// brand-new instance doesn't read as broken before the domain step is even done.
	if (!input.hasDomains) {
		return {
			key: 'authentication',
			title: 'shared.deliveryReadiness.gates.authentication.title',
			detail: 'shared.deliveryReadiness.gates.authentication.awaitingDomain',
			status: 'pending',
			tone: 'neutral',
			actionHref: null,
			actionLabel: null,
		};
	}
	const missing = input.authMissing.filter((record) => record !== DMARC);
	if (missing.length === 0) {
		return {
			key: 'authentication',
			title: 'shared.deliveryReadiness.gates.authentication.title',
			detail: 'shared.deliveryReadiness.gates.authentication.complete',
			status: 'ready',
			tone: 'success',
			actionHref: null,
			actionLabel: null,
		};
	}
	// The record names are the protocol acronyms, identical in every language, so
	// they travel as a parameter rather than as keys of their own.
	return {
		key: 'authentication',
		title: 'shared.deliveryReadiness.gates.authentication.title',
		detail: {
			key: 'shared.deliveryReadiness.gates.authentication.missing',
			params: { records: missing.join(', ') },
		},
		status: 'attention',
		tone: 'warning',
		actionHref: DOMAINS_HREF,
		actionLabel: 'shared.deliveryReadiness.gates.authentication.action',
	};
}

/** Marketing: a published DMARC record, which bulk senders must have. */
function dmarcGate(input: ReadinessInput): ReadinessGate | null {
	if (!input.hasDomains) return null;
	const isMissing = input.authMissing.includes(DMARC);
	return {
		key: 'dmarc',
		title: 'shared.deliveryReadiness.gates.dmarc.title',
		detail: isMissing
			? 'shared.deliveryReadiness.gates.dmarc.missing'
			: 'shared.deliveryReadiness.gates.dmarc.published',
		status: isMissing ? 'attention' : 'ready',
		tone: isMissing ? 'warning' : 'success',
		actionHref: isMissing ? DOMAINS_HREF : null,
		actionLabel: isMissing ? 'shared.deliveryReadiness.gates.dmarc.action' : null,
		streams: ['marketing'],
	};
}

/**
 * The built-in MTA's own health, for the streams it carries. Degraded or
 * unreachable stops mail; a stale or never-run check asks for a look, exactly
 * as the Delivery health roll-up grades it.
 */
function mailServerGate(input: ReadinessInput): ReadinessGate | null {
	const streams = ownMtaStreams(input);
	const state = input.mailServer;
	if (streams.length === 0 || state == null) return null;
	const base = {
		key: 'mail-server' as const,
		title: 'shared.deliveryReadiness.gates.mailServer.title',
		detail: `shared.deliveryReadiness.gates.mailServer.${state}`,
		streams,
		transport: OWN_SERVER,
	};
	if (state === 'healthy') {
		return { ...base, status: 'ready', tone: 'success', actionHref: null, actionLabel: null };
	}
	const isBlocking = state === 'degraded' || state === 'unreachable';
	return {
		...base,
		status: 'attention',
		tone: isBlocking ? 'error' : 'warning',
		actionHref: CONFIG_HREF,
		actionLabel: 'shared.deliveryReadiness.gates.mailServer.action',
		isBlocking,
	};
}

/**
 * The sending IPs of each stream the MTA carries. Every address held stops the
 * stream; some held leaves the rest carrying it. Merged into one gate when both
 * streams stand the same; no gate at all before any address is synced.
 */
function sendingIpGates(input: ReadinessInput): ReadinessGate[] {
	const byPosture = new Map<SendingIpPosture, MailStream[]>();
	for (const stream of ownMtaStreams(input)) {
		const posture = input.sendingIps?.[stream];
		if (posture == null) continue;
		byPosture.set(posture, [...(byPosture.get(posture) ?? []), stream]);
	}
	return [...byPosture].map(([posture, streams]): ReadinessGate => {
		const base = {
			key: 'sending-ips' as const,
			title: 'shared.deliveryReadiness.gates.sendingIps.title',
			detail: `shared.deliveryReadiness.gates.sendingIps.${posture}`,
			streams,
			transport: OWN_SERVER,
		};
		if (posture === 'ready') {
			return { ...base, status: 'ready', tone: 'success', actionHref: null, actionLabel: null };
		}
		const isBlocking = posture === 'all_held';
		return {
			...base,
			status: 'attention',
			tone: isBlocking ? 'error' : 'warning',
			actionHref: DELIVERABILITY_HREF,
			actionLabel: 'shared.deliveryReadiness.gates.sendingIps.action',
			isBlocking,
		};
	});
}

/**
 * Transactional: every send uses the instance default sender, and dispatch
 * refuses it unless that address is on a verified domain. Without one set, the
 * fallback placeholder is refused too.
 */
function defaultSenderGate(input: ReadinessInput): ReadinessGate | null {
	const sender = input.defaultSender;
	if (sender == null || !isStreamEnabled(input, 'transactional')) return null;
	const base = {
		key: 'default-sender' as const,
		title: 'shared.deliveryReadiness.gates.defaultSender.title',
		streams: ['transactional'] as const,
	};
	if (sender.address === null) {
		return {
			...base,
			detail: 'shared.deliveryReadiness.gates.defaultSender.missing',
			status: 'attention',
			tone: 'error',
			actionHref: SENDER_HREF,
			actionLabel: 'shared.deliveryReadiness.gates.defaultSender.actionSet',
			isBlocking: true,
		};
	}
	if (!sender.isDomainVerified) {
		return {
			...base,
			detail: {
				key: 'shared.deliveryReadiness.gates.defaultSender.unverified',
				params: { address: sender.address },
			},
			status: 'attention',
			tone: 'error',
			actionHref: SENDER_HREF,
			actionLabel: 'shared.deliveryReadiness.gates.defaultSender.actionChange',
			isBlocking: true,
		};
	}
	return {
		...base,
		detail: {
			key: 'shared.deliveryReadiness.gates.defaultSender.verified',
			params: { address: sender.address },
		},
		status: 'ready',
		tone: 'success',
		actionHref: null,
		actionLabel: null,
	};
}

/** Marketing: the checklist's one-click unsubscribe check, when the viewer may read it. */
function unsubscribeGate(input: ReadinessInput): ReadinessGate | null {
	const result = input.oneClickUnsubscribe;
	if (result == null) return null;
	const isPassing = result === 'pass';
	return {
		key: 'unsubscribe',
		title: 'shared.deliveryReadiness.gates.unsubscribe.title',
		detail: isPassing
			? 'shared.deliveryReadiness.gates.unsubscribe.pass'
			: 'shared.deliveryReadiness.gates.unsubscribe.fail',
		status: isPassing ? 'ready' : 'attention',
		tone: isPassing ? 'success' : 'warning',
		actionHref: isPassing ? null : DELIVERABILITY_HREF,
		actionLabel: isPassing ? null : 'shared.deliveryReadiness.gates.unsubscribe.action',
		streams: ['marketing'],
	};
}

/**
 * Marketing: how much the own MTA's warm-up lets out today. A capped day is the
 * warm-up working, so it reads as paced, not as a problem; only a halted
 * warm-up or a day with nothing left asks for attention. An instance that
 * sends campaigns through an external provider gets no gate.
 */
function capacityGate(input: ReadinessInput): ReadinessGate | null {
	if (!ownMtaStreams(input).includes('marketing')) return null;
	const base = {
		key: 'capacity' as const,
		title: 'shared.deliveryReadiness.gates.capacity.title',
		streams: ['marketing'] as const,
		transport: OWN_SERVER,
	};
	if (input.warmupHalted) {
		return {
			...base,
			detail: 'shared.deliveryReadiness.gates.capacity.halted',
			status: 'attention',
			tone: 'warning',
			actionHref: DELIVERABILITY_HREF,
			actionLabel: 'shared.deliveryReadiness.gates.capacity.action',
		};
	}
	const capacity = input.marketingCapacity;
	if (capacity == null) return null;
	if (!capacity.paced) {
		return {
			...base,
			detail: 'shared.deliveryReadiness.gates.capacity.unpaced',
			status: 'ready',
			tone: 'success',
			actionHref: null,
			actionLabel: null,
		};
	}
	if (capacity.today <= 0) {
		return {
			...base,
			detail: 'shared.deliveryReadiness.gates.capacity.usedUp',
			status: 'attention',
			tone: 'warning',
			actionHref: null,
			actionLabel: null,
		};
	}
	return {
		...base,
		detail: {
			key: 'shared.deliveryReadiness.gates.capacity.paced',
			params: { count: formatNumber(capacity.today) },
		},
		status: 'ready',
		tone: 'neutral',
		actionHref: null,
		actionLabel: null,
	};
}

/** Marketing: room under the complaint-rate limit mailbox providers enforce. */
function complaintsGate(input: ReadinessInput): ReadinessGate | null {
	const rate = input.complaintRate;
	if (rate == null) return null;
	const limit = REPUTATION_THRESHOLDS.complaint.medium;
	const params = { rate: formatPercentage(rate, 2), limit: formatPercentage(limit, 1) };
	const isOver = rate >= limit;
	return {
		key: 'complaints',
		title: 'shared.deliveryReadiness.gates.complaints.title',
		detail: {
			key: isOver
				? 'shared.deliveryReadiness.gates.complaints.over'
				: 'shared.deliveryReadiness.gates.complaints.under',
			params,
		},
		status: isOver ? 'attention' : 'ready',
		tone: isOver ? 'warning' : 'success',
		actionHref: isOver ? '/dashboard/audience/suppressions' : null,
		actionLabel: isOver ? 'shared.deliveryReadiness.gates.complaints.action' : null,
		streams: ['marketing'],
	};
}

/**
 * The outbound-alignment gate — surfaced only when the active transport is
 * misaligned for a configured sending domain. A warning (not a hard block): the
 * instance can still send, but that mail can be treated as spam because the
 * address it's from and the way the transport signs/bounces it disagree. The fix
 * is a transport-config change, so it links to the transport editor.
 */
function alignmentGate(input: ReadinessInput): ReadinessGate {
	const domains = input.misalignedDomains ?? [];
	// `alignmentReason` is the backend's own per-transport sentence, already in
	// words — it rides through as itself, the way every server-authored line does.
	const detail: LocalizedText =
		input.alignmentReason ??
		(domains.length > 0
			? {
					key: 'shared.deliveryReadiness.gates.alignment.misalignedDomains',
					params: { domains: domains.join(', ') },
				}
			: 'shared.deliveryReadiness.gates.alignment.misaligned');
	return {
		key: 'alignment',
		title: 'shared.deliveryReadiness.gates.alignment.title',
		detail,
		status: 'attention',
		tone: 'warning',
		actionHref: CONFIG_HREF,
		actionLabel: 'shared.deliveryReadiness.gates.alignment.action',
	};
}

/**
 * The MTA-STS gate — surfaced only when `enforce` is published without the
 * record verified. A warning (not a hard block): the instance can still send;
 * the risk is on the INBOUND side, where senders honouring the policy may bounce
 * mail until the record + served policy are live.
 */
function mtaStsGate(): ReadinessGate {
	return {
		key: 'mta-sts',
		title: 'shared.deliveryReadiness.gates.mtaSts.title',
		detail: 'shared.deliveryReadiness.gates.mtaSts.detail',
		status: 'attention',
		tone: 'warning',
		actionHref: DOMAINS_HREF,
		actionLabel: 'shared.deliveryReadiness.gates.mtaSts.action',
	};
}

const LEVEL_TONE: Record<ReadinessLevel, HealthTone> = {
	ready: 'success',
	incomplete: 'warning',
	blocked: 'error',
};

const LEVEL_HEADLINE: Record<ReadinessLevel, LocalizedText> = {
	ready: 'shared.deliveryReadiness.headline.ready',
	incomplete: 'shared.deliveryReadiness.headline.incomplete',
	blocked: 'shared.deliveryReadiness.headline.blocked',
};

const STREAM_TONE: Record<StreamLevel, HealthTone> = {
	ready: 'success',
	attention: 'warning',
	blocked: 'error',
};

const STREAM_TO_LEVEL: Record<StreamLevel, ReadinessLevel> = {
	ready: 'ready',
	attention: 'incomplete',
	blocked: 'blocked',
};

function appliesTo(gate: ReadinessGate, stream: MailStream): boolean {
	return gate.streams === undefined || gate.streams.includes(stream);
}

/**
 * The verdict for one stream, from the gates that apply to it. An open blocking
 * gate blocks it; any other gate in `attention` asks for attention. The
 * dual-transport gate is advisory: what it gates is the ramp, not the send
 * path, so it never feeds a verdict.
 */
function streamVerdict(gates: readonly ReadinessGate[], stream: MailStream): StreamVerdict {
	const own = gates.filter((gate) => appliesTo(gate, stream) && gate.key !== 'dual-arm-alignment');
	const blocking = own.find((gate) => gate.isBlocking === true && gate.status !== 'ready');
	const attention = own.find((gate) => gate.status === 'attention');
	const open = blocking ?? attention;
	const level: StreamLevel = blocking ? 'blocked' : attention ? 'attention' : 'ready';
	// The transport gate's label is a provider name, never a catalog key.
	const transport = own.find((gate) => gate.key === 'transport')?.transport;
	const paced = own.find((gate) => gate.key === 'capacity' && gate.tone === 'neutral');
	const readySentence: LocalizedText =
		paced?.detail ??
		(typeof transport === 'string'
			? {
					key: `shared.deliveryReadiness.streams.${stream}.readyVia`,
					params: { transport },
				}
			: `shared.deliveryReadiness.streams.${stream}.ready`);
	return {
		stream,
		level,
		tone: STREAM_TONE[level],
		label: `shared.deliveryReadiness.streams.level.${level}`,
		sentence: open ? open.detail : readySentence,
		actionHref: open?.actionHref ?? null,
		actionLabel: open?.actionLabel ?? null,
	};
}

function present<T>(value: T | null): value is T {
	return value !== null;
}

/**
 * Derive the readiness verdicts: one per enabled stream, and the worst of them
 * as the panel's single level.
 *
 * `canSend` is the honest instance-wide gate — a transport AND a verified
 * sending domain. Email authentication is a deliverability gate, not a hard
 * block: with a transport and a verified domain the instance CAN send, but until
 * SPF/DKIM are in place that mail is at risk, which is the `attention` state.
 */
export function deriveDeliveryReadiness(input: ReadinessInput): DeliveryReadiness {
	const gates: ReadinessGate[] = [
		...transportGates(input),
		mailServerGate(input),
		...sendingIpGates(input),
		domainGate(input),
		authenticationGate(input),
		defaultSenderGate(input),
	].filter(present);
	if (isStreamEnabled(input, 'marketing')) {
		gates.push(
			...[
				dmarcGate(input),
				unsubscribeGate(input),
				capacityGate(input),
				complaintsGate(input),
			].filter(present)
		);
	}
	// The alignment gate is conditional: only a transport that's definitely
	// misaligned for a configured sending domain adds it, so the built-in MTA and
	// a correctly-configured relay see the same gates as before.
	if (input.transportMisaligned) {
		gates.push(alignmentGate(input));
	}
	// The MTA-STS gate is conditional: only publishing `enforce` without the
	// record verified adds it, so a deployment that publishes nothing sees the
	// same gates as before.
	if (input.mtaStsEnforceWithoutRecord) {
		gates.push(mtaStsGate());
	}
	// The dual-transport alignment gate is conditional AND advisory: it appears
	// only when a reference transport is really in play, and it deliberately does
	// NOT feed any verdict below — what it gates is the ramp, not the send path,
	// so it can never turn a ready instance into an unfinished one.
	if (input.dualArmAlignment !== undefined) {
		gates.push(dualArmAlignmentGate(input.dualArmAlignment));
	}

	const streams = STREAMS.filter((stream) => isStreamEnabled(input, stream)).map((stream) =>
		streamVerdict(gates, stream)
	);
	const canSend = input.transportConfigured && input.domainVerified;
	const worst = streams.some((v) => v.level === 'blocked')
		? 'blocked'
		: streams.some((v) => v.level === 'attention')
			? 'attention'
			: 'ready';
	const level = STREAM_TO_LEVEL[worst];

	// The summary names the single most important next step: the first gate that
	// isn't ready, or an all-clear line.
	const nextGate = gates.find((gate) => gate.status !== 'ready');
	const summary: LocalizedText =
		level === 'ready'
			? 'shared.deliveryReadiness.summary.ready'
			: (nextGate?.detail ?? LEVEL_HEADLINE[level]);

	return {
		canSend,
		level,
		tone: LEVEL_TONE[level],
		headline: LEVEL_HEADLINE[level],
		summary,
		gates,
		streams,
	};
}
