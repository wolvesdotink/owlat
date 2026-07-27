/**
 * Intraday pacing — the PURE decision core for spreading a day's warming cap
 * across the UTC day instead of emptying it in the first ten minutes.
 *
 * A burst that exactly hits the daily cap looks very different to a receiver
 * than a smooth curve, even though both respect the same cap. This module
 * shapes WHEN the cap may be consumed; it never raises or lowers the cap the
 * shipped warming schedule enforces.
 *
 * Three constraints the shape has to respect:
 *  - a LOW-VOLUME send must not be stretched (a 50-recipient campaign must not
 *    take 24 hours), so a floor of immediately-available capacity always
 *    applies;
 *  - TRANSACTIONAL traffic is never paced and never starved — the bulk curve
 *    converges to the cap minus a safety headroom that only transactional
 *    traffic may use;
 *  - the functions are pure (clock and counters are parameters) so the shape is
 *    exhaustively testable.
 */

import type { IpPoolType } from '../types.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const INTRADAY_PACING_POLICY = Object.freeze({
	/** Share of the daily cap reserved for transactional traffic (D9). */
	transactionalHeadroomFraction: 0.2,
	/** Share of the bulk ceiling available immediately at the start of the day. */
	initialBurstFraction: 0.1,
	/**
	 * Floor on the bulk CEILING. A day-1 cap of 50 is left entirely to whoever
	 * asks for it: carving a transactional reserve out of a cap that small would
	 * cripple both pools.
	 */
	minimumBulkCeiling: 100,
	/**
	 * Floor on the bulk ALLOWANCE at any instant. This is what keeps a small
	 * campaign from being stretched: the first `immediateAllowanceFloor` bulk
	 * sends of a UTC day are never paced.
	 */
	immediateAllowanceFloor: 100,
	minimumPacingRetryDelayMs: 60_000,
	/** Longest a paced bulk attempt waits before it is re-evaluated. */
	maximumPacingRetryDelayMs: 900_000,
});

export type IntradayPacingReason =
	| 'uncapped'
	| 'transactional_exempt'
	| 'small_volume'
	| 'within_pace'
	| 'paced';

export interface IntradayPacingInput {
	/** The authoritative per-IP daily cap (`Infinity` once graduated). */
	readonly dailyCap: number;
	/**
	 * BULK-pool sends recorded for this IP today. It must NOT be the per-IP
	 * total: transactional volume shares the daily cap but is exempt from
	 * pacing, and counting it here would let a burst of transactional mail
	 * defer a 50-recipient campaign.
	 */
	readonly bulkSentToday: number;
	/** Fraction of the UTC day already elapsed, in [0, 1]. */
	readonly dayElapsedFraction: number;
	readonly pool: IpPoolType;
}

export interface IntradayPacingVerdict {
	readonly allowed: boolean;
	/** Sends the pool may have consumed by now (`Infinity` when unpaced). */
	readonly allowance: number;
	/** The pool's ceiling for the whole day (`Infinity` when unpaced). */
	readonly ceiling: number;
	readonly retryAfterMs: number;
	readonly reason: IntradayPacingReason;
}

/** Fraction of the current UTC day already elapsed, clamped to [0, 1]. */
export function utcDayElapsedFraction(nowMs: number): number {
	if (!Number.isFinite(nowMs)) return 0;
	const sinceMidnight = ((nowMs % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
	return clampFraction(sinceMidnight / MS_PER_DAY);
}

function clampFraction(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return value >= 1 ? 1 : value;
}

/**
 * The bulk pool's ceiling for the day: the per-IP cap minus the transactional
 * safety headroom, but never below the small-volume floor (a day-1 cap of 50
 * is left entirely to whoever asks for it — reserving headroom out of it would
 * cripple both pools).
 */
export function bulkDailyCeiling(dailyCap: number): number {
	if (!Number.isFinite(dailyCap)) return Infinity;
	const headroom = Math.ceil(dailyCap * INTRADAY_PACING_POLICY.transactionalHeadroomFraction);
	return Math.min(
		dailyCap,
		Math.max(INTRADAY_PACING_POLICY.minimumBulkCeiling, dailyCap - headroom)
	);
}

/** Sends the bulk pool may have consumed by `elapsedFraction` of the UTC day. */
export function pacedAllowance(ceiling: number, elapsedFraction: number): number {
	if (!Number.isFinite(ceiling)) return Infinity;
	const burst = INTRADAY_PACING_POLICY.initialBurstFraction;
	const curve = burst + (1 - burst) * clampFraction(elapsedFraction);
	return Math.min(
		ceiling,
		Math.max(INTRADAY_PACING_POLICY.immediateAllowanceFloor, Math.ceil(ceiling * curve))
	);
}

/**
 * Milliseconds until the paced curve has room for one more send beyond
 * `sentToday`, clamped to the policy's retry window.
 */
function retryAfterForPace(ceiling: number, sentToday: number, elapsedFraction: number): number {
	// Guarded here rather than relying on a caller invariant three frames up: a
	// zero or non-finite ceiling has no curve to wait for, so wait the maximum.
	if (!(ceiling > 0) || !Number.isFinite(ceiling)) {
		return INTRADAY_PACING_POLICY.maximumPacingRetryDelayMs;
	}
	const burst = INTRADAY_PACING_POLICY.initialBurstFraction;
	const targetCurve = (sentToday + 1) / ceiling;
	const targetFraction = (targetCurve - burst) / (1 - burst);
	if (!Number.isFinite(targetFraction) || targetFraction > 1) {
		return INTRADAY_PACING_POLICY.maximumPacingRetryDelayMs;
	}
	const deltaMs = (targetFraction - clampFraction(elapsedFraction)) * MS_PER_DAY;
	return Math.min(
		INTRADAY_PACING_POLICY.maximumPacingRetryDelayMs,
		Math.max(INTRADAY_PACING_POLICY.minimumPacingRetryDelayMs, Math.ceil(deltaMs))
	);
}

/**
 * Decide whether one more send of `input.pool` may go out right now.
 *
 * Degenerate input (a graduated `Infinity` cap, a `NaN` counter, a clock-skewed
 * elapsed fraction) resolves permissively: pacing is a smoothing device, and
 * failing it closed would stall delivery for a signal that carries no safety
 * meaning of its own. The authoritative per-IP cap still bounds every send.
 */
export function evaluateIntradayPacing(input: IntradayPacingInput): IntradayPacingVerdict {
	const unpaced: IntradayPacingVerdict = {
		allowed: true,
		allowance: Infinity,
		ceiling: Infinity,
		retryAfterMs: 0,
		reason: input.pool === 'transactional' ? 'transactional_exempt' : 'uncapped',
	};
	if (input.pool === 'transactional') return unpaced;
	if (!Number.isFinite(input.dailyCap) || input.dailyCap <= 0) return unpaced;

	const sentToday =
		Number.isFinite(input.bulkSentToday) && input.bulkSentToday > 0
			? Math.floor(input.bulkSentToday)
			: 0;
	const elapsedFraction = clampFraction(input.dayElapsedFraction);
	const ceiling = bulkDailyCeiling(input.dailyCap);
	const allowance = pacedAllowance(ceiling, elapsedFraction);

	if (sentToday < allowance) {
		return {
			allowed: true,
			allowance,
			ceiling,
			retryAfterMs: 0,
			reason: ceiling <= INTRADAY_PACING_POLICY.minimumBulkCeiling ? 'small_volume' : 'within_pace',
		};
	}

	return {
		allowed: false,
		allowance,
		ceiling,
		retryAfterMs: retryAfterForPace(ceiling, sentToday, elapsedFraction),
		reason: 'paced',
	};
}
