/**
 * THE INDEPENDENCE SCREEN'S COPY (plan D14) — presentation only.
 *
 * The half of the ramp vocabulary that speaks about the DEPLOYMENT rather than
 * about a cell: the headline, the money, the projected date the relay stops
 * carrying mail, and — where there is no relay — today's capacity instead.
 * `deliverabilityRamp.ts` keeps the per-cell half; the two are split because the
 * screens are, and because one file grown past the size gate is a file nobody
 * reads to the end.
 *
 * WITH NO RELAY THERE IS NOTHING TO BECOME INDEPENDENT OF, so none of these
 * sentences degrade: each non-answer is its own honest sentence with something
 * the operator could do, never a warning and never a "setup incomplete".
 */

import type { FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';
import {
	INDEPENDENCE_PROJECTION_MIN_DAYS,
	type IndependenceProjection,
} from '@owlat/shared/deliverabilityIndependence';
import { formatNumber, formatShortDate } from '~/utils/formatters';
import { measurementHeadline, type LocalizedText } from '~/utils/deliverabilityMeasurement';
import { transportIdLabel } from '~/utils/transportState';

export type IndependenceSummary = FunctionReturnType<
	typeof api.delivery.rampIndependence.getIndependenceSummary
>;

// ============ THE HEADLINE (D14) ============

/**
 * WITH NO RELAY THERE IS NOTHING TO BECOME INDEPENDENT OF, so the screen is not
 * a degraded "Sending independence" — it is a different, honest feature whose
 * headline is today's capacity and what is holding it back (plan D14).
 *
 * ONE FUNCTION, TWO SCREENS. The Measurement dashboard shipped this exact rename
 * first; re-deciding it here would let the two screens disagree about what the
 * standalone feature is CALLED, which is the one thing D14 cares about. So the
 * two words come from there, not from a copy — the SUBHEAD below is genuinely
 * different prose (that screen is read-only; this one is the ramp) and stays
 * local.
 *
 * THIS SCREEN'S QUESTION IS THE RELAY YOU PAY FOR, not the arm that carried
 * traffic: it projects the date that relay stops carrying mail and prices the
 * saving, so a window of outcome rows alone is not what it should answer from.
 * The measurement screen asks the other question — was this cell measured
 * against anything — and passes the other input.
 *
 * SO IT TAKES `isRelayConfigured`, NOT `referenceTransportId` (#513). The id is
 * `configuredRelayKinds().length === 1` failing, so a deployment relaying
 * through MORE THAN ONE kind reads `null` — and keying the screen to it framed
 * such a deployment as standalone, exactly as one with no relay at all. That was
 * the same substitution of a configuration answer for an existence question that
 * survived on the measurement dashboard until #502 made gate 5 decide, and worse
 * here, because `relayRemoval: 'safe'` is a GUARD the apply-transport endpoint
 * skips its confirmation phrase on. The summary now carries both readings off
 * one scan, and the id is left doing the one job it is honest at: naming.
 */
export function independenceHeadline(isRelayConfigured: boolean): LocalizedText {
	return measurementHeadline(isRelayConfigured);
}

/**
 * THE RELAY IS NAMED, NOT KEYED. Which sentence to say is
 * `isRelayConfigured`'s decision (#513); `referenceTransportId` only supplies
 * the NAME inside the relay sentence, and its `null` there is the OTHER null —
 * more than one kind connected, so no single one to name, which the plural
 * phrasing covers rather than falling back to the standalone sentence.
 *
 * `transportIdLabel` names the built-in kinds from the same map the transport
 * card and the DNS guidance use; a PLUGIN relay is named from its id's leaf here
 * and from the plugin catalog on the card, so those two can still word one relay
 * differently until this query carries the catalog label.
 */
export function independenceSubhead(input: {
	readonly isRelayConfigured: boolean;
	readonly referenceTransportId: string | null;
}): LocalizedText {
	if (!input.isRelayConfigured) {
		return 'shared.deliverabilityIndependenceCopy.subhead.standalone';
	}
	// The unnamed reading is its own sentence rather than a phrase dropped into
	// the named one: a slot filled with another catalog key would render as that
	// key, and the plural subject declines differently once the sentence is not
	// English.
	if (input.referenceTransportId === null) {
		return 'shared.deliverabilityIndependenceCopy.subhead.relays';
	}
	return {
		key: 'shared.deliverabilityIndependenceCopy.subhead.namedRelay',
		params: { relay: transportIdLabel(input.referenceTransportId) },
	};
}

/** The month-to-date own-arm volume sentence — always available, always true. */
export function volumeSentence(summary: IndependenceSummary): LocalizedText {
	return {
		key: 'shared.deliverabilityIndependenceCopy.volume',
		params: { count: formatNumber(summary.monthToDateOwnSends) },
	};
}

/**
 * Format a minor-unit amount in its own currency.
 *
 * The exponent comes from `Intl.NumberFormat`, which knows that JPY has none and
 * that KWD has three. An unknown or malformed code makes `Intl` throw; that must
 * never take a screen down over a settings typo, so the fallback prints the code
 * beside the raw amount and remains readable.
 */
function formatCurrencyFromMinorUnits(minorUnits: number, currency: string): string | null {
	try {
		const format = new Intl.NumberFormat('en-US', { style: 'currency', currency });
		const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
		return format.format(minorUnits / 10 ** digits);
	} catch {
		// `null`, not a sentence: the unformattable fallback names the currency and
		// the unit in words, which is a message of its own rather than a number.
		return null;
	}
}

/**
 * THE MONEY, OR AN HONEST ABSENCE. A relay price the product invented would be
 * quoted back at us as fact, so when nobody has recorded one the screen says
 * what it would take to show the figure rather than printing a confident guess.
 */
export function spendAvoidedCopy(summary: IndependenceSummary): LocalizedText {
	if (summary.spendAvoidedMinorUnits === null || summary.spendAvoidedCurrency === null) {
		return 'shared.deliverabilityIndependenceCopy.spendAvoided.noPrice';
	}
	// MINOR UNITS ARE NOT ALWAYS HUNDREDTHS. JPY has no minor unit at all and
	// KWD/BHD have three digits, so the exponent is read off the CURRENCY through
	// `Intl` rather than assumed to be 100 — a hardcoded divisor would misstate a
	// yen figure by two orders of magnitude on the screen people screenshot.
	const currency = summary.spendAvoidedCurrency;
	const minor = summary.spendAvoidedMinorUnits;
	const amount = formatCurrencyFromMinorUnits(minor, currency);
	if (amount === null) {
		return {
			key: 'shared.deliverabilityIndependenceCopy.spendAvoided.minorUnits',
			params: { currency, amount: formatNumber(minor) },
		};
	}
	return {
		key: 'shared.deliverabilityIndependenceCopy.spendAvoided.amount',
		params: { amount },
	};
}

/**
 * The projected date the relay stops carrying mail — one sentence per arm of the
 * closed union, because the four non-answers mean genuinely different things and
 * a single "unknown" would tell a standalone deployment nothing at all.
 */
export function projectionCopy(projection: IndependenceProjection): LocalizedText {
	switch (projection.kind) {
		case 'projected':
			return {
				key: 'shared.deliverabilityIndependenceCopy.projection.projected',
				params: {
					date: formatShortDate(projection.at),
					pointsPerDay: projection.dailyGainPp.toFixed(2),
				},
			};
		case 'already_independent':
			return 'shared.deliverabilityIndependenceCopy.projection.alreadyIndependent';
		case 'not_advancing':
			return 'shared.deliverabilityIndependenceCopy.projection.notAdvancing';
		case 'beyond_horizon':
			return 'shared.deliverabilityIndependenceCopy.projection.beyondHorizon';
		case 'insufficient_data':
			return {
				key: 'shared.deliverabilityIndependenceCopy.projection.insufficientData',
				params: {
					days: formatNumber(projection.usableDays),
					required: formatNumber(INDEPENDENCE_PROJECTION_MIN_DAYS),
				},
			};
	}
}

/** The standalone headline: what the deployment can send today. */
export function capacityCopy(summary: IndependenceSummary): LocalizedText {
	const remaining = summary.capacity.remainingToday;
	if (remaining === null) {
		return 'shared.deliverabilityIndependenceCopy.capacity.noCeiling';
	}
	return {
		key: 'shared.deliverabilityIndependenceCopy.capacity.remaining',
		params: { count: formatNumber(remaining) },
	};
}
