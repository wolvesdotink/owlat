import { summarizeOutboundAlignment } from '@owlat/shared';
import { sendingIpPosture, type SendingIpPosture } from '@owlat/shared/ipReadiness';
import { buildReadinessGates, enabledReadinessStreams } from '~/utils/deliveryReadinessGates';
import type {
	DeliveryReadiness,
	MailServerState,
	MarketingCapacity,
	ReadinessAlignmentSource,
	ReadinessDomainRow,
	ReadinessInput,
	ReadinessLevel,
	ReadinessMtaStsSource,
	ReadinessStreamSources,
	ReadinessTransportSummary,
	StreamLevel,
	StreamTransportFacts,
	StreamVerdict,
} from '~/utils/deliveryReadinessTypes';
import {
	summarizeDualArmAlignment,
	type ReadinessDualArmRow,
	type ReadinessDualArmSummary,
} from '~/utils/dualArmAlignment';
import type { HealthTone } from '~/utils/healthTone';
import type { LocalizedText } from '~/utils/localizedText';
import type {
	MailStream,
	ReadinessGate,
	ReadinessGateKey,
	ReadinessGateStatus,
} from '~/utils/readinessGate';

export type { ReadinessDualArmRow, ReadinessDualArmSummary };
export type { MailStream, ReadinessGate, ReadinessGateKey, ReadinessGateStatus };
export type { SendingIpPosture };
export type {
	DeliveryReadiness,
	MailServerState,
	MarketingCapacity,
	ReadinessAlignmentSource,
	ReadinessDomainRow,
	ReadinessInput,
	ReadinessLevel,
	ReadinessMtaStsSource,
	ReadinessStreamSources,
	ReadinessTransportSummary,
	StreamLevel,
	StreamTransportFacts,
	StreamVerdict,
};

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
	const pools = sources.warming?.pools ?? null;
	const capacity = sources.sendingReadiness;
	return {
		streamTransport,
		streamsEnabled: sources.enabled ?? {},
		mailServer: sources.mailServer,
		sendingIps: {
			transactional: streamTransport.transactional.usesOwnMta
				? sendingIpPosture(ips, 'transactional', pools)
				: null,
			marketing: streamTransport.marketing.usesOwnMta
				? sendingIpPosture(ips, 'campaign', pools)
				: null,
		},
		warmupHalted: streamTransport.marketing.usesOwnMta && sources.warming?.phase === 'plateau',
		transactionalSender: sources.transactionalSender,
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
	const gates = buildReadinessGates(input);

	const streams = enabledReadinessStreams(input).map((stream) => streamVerdict(gates, stream));
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
