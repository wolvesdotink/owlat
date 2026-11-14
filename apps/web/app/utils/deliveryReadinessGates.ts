/**
 * The gates of the delivery readiness verdict: one producer per thing that has
 * to be in place before a stream can send, and the order the panel lists them
 * in. `deliveryReadiness.ts` folds the list into the verdicts.
 *
 * Pure: plain data in, plain data out.
 */

import { REPUTATION_THRESHOLDS } from '@owlat/shared/reputation';
import type { ReadinessInput, StreamTransportFacts } from '~/utils/deliveryReadinessTypes';
import {
	capacityGate,
	isReadinessStreamEnabled,
	mailServerGate,
	READINESS_DELIVERABILITY_HREF,
	READINESS_STREAMS,
	READINESS_TRANSPORT_HREF,
	sendingIpGates,
} from '~/utils/deliveryReadinessMtaGates';
import { dualArmAlignmentGate } from '~/utils/dualArmAlignment';
import { formatPercentage } from '~/utils/formatters';
import type { LocalizedText } from '~/utils/localizedText';
import type { MailStream, ReadinessGate } from '~/utils/readinessGate';

const DOMAINS_HREF = '/dashboard/admin/delivery/domains';
const SENDER_HREF = '/dashboard/admin/instance/general';

/** The transport label of one stream ("Amazon SES + Owlat MTA"), or `null`. */
function transportLabel(facts: StreamTransportFacts | undefined): string | null {
	return facts && facts.providerLabels.length > 0 ? facts.providerLabels.join(' + ') : null;
}

/**
 * The transport gates. Without stream facts there is one, read off the overall
 * `canSend`. With them, each stream gets the gate its own message type's send
 * path applies, merged into one when both streams agree on transport and state.
 */
function transportGates(input: ReadinessInput): ReadinessGate[] {
	const facts = input.streamTransport;
	if (!facts) return [transportGate(input)];
	const streams = READINESS_STREAMS.filter((stream) => isReadinessStreamEnabled(input, stream));
	if (streams.length === 0) return [transportGate(input)];
	const [first, second] = streams;
	if (
		first !== undefined &&
		second !== undefined &&
		facts[first].canSend === facts[second].canSend &&
		transportLabel(facts[first]) === transportLabel(facts[second]) &&
		!hasMissingFeedback(facts[first]) &&
		!hasMissingFeedback(facts[second])
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
			? feedbackGateFields(stream, facts[stream])
			: { detail: `shared.deliveryReadiness.gates.transport.missingFor.${stream}` }),
		streams: [stream],
		transport: transportLabel(facts[stream]),
	}));
}

function hasMissingFeedback(facts: StreamTransportFacts): boolean {
	return (facts.feedbackMissing?.length ?? 0) > 0;
}

/**
 * A transport that sends but cannot receive bounce and complaint reports: its
 * webhook key is unset, so the verifier rejects every report and nothing is
 * ever suppressed. Campaigns are refused in that state (bulk mail to addresses
 * that bounced is what gets a sender blocklisted), so it blocks marketing;
 * transactional mail keeps flowing and is only warned about.
 */
function feedbackGateFields(
	stream: MailStream,
	facts: StreamTransportFacts
): Partial<ReadinessGate> {
	if (!hasMissingFeedback(facts)) return {};
	const isMarketing = stream === 'marketing';
	return {
		detail: {
			key: `shared.deliveryReadiness.gates.transport.feedbackMissing.${stream}`,
			params: { variables: (facts.feedbackMissing ?? []).join(', ') },
		},
		status: 'attention',
		tone: isMarketing ? 'error' : 'warning',
		actionHref: READINESS_TRANSPORT_HREF,
		actionLabel: 'shared.deliveryReadiness.gates.transport.actionFeedback',
		isBlocking: isMarketing,
	};
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
		actionHref: READINESS_TRANSPORT_HREF,
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
 * Transactional: every send uses the instance default sender, and dispatch
 * refuses it unless that address is on a verified domain. Without one set, the
 * fallback placeholder is refused too.
 */
function defaultSenderGate(input: ReadinessInput): ReadinessGate | null {
	const sender = input.defaultSender;
	if (sender == null || !isReadinessStreamEnabled(input, 'transactional')) return null;
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
		actionHref: isPassing ? null : READINESS_DELIVERABILITY_HREF,
		actionLabel: isPassing ? null : 'shared.deliveryReadiness.gates.unsubscribe.action',
		streams: ['marketing'],
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
		actionHref: READINESS_TRANSPORT_HREF,
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

function present<T>(value: T | null): value is T {
	return value !== null;
}

/** The streams a verdict is given for, transactional first. */
export function enabledReadinessStreams(input: ReadinessInput): MailStream[] {
	return READINESS_STREAMS.filter((stream) => isReadinessStreamEnabled(input, stream));
}

/** Every gate that applies to this instance, in the order the panel lists them. */
export function buildReadinessGates(input: ReadinessInput): ReadinessGate[] {
	const gates: ReadinessGate[] = [
		...transportGates(input),
		mailServerGate(input),
		...sendingIpGates(input),
		domainGate(input),
		authenticationGate(input),
		defaultSenderGate(input),
	].filter(present);
	if (isReadinessStreamEnabled(input, 'marketing')) {
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
	return gates;
}
