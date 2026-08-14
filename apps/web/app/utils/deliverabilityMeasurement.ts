/**
 * Deliverability measurement screen — presentation only (plan D2, D5, D14).
 *
 * THE RULE: nothing in this module divides. Every rate on this screen is
 * DERIVED ON READ by the server's one summarizer (ADR-0042 / plan D5), and the
 * screen's job is to format the number it was handed and to put the right
 * sentence next to it. A percentage here is a unit conversion of a server rate,
 * never a rate computed from two counters — that is precisely how a dashboard
 * and a controller end up disagreeing about the same traffic.
 *
 * STATES ARE THE FEATURE. `insufficient_data` is not a failure, an absent
 * reference transport is not an incomplete setup, and a quiet cell is not a
 * problem. The copy below says so in words, and the tones below say so in
 * colour: nothing that is merely UNMEASURED is ever rendered in an error tone
 * (plan D2).
 *
 * TWO SPANS, AND EVERY SENTENCE SAYS WHICH ONE IT IS OVER. The server counts
 * over a WINDOW of seven days and reaches every gate verdict over the ramp
 * controller's own, shorter DECIDING span, so the two readers agree on the
 * verdict (#510). A gate sentence here reading "this window" beside a table
 * covering a different one would be the same lie the server just stopped
 * telling, so the sentences say whose window they mean and
 * `deliverabilityWindows.ts` puts each span into words for the headings.
 *
 * THE GATE COPY LIVES NEXT DOOR. Gate names, verdict tones and the sentence
 * under a verdict are `deliverabilityGateCopy.ts` — split out to keep both files
 * under the size cap. It reads the types below and nothing else from here, and
 * both are auto-imported from `~/utils`, so neither re-exports the other.
 */

import type { FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';
import { formatNumber, formatPercentage } from '~/utils/formatters';
import { transportIdLabel } from '~/utils/transportState';

export type DeliverabilityDashboard = FunctionReturnType<
	typeof api.delivery.deliverabilityDashboard.getDeliverabilityDashboard
>;
export type DeliverabilityDashboardCell = DeliverabilityDashboard['cells'][number];
export type DeliverabilityDashboardGate = DeliverabilityDashboardCell['gates'][number];
export type DeliverabilityArmSummary = DeliverabilityDashboardCell['own'];
export type DeliverabilityConfidence = DeliverabilityDashboardCell['confidence'];

/**
 * A sentence this module hands out: the catalog KEY that carries it, plus the
 * numbers it interpolates. Every table here is module scope and evaluated at
 * import time, so none of them can call `useI18n` — the screen that renders a
 * value is the boundary that turns it into words (the registry convention). A
 * plain string is a key with no parameters.
 */
export type LocalizedText = string | { key: string; params?: Record<string, unknown> };

/**
 * The headline, D14 literally: with nothing to compare against, the feature is
 * "Warm-up autopilot" (how much can I send today, and what is holding it back),
 * not a degraded "Sending independence".
 *
 * IT TAKES THE MEASUREMENT, NOT THE CONFIGURATION. Whether a comparison EXISTS
 * is what the cells below say — a two-relay deployment has no single relay to
 * name and every cell still measured against one — so a headline keyed to the
 * relay list tells such a deployment the opposite of what its own cards say.
 * Naming the relay is a separate question, answered by `referenceTransportId`.
 */
export function measurementHeadline(hasReferenceArm: boolean): LocalizedText {
	return hasReferenceArm
		? 'shared.deliverabilityMeasurement.headline.independence'
		: 'shared.deliverabilityMeasurement.headline.warmup';
}

/**
 * THE SECOND ARM IS NAMED THE WAY THE OPERATOR CHOSE IT. The reference
 * transport reaches this screen as its stored id (`ses`, `smtp`,
 * `plugin.<pack>.<id>`), which is a configuration value rather than a name —
 * `transportIdLabel` turns it back into words, with the scope and the one
 * remaining plugin-catalog gap stated there.
 *
 * THE TWO INPUTS ARE INDEPENDENT, and all four combinations are real. A
 * measured arm with no id to name is a deployment relaying through more than one
 * kind; an id with no measured arm is a relay that carried nothing this window,
 * and that reads as standalone because that is what the gates below graded it
 * as.
 */
export function measurementSubhead(input: {
	readonly hasReferenceArm: boolean;
	readonly referenceTransportId: string | null;
}): LocalizedText {
	if (!input.hasReferenceArm) return 'shared.deliverabilityMeasurement.subhead.standalone';
	// TWO SENTENCES, NOT ONE WITH A SUBJECT SLOT: the unnamed arm's phrase is copy
	// of its own, and a translator has to be able to word it inside the sentence.
	if (input.referenceTransportId === null) {
		return 'shared.deliverabilityMeasurement.subhead.relays';
	}
	return {
		key: 'shared.deliverabilityMeasurement.subhead.namedRelay',
		params: { relay: transportIdLabel(input.referenceTransportId) },
	};
}

/**
 * THE STANDALONE NOTE — shown only where no cell below measured a second arm.
 *
 * TWO KEYS IN ONE PARAGRAPH, and the split is the point. The FRAMING is a
 * measurement: whatever the deployment owns, everything below was graded against
 * our own history, so it follows the cells like the headline does. The
 * connect-a-relay OFFER is a configuration: it is advice about the deployment,
 * and nobody with a relay connected can act on it.
 *
 * Keyed together, a deployment whose relay had merely gone quiet was offered a
 * relay it already pays for three lines above the card's own line explaining
 * that its relay carried the cell earlier in this window — one screen saying the
 * relay does not exist and that it went quiet. `dashboardConfidence` splits the
 * per-cell cap from the per-cell offer on exactly this line; this is the same
 * split for the page prose that makes the same offer.
 *
 * A THIRD FACT, because the closing sentence is a PROMISE ABOUT THE CARDS: "the
 * days it did carry are still plotted" only holds where some card's trend
 * actually carries a relay day. The arm is graded over the controller's ~24h
 * span and the trend plots seven days, so those two diverge often — but they
 * also agree at zero: a graduated deployment at full own share, a relay
 * connected today, a relay enabled for a messageType outside these streams. In
 * all three this note renders with nothing plotted anywhere, and the sentence
 * would point at bars that do not exist. `hasPlottedRelayHistory` is the same
 * predicate the card guards its own line with (`point.reference !== null`),
 * asked across every cell rather than one.
 */
export function standaloneNote(input: {
	readonly isRelayConfigured: boolean;
	readonly referenceTransportId: string | null;
	readonly hasPlottedRelayHistory: boolean;
}): LocalizedText {
	if (!input.isRelayConfigured) return 'shared.deliverabilityMeasurement.standaloneNote.noRelay';
	// A configured relay with no measured arm. `null` here is the OTHER null:
	// more than one relay kind, so there is no single one to name — and the
	// subject, its pronoun and the closing promise are all one sentence per
	// combination, because a subject and a pronoun slotted into a shared frame is
	// a sentence no translator can put into another grammar.
	if (input.referenceTransportId === null) {
		return input.hasPlottedRelayHistory
			? 'shared.deliverabilityMeasurement.standaloneNote.relaysPlotted'
			: 'shared.deliverabilityMeasurement.standaloneNote.relays';
	}
	return {
		key: input.hasPlottedRelayHistory
			? 'shared.deliverabilityMeasurement.standaloneNote.namedRelayPlotted'
			: 'shared.deliverabilityMeasurement.standaloneNote.namedRelay',
		params: { relay: transportIdLabel(input.referenceTransportId) },
	};
}

const STREAM_LABELS = {
	campaign: 'shared.deliverabilityMeasurement.stream.campaign',
	automation: 'shared.deliverabilityMeasurement.stream.automation',
	transactional: 'shared.deliverabilityMeasurement.stream.transactional',
} as const;

const PROVIDER_LABELS = {
	gmail: 'shared.deliverabilityMeasurement.provider.gmail',
	microsoft: 'shared.deliverabilityMeasurement.provider.microsoft',
	yahoo: 'shared.deliverabilityMeasurement.provider.yahoo',
	apple: 'shared.deliverabilityMeasurement.provider.apple',
	other: 'shared.deliverabilityMeasurement.provider.other',
} as const;

export function streamLabel(stream: DeliverabilityDashboardCell['cell']['stream']): LocalizedText {
	return STREAM_LABELS[stream];
}

export function providerLabel(
	provider: DeliverabilityDashboardCell['cell']['destinationProvider']
): LocalizedText {
	return PROVIDER_LABELS[provider];
}

/**
 * THE CELL'S NAME AS ONE MESSAGE, not two names either side of an arrow.
 *
 * A cell's name is a catalog entry per (stream, provider) pair rather than a
 * frame with two slots, because a slot could only be filled with the OTHER
 * entries' keys — and a key interpolated into a sentence renders as itself. The
 * pair is closed and exhaustive on both axes, so every combination has a name.
 */
export function cellLabel(cell: DeliverabilityDashboardCell['cell']): LocalizedText {
	return `shared.deliverabilityMeasurement.cell.${cell.stream}.${cell.destinationProvider}`;
}

// ============ CONFIDENCE (D14) ============

export function confidenceLabel(level: DeliverabilityConfidence['level']): LocalizedText {
	switch (level) {
		case 'none':
			return 'shared.deliverabilityMeasurement.confidence.none';
		case 'low':
			return 'shared.deliverabilityMeasurement.confidence.low';
		case 'medium':
			return 'shared.deliverabilityMeasurement.confidence.medium';
		case 'high':
			return 'shared.deliverabilityMeasurement.confidence.high';
	}
}

/**
 * What would make this cell's measurement better, as an INVITATION. Never a
 * warning, never a nag: the absence of a relay or of seed mailboxes is a
 * supported configuration (plan D2).
 */
export function improvementCopy(
	improvement: DeliverabilityConfidence['improvements'][number]
): LocalizedText {
	switch (improvement) {
		case 'connect_reference_transport':
			return 'shared.deliverabilityMeasurement.improvement.connectReferenceTransport';
		case 'add_seed_mailboxes':
			return 'shared.deliverabilityMeasurement.improvement.addSeedMailboxes';
		case 'send_more_volume':
			return 'shared.deliverabilityMeasurement.improvement.sendMoreVolume';
	}
}

// ============ ARM COMPARISON ============

export interface ArmMetricRow {
	readonly key: string;
	readonly label: LocalizedText;
	/** Absolute count, formatted. */
	readonly ownCount: string;
	readonly referenceCount: string | null;
	/** Server-derived rate, formatted — never computed here. */
	readonly ownRate: string | null;
	readonly referenceRate: string | null;
}

interface MetricSpec {
	readonly key: string;
	readonly label: LocalizedText;
	readonly count: (summary: DeliverabilityArmSummary) => number;
	readonly rate?: (summary: DeliverabilityArmSummary) => number;
}

/**
 * The comparison table's rows. Each one names the COUNTER it prints and, where
 * the server derived one, the RATE field it prints — both read straight off the
 * summary. There is no arithmetic in this table.
 */
const METRIC_SPECS: readonly MetricSpec[] = [
	{ key: 'sent', label: 'shared.deliverabilityMeasurement.metric.sent', count: (s) => s.sent },
	{
		key: 'delivered',
		label: 'shared.deliverabilityMeasurement.metric.delivered',
		count: (s) => s.delivered,
		rate: (s) => s.deliveryRate,
	},
	{
		key: 'hardBounced',
		label: 'shared.deliverabilityMeasurement.metric.hardBounced',
		count: (s) => s.hardBounced,
		rate: (s) => s.hardBounceRate,
	},
	{
		key: 'softBounced',
		label: 'shared.deliverabilityMeasurement.metric.softBounced',
		count: (s) => s.softBounced,
	},
	{
		key: 'complained',
		label: 'shared.deliverabilityMeasurement.metric.complained',
		count: (s) => s.complained,
		rate: (s) => s.complaintRate,
	},
	{
		key: 'opened',
		label: 'shared.deliverabilityMeasurement.metric.opened',
		count: (s) => s.opened,
		rate: (s) => s.openRate,
	},
	{
		key: 'clicked',
		label: 'shared.deliverabilityMeasurement.metric.clicked',
		count: (s) => s.clicked,
		rate: (s) => s.clickRate,
	},
	{
		key: 'unsubscribed',
		label: 'shared.deliverabilityMeasurement.metric.unsubscribed',
		count: (s) => s.unsubscribed,
		rate: (s) => s.unsubscribeRate,
	},
];

export function armMetricRows(
	own: DeliverabilityArmSummary,
	reference: DeliverabilityArmSummary | null
): ArmMetricRow[] {
	return METRIC_SPECS.map((spec) => ({
		key: spec.key,
		label: spec.label,
		ownCount: formatNumber(spec.count(own)),
		referenceCount: reference === null ? null : formatNumber(spec.count(reference)),
		ownRate: spec.rate === undefined ? null : formatPercentage(spec.rate(own), 2),
		referenceRate:
			spec.rate === undefined || reference === null
				? null
				: formatPercentage(spec.rate(reference), 2),
	}));
}

/** A cell nobody has sent through this window — empty, and calm about it. */
export function isZeroVolume(cell: DeliverabilityDashboardCell): boolean {
	return cell.own.sent === 0 && (cell.reference === null || cell.reference.sent === 0);
}

/** Share of the cell the own server carries, as a display string (D1). */
export function ownShareLabel(cell: DeliverabilityDashboardCell): string {
	return formatPercentage(cell.ownShare, 0);
}
