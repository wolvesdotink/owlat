/**
 * Tier-2 connected-hook consumption.
 *
 * The Deliverability Lab is a Tier-1 bundled plugin that MAY consult an external
 * seedbox vendor for a second-opinion spam score. That vendor answer arrives
 * over Owlat's signed synchronous `score` hook (PP-24): the HOST signs the
 * request, verifies the response signature, enforces the deadline, and hands
 * this plugin a value — so the plugin never touches HMAC or the network itself.
 * Everything the vendor returns is nonetheless UNTRUSTED, so this module:
 *
 *   1. strictly validates the response into a bounded `{ score, reason? }`
 *      (mirroring the host's `score` hook schema: a finite number in [0,1]) and
 *      fails closed to `null` on anything malformed;
 *   2. bounds the wait with a deadline and, on timeout / rejection / an invalid
 *      response / cancellation, FALLS BACK to the in-process engine's own score.
 *
 * A `score` hook is advisory (it fails OPEN to "no score"), so the fallback here
 * is the LOCAL deterministic score — never a silent "clean". The gate consumes
 * this only to ADD caution; it can never let a remote answer weaken a verdict.
 */

import { analyzeEmail, normalizeSpamScore } from './engine';
import type { DeliverabilityEmail } from './engine';
import { clampUntrustedText } from './untrustedText';

/** Largest reason string kept from an untrusted score-hook response. */
export const SCORE_HOOK_REASON_MAX_LENGTH = 200;

/** A validated `score` hook result: a bounded [0,1] score and optional reason. */
export interface ScoreHookResult {
	readonly score: number;
	readonly reason?: string;
}

/**
 * The injected seedbox client. It returns the vendor's UNTRUSTED JSON answer (or
 * rejects / never settles). Owlat's host provides the real implementation over
 * the signed hook; tests provide a fake. It receives the abort signal so a
 * host-cancelled gate cancels the vendor call too.
 */
export type RemoteScoreHook = (email: DeliverabilityEmail, signal: AbortSignal) => Promise<unknown>;

/** Where a delivered score came from — used by the gate for an honest reason line. */
export type ScoreSource = 'remote' | 'fallback';

export interface DeliverabilityScore {
	readonly score: number;
	readonly source: ScoreSource;
	readonly reason?: string;
}

/**
 * Strictly validate an untrusted score-hook response. Accepts ONLY a plain object
 * with a finite numeric `score` in [0,1] and, optionally, a string `reason`.
 * Anything else — wrong type, out-of-range, NaN, array, prototype-polluted — is
 * rejected as `null` so the caller fails closed to the local fallback.
 */
export function parseScoreHookResult(value: unknown): ScoreHookResult | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return null;

	const scoreDescriptor = Object.getOwnPropertyDescriptor(value, 'score');
	if (!scoreDescriptor || !('value' in scoreDescriptor)) return null;
	const score = scoreDescriptor.value;
	if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) return null;

	const reasonDescriptor = Object.getOwnPropertyDescriptor(value, 'reason');
	if (reasonDescriptor && 'value' in reasonDescriptor) {
		const reason = reasonDescriptor.value;
		if (typeof reason !== 'string') return null;
		const clamped = clampUntrustedText(reason, SCORE_HOOK_REASON_MAX_LENGTH);
		return clamped.length > 0 ? { score, reason: clamped } : { score };
	}
	return { score };
}

/** The local deterministic fallback score, derived from the in-process engine. */
export function localFallbackScore(email: DeliverabilityEmail): DeliverabilityScore {
	const report = analyzeEmail(email);
	return { score: normalizeSpamScore(report.spam.score), source: 'fallback' };
}

export interface ScoreDeliverabilityOptions {
	readonly hook?: RemoteScoreHook;
	/** Wall-clock budget for the vendor call before the local fallback is used. */
	readonly deadlineMs: number;
	/** Host cancellation; when already aborted the fallback is used immediately. */
	readonly signal: AbortSignal;
	/** Injectable timer for deterministic tests (defaults to setTimeout/clearTimeout). */
	readonly setTimer?: (callback: () => void, ms: number) => unknown;
	readonly clearTimer?: (handle: unknown) => void;
}

const TIMED_OUT = Symbol('deliverability-score-timeout');

/**
 * Deliver a deliverability score, preferring the Tier-2 vendor hook but ALWAYS
 * degrading to the local engine on timeout, rejection, an invalid response, a
 * missing hook, or cancellation. Never throws: the gate can rely on getting a
 * usable number and a truthful `source`.
 */
export async function scoreDeliverability(
	email: DeliverabilityEmail,
	options: ScoreDeliverabilityOptions
): Promise<DeliverabilityScore> {
	if (!options.hook || options.signal.aborted) {
		return localFallbackScore(email);
	}

	const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
	const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));

	let timer: unknown;
	const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimer(() => resolve(TIMED_OUT), Math.max(0, options.deadlineMs));
	});

	try {
		const raced = await Promise.race([
			options.hook(email, options.signal).then(
				(value) => ({ ok: true as const, value }),
				() => ({ ok: false as const, value: undefined })
			),
			deadline,
		]);

		if (raced === TIMED_OUT || !raced.ok) {
			return localFallbackScore(email);
		}
		const parsed = parseScoreHookResult(raced.value);
		if (!parsed) return localFallbackScore(email);
		return parsed.reason
			? { score: parsed.score, source: 'remote', reason: parsed.reason }
			: { score: parsed.score, source: 'remote' };
	} finally {
		clearTimer(timer);
	}
}
