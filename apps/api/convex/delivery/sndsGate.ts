/**
 * The Microsoft cell's external-reputation gate input, derived from SNDS.
 *
 * PURE (D15): observations in, a verdict and a reason out. No clock, no
 * database, no env — the cron shell loads and the controller decides.
 *
 * TWO RULES SHAPE EVERYTHING HERE:
 *
 * 1. THE BAND IS THE SIGNAL (Primitive Obsession). SNDS publishes a complaint
 *    BAND, so the gate consumes the band. Nothing in this module converts a
 *    band to a percentage, and nothing downstream should: `0.1% - < 0.2%` is
 *    not `0.0015`, and a fabricated rate would flow into a controller that
 *    compares numbers.
 *
 * 2. ABSENCE IS A SUPPORTED CONFIGURATION (D2). An operator who never enrolled
 *    in SNDS gets `available: false` plus the documented SUBSTITUTION — the
 *    Microsoft cell falls back to SMTP reply classification (Microsoft is
 *    unusually explicit in its 5xx text), dwells twice as long and caps one
 *    phase lower. That is slower, never blocked: no error, no warning, no nag.
 */

import {
	complaintBandSeverity,
	worseComplaintBand,
	worseFilterResult,
	type SndsComplaintBand,
	type SndsFilterResult,
} from './sndsFeed';

/**
 * The substitution the Microsoft cell applies when SNDS data is unavailable.
 *
 * Its shape is a table ENTRY, not an if-branch: the degraded path is expressed
 * as data so the controller substitutes rather than special-cases (D3).
 */
export const SNDS_ABSENT_SUBSTITUTION = {
	/** What replaces the SNDS band while it is missing. */
	signalSource: 'smtp_classification',
	/** Dwell longer before advancing, because the evidence is weaker. */
	dwellMultiplier: 2,
	/** Cap the cell one phase below what the evidence would otherwise allow. */
	ceilingPhaseDelta: -1,
	/** Surfaced verbatim in the UI (D14) — an honest weak signal, said out loud. */
	confidence: 'low',
} as const;

export type SndsSubstitution = typeof SNDS_ABSENT_SUBSTITUTION;

/** One stored (IP, UTC day) row, projected to what the gate reads. */
export interface SndsGateObservation {
	ip: string;
	periodStart: number;
	complaintBand: SndsComplaintBand;
	filterResult: SndsFilterResult;
	trapHits: number;
}

export interface SndsGateSignal {
	windowDays: number;
	observedIps: number;
	observedDays: number;
	/** The worst band across the window — `unknown` when no day carried one. */
	worstComplaintBand: SndsComplaintBand;
	worstFilterResult: SndsFilterResult;
	trapHits: number;
	confidence: 'high' | 'low';
}

export type SndsGateInput =
	| { available: true; signal: SndsGateSignal }
	| { available: false; reason: 'not_enrolled' | 'no_data'; substitution: SndsSubstitution };

/**
 * Fold the window's rows into one gate input.
 *
 * `enrolled: false` short-circuits: an operator with no feed configured is not
 * "missing data", they are running a supported standalone configuration.
 */
export function buildSndsGateInput(args: {
	enrolled: boolean;
	windowDays: number;
	observations: readonly SndsGateObservation[];
}): SndsGateInput {
	if (!args.enrolled) {
		return { available: false, reason: 'not_enrolled', substitution: SNDS_ABSENT_SUBSTITUTION };
	}
	if (args.observations.length === 0) {
		return { available: false, reason: 'no_data', substitution: SNDS_ABSENT_SUBSTITUTION };
	}

	const ips = new Set<string>();
	const days = new Set<number>();
	let worstComplaintBand: SndsComplaintBand = 'unknown';
	let worstFilterResult: SndsFilterResult = 'unknown';
	let trapHits = 0;
	for (const observation of args.observations) {
		ips.add(observation.ip);
		days.add(observation.periodStart);
		worstComplaintBand = worseComplaintBand(worstComplaintBand, observation.complaintBand);
		worstFilterResult = worseFilterResult(worstFilterResult, observation.filterResult);
		trapHits += Number.isFinite(observation.trapHits) ? Math.max(0, observation.trapHits) : 0;
	}

	// Confidence is about EVIDENCE, not about volume: a window in which Microsoft
	// banded nothing tells us nothing, however many rows it contains.
	const banded = complaintBandSeverity(worstComplaintBand) !== null;
	return {
		available: true,
		signal: {
			windowDays: args.windowDays,
			observedIps: ips.size,
			observedDays: days.size,
			worstComplaintBand,
			worstFilterResult,
			trapHits,
			confidence: banded && days.size >= 2 ? 'high' : 'low',
		},
	};
}

export interface SndsGateThresholds {
	/** The first band that counts as a breach. Bands are compared, never rates. */
	breachBand: SndsComplaintBand;
	/** Trap hits tolerated in the window before the gate breaches. */
	trapHitLimit: number;
	/** `red` always breaches; `yellow` only when this is true. */
	breachOnYellow: boolean;
}

/**
 * Microsoft treats complaint rates above roughly three tenths of a percent as
 * a problem, so `0_3_to_0_4` is the first breaching band. A yellow filter
 * result is a warning rather than a breach: it moves often and on its own it
 * would make the ramp chatter.
 */
export const DEFAULT_SNDS_GATE_THRESHOLDS: SndsGateThresholds = {
	breachBand: '0_3_to_0_4',
	trapHitLimit: 0,
	breachOnYellow: false,
};

export type SndsGateFailure = 'complaint_band' | 'filter_result' | 'spam_traps';

export type SndsGateVerdict =
	| { verdict: 'pass'; reason: string }
	| { verdict: 'breach'; reason: string; failedSignal: SndsGateFailure }
	| { verdict: 'insufficient_data'; reason: string; substitution: SndsSubstitution };

/**
 * Evaluate gate 3 for the Microsoft cell.
 *
 * `insufficient_data` HOLDS (D10): it never advances the ramp and it never
 * retreats it either. Only a banded breach moves the share down.
 */
export function evaluateSndsGate(
	input: SndsGateInput,
	thresholds: SndsGateThresholds = DEFAULT_SNDS_GATE_THRESHOLDS
): SndsGateVerdict {
	if (!input.available) {
		return {
			verdict: 'insufficient_data',
			reason:
				input.reason === 'not_enrolled'
					? 'Microsoft SNDS is not connected — the Microsoft cell is using SMTP reply classification instead.'
					: 'Microsoft SNDS is connected but has reported nothing for this window yet.',
			substitution: input.substitution,
		};
	}

	const { signal } = input;
	if (signal.trapHits > thresholds.trapHitLimit) {
		return {
			verdict: 'breach',
			failedSignal: 'spam_traps',
			reason: `Microsoft recorded ${signal.trapHits} spam-trap hit(s) in the last ${signal.windowDays} days.`,
		};
	}
	if (
		signal.worstFilterResult === 'red' ||
		(thresholds.breachOnYellow && signal.worstFilterResult === 'yellow')
	) {
		return {
			verdict: 'breach',
			failedSignal: 'filter_result',
			reason: `Microsoft's SNDS filter result for at least one sending IP is ${signal.worstFilterResult}.`,
		};
	}

	const severity = complaintBandSeverity(signal.worstComplaintBand);
	if (severity === null) {
		return {
			verdict: 'insufficient_data',
			reason: `Microsoft reported no complaint band for the last ${signal.windowDays} days (too little volume to band).`,
			substitution: SNDS_ABSENT_SUBSTITUTION,
		};
	}
	const breachSeverity = complaintBandSeverity(thresholds.breachBand);
	if (breachSeverity !== null && severity >= breachSeverity) {
		return {
			verdict: 'breach',
			failedSignal: 'complaint_band',
			// The BAND is named, never a percentage: SNDS never published one.
			reason: `Microsoft's complaint band for at least one sending IP is ${signal.worstComplaintBand}, at or above ${thresholds.breachBand}.`,
		};
	}
	return {
		verdict: 'pass',
		reason: `Microsoft's worst complaint band over the last ${signal.windowDays} days is ${signal.worstComplaintBand}.`,
	};
}
