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
import { measurementHeadline } from '~/utils/deliverabilityMeasurement';
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
 * standalone feature is CALLED, which is the one thing D14 cares about. So this
 * is an alias, not a copy — the SUBHEAD below is genuinely different prose (that
 * screen is read-only; this one is the ramp) and stays local.
 */
export const independenceHeadline = measurementHeadline;

/**
 * THE RELAY IS NAMED, NOT KEYED. `referenceTransportId` is the stored transport
 * id, and "instead of ses" reads as a configuration value leaking onto the
 * screen people screenshot. `transportIdLabel` names the built-in kinds from the
 * same map the transport card and the DNS guidance use; a PLUGIN relay is named
 * from its id's leaf here and from the plugin catalog on the card, so those two
 * can still word one relay differently until this query carries the catalog
 * label.
 */
export function independenceSubhead(referenceTransportId: string | null): string {
	return referenceTransportId === null
		? 'How much your own server can send today, and what is holding that number back. There is no relay to move away from — this is the whole feature, not a reduced one.'
		: `How much of your mail your own server now carries instead of ${transportIdLabel(referenceTransportId)}.`;
}

/** The month-to-date own-arm volume sentence — always available, always true. */
export function volumeSentence(summary: IndependenceSummary): string {
	return `${formatNumber(summary.monthToDateOwnSends)} messages sent from your own server this month.`;
}

/**
 * Format a minor-unit amount in its own currency.
 *
 * The exponent comes from `Intl.NumberFormat`, which knows that JPY has none and
 * that KWD has three. An unknown or malformed code makes `Intl` throw; that must
 * never take a screen down over a settings typo, so the fallback prints the code
 * beside the raw amount and remains readable.
 */
function formatCurrencyFromMinorUnits(minorUnits: number, currency: string): string {
	try {
		const format = new Intl.NumberFormat('en-US', { style: 'currency', currency });
		const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
		return format.format(minorUnits / 10 ** digits);
	} catch {
		return `${currency} ${formatNumber(minorUnits)} (minor units)`;
	}
}

/**
 * THE MONEY, OR AN HONEST ABSENCE. A relay price the product invented would be
 * quoted back at us as fact, so when nobody has recorded one the screen says
 * what it would take to show the figure rather than printing a confident guess.
 */
export function spendAvoidedCopy(summary: IndependenceSummary): string {
	if (summary.spendAvoidedMinorUnits === null || summary.spendAvoidedCurrency === null) {
		return 'Add what your relay charges per thousand messages to see the spend this replaces.';
	}
	// MINOR UNITS ARE NOT ALWAYS HUNDREDTHS. JPY has no minor unit at all and
	// KWD/BHD have three digits, so the exponent is read off the CURRENCY through
	// `Intl` rather than assumed to be 100 — a hardcoded divisor would misstate a
	// yen figure by two orders of magnitude on the screen people screenshot.
	const currency = summary.spendAvoidedCurrency;
	const minor = summary.spendAvoidedMinorUnits;
	return `${formatCurrencyFromMinorUnits(minor, currency)} of relay spend avoided this month.`;
}

/**
 * The projected date the relay stops carrying mail — one sentence per arm of the
 * closed union, because the four non-answers mean genuinely different things and
 * a single "unknown" would tell a standalone deployment nothing at all.
 */
export function projectionCopy(projection: IndependenceProjection): string {
	switch (projection.kind) {
		case 'projected':
			return `On the current pace you stop paying a relay around ${formatShortDate(projection.at)} — about ${projection.dailyGainPp.toFixed(2)} points of share gained per day.`;
		case 'already_independent':
			return 'Your own server already carries this traffic. There is no relay bill left to end.';
		case 'not_advancing':
			return 'The share is not climbing at the moment, so there is no honest date to give. It will appear once the ramp starts advancing again.';
		case 'beyond_horizon':
			return 'At the current pace the finish line is more than two years out, which is too far to quote. A faster preset or more volume would bring it closer.';
		case 'insufficient_data':
			return `Not enough history yet — ${formatNumber(projection.usableDays)} of ${formatNumber(INDEPENDENCE_PROJECTION_MIN_DAYS)} days with traffic. Keep sending and the date will appear.`;
	}
}

/** The standalone headline: what the deployment can send today. */
export function capacityCopy(summary: IndependenceSummary): string {
	const remaining = summary.capacity.remainingToday;
	if (remaining === null) {
		return 'No warming ceiling is being reported right now, so there is no daily number to show. Your sending is unaffected.';
	}
	return `${formatNumber(remaining)} more messages can go out from your own server today.`;
}
