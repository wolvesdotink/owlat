/**
 * How a suspension lifts, for readers outside the web app: `GET /api/v1/status`,
 * the transactional `403 abuse_blocked` and the assistant. The decision is
 * `analytics/reputationResume.ts`'s `describeSuspensionLift`, the one the
 * delivery hub banner renders; this module only reshapes it into the public
 * contract (percent, ISO 8601) and words it in English for the 403's message.
 *
 * The manual-lift hold is left out on purpose: the banner shows it to no
 * member, only the operator console to platform admins.
 *
 * No reads: the callers load the lift (`analytics/reputationEvidence.ts`).
 */

import type { SendingHoldLift } from '@owlat/public-contract';
import type { SuspensionLift } from '../analytics/reputationResume';

/** A ratio (0–1) as a percentage to three decimals, as the status's rates are. */
export function ratioToPct(ratio: number): number {
	return Math.round(ratio * 100_000) / 1000;
}

export function publicSendingHoldLift(lift: SuspensionLift): SendingHoldLift {
	if (lift.mode !== 'automatic') return { mode: lift.mode, condition: null };
	return {
		mode: 'automatic',
		condition: {
			trigger: lift.code,
			domain: lift.domain ?? null,
			currentPct: lift.current === null ? null : ratioToPct(lift.current),
			limitPct: ratioToPct(lift.limit),
			isClear: lift.isClear,
			clearsAt: lift.clearsAt === null ? null : new Date(lift.clearsAt).toISOString(),
		},
	};
}

/** "0.2%", "5%": a percentage with the digits it has. */
function pct(value: number): string {
	return `${Number(value.toFixed(3))}%`;
}

/** One English sentence saying whether, and on what condition, a suspension lifts by itself. */
export function sendingHoldLiftSentence(lift: SendingHoldLift): string {
	if (lift.mode === 'admin') return 'It does not lift by itself.';
	if (lift.mode === 'manual_setting') {
		return 'It does not lift by itself: this instance waits for a platform admin to lift it, even after the rates recover.';
	}
	const condition = lift.condition;
	if (!condition) return 'It lifts by itself once the rate behind it is back under the line.';
	if (condition.isClear) {
		return 'The rate behind it is back under the line, so it lifts by itself at the next hourly check.';
	}
	if (condition.trigger === 'gmail_spam_rate') {
		const leaves = condition.clearsAt
			? `; the last reading over it leaves the window on ${condition.clearsAt.slice(0, 10)}`
			: '';
		return `It lifts by itself once no Gmail spam rate for ${condition.domain ?? 'the domain'} in the last 30 days is at or above ${pct(condition.limitPct)}${leaves}.`;
	}
	const metric = condition.trigger === 'bounce_rate' ? 'bounce rate' : 'complaint rate';
	const now = condition.currentPct === null ? '' : `; it is ${pct(condition.currentPct)} now`;
	return `It lifts by itself once the ${metric} over the last 30 days is under ${pct(condition.limitPct)}${now}.`;
}
