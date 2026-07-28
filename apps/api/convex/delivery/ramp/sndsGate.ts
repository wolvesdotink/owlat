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
} from '../sndsFeed';
import type { RampGateId, RampGateStatus } from './gateTypes';

/**
 * The substitution the Microsoft cell applies when SNDS data is unavailable.
 *
 * Its shape is a table ENTRY, not an if-branch: the degraded path is expressed
 * as data so the controller substitutes rather than special-cases (D3).
 *
 * IT DELIBERATELY SPELLS ITS FIELDS THE WAY `./yahooComplaintSignal` DOES.
 * Both are entries in the ONE P3-8 substitution table — "which signal is gate 3
 * actually running on for this destination-provider cell" — so `source`,
 * `confidence`, `confidenceNote` and `isBlocking` mean the same thing in both
 * and P3-8 can subsume them without reconciling two vocabularies. Only
 * `dwellMultiplier` and `ceilingPhaseDelta` are particular to this cell: they
 * are how the Microsoft substitution pays for its weaker evidence.
 */
export const SNDS_ABSENT_SUBSTITUTION = {
	/** What replaces the SNDS band while it is missing. */
	source: 'smtp_classification',
	/** Dwell longer before advancing, because the evidence is weaker. */
	dwellMultiplier: 2,
	/** Cap the cell one phase below what the evidence would otherwise allow. */
	ceilingPhaseDelta: -1,
	/** Surfaced verbatim in the UI (D14) — an honest weak signal, said out loud. */
	confidence: 'low',
	/**
	 * The confidence sentence shown on the cell, with ONE home (D14). A UI that
	 * had to compose this itself would be a second definition of the same fact,
	 * free to drift — the same reason `yahooComplaintSubstitution` returns its
	 * note on every branch.
	 */
	confidenceNote:
		'Measurement confidence: low — Microsoft SNDS is not connected, so the Microsoft cell reads Microsoft’s SMTP reply text instead. Connecting SNDS would measure this IP’s complaint band directly.',
	/**
	 * Always `false`. Encoded as a field rather than left implicit so the D2
	 * invariant is asserted by a test rather than assumed by a reader.
	 */
	isBlocking: false,
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
	truncated: boolean;
	/**
	 * The caller scoped the read to addresses this deployment declares. `false`
	 * when no pool is declared and the rows therefore describe whatever the SNDS
	 * key's registered range happens to cover.
	 */
	attributed: boolean;
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
	// REQUIRED, not defaulted: both are promotion-critical disqualifiers, and a
	// caller that forgot one would silently produce a high-confidence, promotable
	// signal. A fail-open default on a promotion gate is the wrong default.
	const { truncated, attributed } = args;
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

/**
 * WHICH SNDS SIGNAL BROKE — a sub-axis of ONE gate, never a fourth gate id.
 *
 * The plan's gate table has exactly one complaint gate, and `RampGateId` names
 * it `complaint`. SNDS is a per-cell INPUT to that gate, not a parallel one, so
 * a breach here is always reported as `gate: 'complaint'` (that is the id the
 * audit row and the admin notification key off, per D12) with this value
 * attached as the detail that makes the sentence actionable: "the band", "the
 * filter result" and "a trap hit" are three different things for an operator to
 * do something about, and collapsing them would throw that away.
 */
export type SndsGateFailureSignal = 'complaint_band' | 'filter_result' | 'spam_traps';

/**
 * The one gate id every SNDS breach reports under (see `SndsGateFailureSignal`).
 * Written as an `Extract` so the day `RampGateId` renames `complaint`, this
 * stops compiling rather than drifting.
 */
export const SNDS_GATE_ID: Extract<RampGateId, 'complaint'> = 'complaint';

/**
 * Appended to every verdict derived from a window we could not attribute.
 *
 * An SNDS key is issued per REGISTERED RANGE, so without a declared pool the
 * window folds rows for every address in that range — including a neighbour's.
 * D12 asks that every decision carry a reason the operator can act on, and D14
 * asks us to say the quiet part: the caveat names the limit AND the remedy.
 */
export const UNATTRIBUTED_CAVEAT =
	"This covers every address in the SNDS key's registered range, not only ours — declare MTA_IP_POOLS to attribute it to your own addresses.";

/**
 * The gate's verdict.
 *
 * ITS RELATIONSHIP TO THE SHIPPED `RampGateResult`, STATED EXACTLY — because
 * "shared vocabulary" is true of one half of it and false of the other:
 *
 *  - THE STATUS LITERALS ARE SHARED. Each variant's discriminant is `Extract`ed
 *    from `RampGateStatus`, so the two unions cannot drift: a rename there is a
 *    compile error here. `halt` is `Exclude`d DELIBERATELY — only the deferral
 *    gate hard-stops, and an SNDS band never should (D9's hard stops are
 *    infrastructure, not third-party bands).
 *  - THE MEASUREMENT SHAPE IS NOT SHARED, and cannot be. `RampGateMeasurement`
 *    is rate-shaped (`thresholdRate` / `ownRate` / `referenceRate`), and SNDS
 *    publishes a BAND. Filling those fields would mean inventing the percentage
 *    the feed refuses to publish, which is the one thing this module exists to
 *    avoid. So this gate hands back the band's own vocabulary instead, and the
 *    controller consumes it as a per-cell input to the `complaint` gate rather
 *    than as a `RampGateResult` of its own.
 */
export type SndsGateVerdict =
	| { verdict: Extract<RampGateStatus, 'pass'>; reason: string }
	| {
			verdict: Extract<RampGateStatus, 'fail'>;
			reason: string;
			/** Always `complaint`: SNDS is an input to that gate, not a gate of its own. */
			gate: typeof SNDS_GATE_ID;
			failedSignal: SndsGateFailureSignal;
	  }
	| {
			verdict: Extract<RampGateStatus, 'insufficient_data'>;
			reason: string;
			substitution: SndsSubstitution;
	  };

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
	// D12/D14: an operator reading "Microsoft recorded 3 spam-trap hits" deserves
	// to know whether those hits are even ours. Every verdict derived from an
	// unattributed window says so, and says what to do about it.
	const caveat = signal.attributed ? '' : ` ${UNATTRIBUTED_CAVEAT}`;
	// `breachBand` excludes `unknown`, so its severity is a number by type.
	const breachSeverity = complaintBandSeverity(thresholds.breachBand);
	const severity = complaintBandSeverity(signal.worstComplaintBand);
	const bandBreached = severity !== null && severity >= breachSeverity;
	const filterBreached = signal.worstFilterResult === 'red';

	if (signal.trapHits > thresholds.trapHitLimit) {
		const traps = `Microsoft recorded ${signal.trapHits} spam-trap hit(s) in the last ${signal.windowDays} days.`;
		if (!signal.attributed && !bandBreached && !filterBreached) {
			// The trap count is the ONLY breaching evidence and it may belong to a
			// neighbouring sender in the same registered range. Unattributable
			// evidence must not move the share in either direction (D10 holds).
			return {
				verdict: 'insufficient_data',
				reason: `${traps}${caveat}`,
				substitution: SNDS_ABSENT_SUBSTITUTION,
			};
		}
		return {
			verdict: 'fail',
			gate: SNDS_GATE_ID,
			failedSignal: 'spam_traps',
			reason: `${traps}${caveat}`,
		};
	}
	if (filterBreached) {
		return {
			verdict: 'fail',
			gate: SNDS_GATE_ID,
			failedSignal: 'filter_result',
			reason: `Microsoft's SNDS filter result for at least one sending IP is ${signal.worstFilterResult}.${caveat}`,
		};
	}

	if (severity === null) {
		return {
			verdict: 'insufficient_data',
			reason: `Microsoft reported no complaint band for the last ${signal.windowDays} days (too little volume to band).`,
			substitution: SNDS_ABSENT_SUBSTITUTION,
		};
	}
	if (bandBreached) {
		return {
			verdict: 'fail',
			gate: SNDS_GATE_ID,
			failedSignal: 'complaint_band',
			// The BAND is named, never a percentage: SNDS never published one.
			reason: `Microsoft's complaint band for at least one sending IP is ${signal.worstComplaintBand}, at or above ${thresholds.breachBand}.${caveat}`,
		};
	}
	const passSentence = `Microsoft's worst complaint band over the last ${signal.windowDays} days is ${signal.worstComplaintBand}.`;
	if (!signal.attributed) {
		// THE UP DIRECTION IS THE ONE THAT NEEDS ATTRIBUTION. `pass` is not a
		// neutral verdict: `aggregateRampGates` grows `cleanStreak` on it, and D9
		// increases the share after K_CLEAN clean windows — so a clean band from a
		// neighbouring sender in the same registered range would buy us an increase
		// we have no evidence for. Symmetric with the trap-hit branch above, and
		// D10-correct: `insufficient_data` HOLDS — no increase, and no decrease
		// either. The DOWN direction is untouched, because every breaching branch
		// returns before this point whether or not the window is attributed.
		return {
			verdict: 'insufficient_data',
			reason: `${passSentence}${caveat}`,
			substitution: SNDS_ABSENT_SUBSTITUTION,
		};
	}
	return { verdict: 'pass', reason: passSentence };
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
	// `evaluateSndsGate` now refuses to answer `pass` on an unattributed window
	// too, so this line is no longer the ONLY place the rule is enforced — it
	// stays because promotion states its own preconditions rather than inferring
	// them from another function's current implementation.
	if (signal.confidence !== 'high' || signal.truncated || !signal.attributed) return false;
	// `pass` already implies the trap count is within limit, the filter result is
	// not red and the band is banded and strictly below the breach band — so
	// re-deriving any of that here would be a second derivation of one rule.
	return evaluateSndsGate(input, thresholds).verdict === 'pass';
}
