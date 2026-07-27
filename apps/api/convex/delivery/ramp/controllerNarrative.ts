/**
 * The controller's decisions, in sentences (plan D12).
 *
 * THE KPI IS 100%: every controller decision must carry a recorded,
 * human-readable reason. A controller that silently retreats will be
 * experienced as a bug, so "why did my share halve overnight" has to be
 * answerable from the audit row alone — without reading this repository.
 *
 * Pure and total: a `RampDecisionReason` is a closed union and the switch is
 * exhaustive, so a new reason cannot ship without a sentence to go with it.
 */

import type { DeliverabilityCell } from '@owlat/shared/deliverabilityRouting';
import type { RampDecision } from './controllerTypes';

function percent(share: number): string {
	return `${Math.round(share * 1000) / 10}%`;
}

/** What the operator should DO about a breached gate, per gate. */
function gateRemedy(decision: RampDecision): string {
	switch (decision.failedGate) {
		case 'hard_bounce':
			return 'Clean the list: hard bounces are addresses that do not exist, and they cost reputation on every send.';
		case 'deferral':
			return 'The receiver is throttling us. Check the pool IPs for a blocklist listing and let the warming schedule catch up.';
		case 'complaint':
			return 'Recipients are marking this stream as spam. Review the audience, the sending frequency and the unsubscribe path.';
		case 'engagement_ratio':
			return 'Mail through our own IP is engaging measurably worse than the reference arm — usually placement, sometimes a content change.';
		case 'seed_placement':
			return 'Seed mailboxes moved from inbox to spam or went missing. Corroborate against the deferral and bounce gates before acting.';
		default:
			return 'Review the delivery dashboard for the failing measurement.';
	}
}

/**
 * One sentence, in the operator's terms. Cell first, then what happened, then
 * what to do about it when there is anything to do.
 */
export function describeRampDecision(cell: DeliverabilityCell, decision: RampDecision): string {
	const where = `${cell.stream} mail to ${cell.destinationProvider}`;
	const move = `${percent(decision.fromShare)} -> ${percent(decision.share)}`;

	switch (decision.reason) {
		case 'kill_switch':
			return `Ramp paused: ${where} is pinned at ${percent(decision.share)} by the global kill switch. No cell moves while the controller is paused.`;
		case 'clock_unusable':
			return `Held ${where} at ${percent(decision.share)}: the evaluation clock was unusable, and the controller never decides against a broken clock.`;
		case 'abuse_status':
			return `Stopped ${where} (${move}): the organization's abuse status forbids sending. Resolve the account status first; nothing else the controller measures matters until then.`;
		case 'breaker':
			return `Halved ${where} (${move}): the MTA circuit breaker is open for this provider. Frozen for 6h while the breaker recovers.`;
		case 'dnsbl':
			return `Stopped ${where} (${move}): a pool IP carries a critical blocklist listing. Frozen for 24h — start the delisting flow from the Delivery checklist.`;
		case 'frozen':
			return `Held ${where} at ${percent(decision.share)}: an earlier decision froze this cell and the cooldown has not expired.`;
		case 'share_unreadable':
			return `Held ${where} at ${percent(decision.share)}: the stored share was not a usable value and has been read back inside [0, 1]. The controller does not add to a number it cannot read.`;
		case 'holding':
			return `Held ${where} at ${percent(decision.share)}: not enough fresh evidence to decide. The controller never increases on thin data, and never decreases on it either.`;
		case 'awaiting_corroboration':
			return `Held ${where} at ${percent(decision.share)}: the seed-placement tripwire fired alone. Seeds are too small a sample to act on without the deferral or bounce gate agreeing.`;
		case 'capacity_unknown':
			return `Held ${where} at ${percent(decision.share)}: the warming-capacity projection was unusable, so no ceiling could be computed. The controller does not ramp hardest when it understands least.`;
		case 'building_confidence':
			return `Held ${where} at ${percent(decision.share)}: the window was clean, but the controller requires several consecutive clean windows before it increases.`;
		case 'capacity_ceiling':
			return `Held ${where} at ${percent(decision.share)}: remaining warming capacity is what bounds this cell, not its gates. Capacity grows with the warming schedule.`;
		case 'phase_ceiling':
			return `Held ${where} at ${percent(decision.share)}: the cell is at its phase ceiling. Promote the phase to let it go further.`;
		case 'healthy':
			return `Increased ${where} (${move}): every gate is green and the clean streak is long enough.`;
		case 'graduated':
			return `Graduated ${where}: 100% held for 14 days with every gate green. The cell is pinned and the relay drops to standby.`;
		case 'hard_bounce':
		case 'deferral':
		case 'complaint':
		case 'engagement_ratio':
		case 'seed_placement':
			return `Reduced ${where} (${move}): the ${decision.reason.replace(/_/g, ' ')} gate breached. ${gateRemedy(decision)}`;
	}
}
