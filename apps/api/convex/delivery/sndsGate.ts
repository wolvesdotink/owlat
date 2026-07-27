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
	/**
	 * Whether the read hit its row cap, so the window is a SUBSET of the stored
	 * days. A truncated window may still show a breach — that is real evidence —
	 * but it can never be evidence of cleanliness, so it forces `confidence: low`
	 * and disqualifies the cell from promotion.
	 */
	truncated: boolean;
	/**
	 * Whether every folded row is known to describe an address THIS deployment
	 * declares (`MTA_IP_POOLS`). An SNDS key is issued per REGISTERED RANGE, so a
	 * feed legitimately names addresses belonging to other senders in the range.
	 * With no declared pool a clean band cannot be attributed to us, and evidence
	 * we cannot attribute must never be able to justify an increase.
	 */
	attributed: boolean;
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
	/** The caller's read hit its row cap, so these are only the newest days. */
	truncated?: boolean;
	/**
	 * The caller scoped the read to addresses this deployment declares. Defaults
	 * to `true` for a caller that has already filtered; the stored-row reader
	 * passes `false` when no pool is declared and the rows therefore describe
	 * whatever the SNDS key's registered range happens to cover.
	 */
	attributed?: boolean;
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
	// banded nothing tells us nothing, however many rows it contains. A truncated
	// read is the same argument from the other end — we did not see every day —
	// and an unattributed read is the third: we saw days, but not necessarily
	// OURS. All three keep the gate working; they only forbid it from promoting.
	const truncated = args.truncated === true;
	const attributed = args.attributed !== false;
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
			truncated,
			attributed,
			confidence: banded && days.size >= 2 && !truncated && attributed ? 'high' : 'low',
		},
	};
}

export interface SndsGateThresholds {
	/**
	 * The first band that counts as a breach. Bands are compared, never rates.
	 *
	 * `unknown` is excluded BY TYPE: it has no severity, so a thresholds object
	 * naming it would turn the complaint gate off entirely and answer `pass`
	 * forever. A gate that cannot breach is not a state worth representing.
	 */
	breachBand: Exclude<SndsComplaintBand, 'unknown'>;
	/** Trap hits tolerated in the window before the gate breaches. */
	trapHitLimit: number;
}

/**
 * DERIVATION: the plan fixes no SNDS-specific band, so this constant is the
 * plan's own complaint gate expressed in Microsoft's vocabulary. That gate
 * breaches at a 0.1 % complaint rate, and the first SNDS band at or above
 * 0.1 % is `0_1_to_0_2` — so `lt_0_1` is the only passing band and the gate
 * agrees with the complaint gate it sits beside instead of quietly running
 * three times looser. A yellow filter result is a warning rather than a breach:
 * it moves often and on its own it would make the ramp chatter, so `red` is the
 * only breaching filter result.
 *
 * DERIVATION for `trapHitLimit: 0`: the plan fixes no SNDS trap constant either,
 * and D17's "a provider-wide collapse is SUSPECT and needs corroboration before
 * acting" does not apply here, because an SNDS trap hit is not an inference from
 * a small sample. It is Microsoft stating that a specific IP we declare, on a
 * specific UTC day, delivered to an address Microsoft operates as a trap — a
 * direct, attributed observation with no sampling error to corroborate away.
 * That is the one signal the plan's own guardrails treat as unambiguous, so the
 * tolerated count is zero and the AIMD decrease is the correct response.
 */
export const DEFAULT_SNDS_GATE_THRESHOLDS: SndsGateThresholds = {
	breachBand: '0_1_to_0_2',
	trapHitLimit: 0,
};

export type SndsGateFailure = 'complaint_band' | 'filter_result' | 'spam_traps';

/**
 * The gate's verdict, in the controller's shared vocabulary
 * (`pass` / `fail` / `insufficient_data`) so P3's controller consumes this gate
 * through the one gate interface with no per-gate shim.
 */
export type SndsGateVerdict =
	| { verdict: 'pass'; reason: string }
	| { verdict: 'fail'; reason: string; failedGate: SndsGateFailure }
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
			verdict: 'fail',
			failedGate: 'spam_traps',
			reason: `Microsoft recorded ${signal.trapHits} spam-trap hit(s) in the last ${signal.windowDays} days.`,
		};
	}
	if (signal.worstFilterResult === 'red') {
		return {
			verdict: 'fail',
			failedGate: 'filter_result',
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
	// `breachBand` excludes `unknown`, so its severity is a number by type.
	const breachSeverity = complaintBandSeverity(thresholds.breachBand);
	if (severity >= breachSeverity) {
		return {
			verdict: 'fail',
			failedGate: 'complaint_band',
			// The BAND is named, never a percentage: SNDS never published one.
			reason: `Microsoft's complaint band for at least one sending IP is ${signal.worstComplaintBand}, at or above ${thresholds.breachBand}.`,
		};
	}
	return {
		verdict: 'pass',
		reason: `Microsoft's worst complaint band over the last ${signal.windowDays} days is ${signal.worstComplaintBand}.`,
	};
}

/**
 * The plan's s >= 0.5 promotion criterion for the Microsoft cell: "SNDS
 * complaint band green for the relevant cell, within the last 7 days".
 *
 * PROMOTION IS STRICTLY STRONGER THAN `pass`. `pass` is "nothing broke" and is
 * satisfied by `insufficient_data` holding steady; promotion is "we have
 * POSITIVE evidence", so it demands an actually-banded green window that the
 * read saw in full. Exported as a pure predicate beside the gate so P2/P3
 * consume the criterion rather than re-deriving it from the raw signal — two
 * derivations of one rule is exactly how the controller and the dashboard end
 * up disagreeing about a number.
 */
export function sndsPromotionPass(
	input: SndsGateInput,
	thresholds: SndsGateThresholds = DEFAULT_SNDS_GATE_THRESHOLDS
): boolean {
	// Absent data never promotes. It also never demotes — that is `evaluateSndsGate`'s
	// `insufficient_data`, and D2 keeps the ramp moving on the substituted signal.
	if (!input.available) return false;
	const { signal } = input;
	// Unattributed evidence is stated separately from `confidence` on purpose:
	// it is the one disqualifier that says "this band may be someone else's".
	if (signal.confidence !== 'high' || signal.truncated || !signal.attributed) return false;
	if (evaluateSndsGate(input, thresholds).verdict !== 'pass') return false;
	// Banded, and strictly below the first breaching band.
	const severity = complaintBandSeverity(signal.worstComplaintBand);
	if (severity === null) return false;
	return (
		severity < complaintBandSeverity(thresholds.breachBand) && signal.worstFilterResult !== 'red'
	);
}
