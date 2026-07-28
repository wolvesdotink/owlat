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

import { OWN_SHARE_CEILING } from '@owlat/shared/deliverabilityRouting';
import type { DeliverabilityCell } from '@owlat/shared/deliverabilityRouting';
import type { RampDecision, RampDecisionReason } from './controllerTypes';

/**
 * The retreats an operator must be TOLD about: something measured or something
 * infrastructural broke, and the sentence for each names the cause and the
 * remedy. Ceiling-bound pull-backs are deliberately absent — nothing failed, so
 * a notice would be an alarm with no gate to name and nothing to act on, and a
 * notice channel that cries wolf stops being read.
 */
const NOTIFIABLE_RETREAT_REASONS: ReadonlySet<RampDecisionReason> = new Set<RampDecisionReason>([
	'abuse_status',
	'breaker',
	'dnsbl',
]);

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
 * THE ADMIN NOTICE for a retreat (plan D12), or `undefined` when there is
 * nothing an operator can act on. The notice IS the decision's sentence: it
 * already names what broke and what to do about it, and a second wording could
 * only drift from the first.
 *
 * THE TRIGGER IS A NAMED CAUSE, NOT A DROP IN THE NUMBER. A cell already sitting
 * on the soft floor cannot fall any further, so a fresh breach there is a HOLD —
 * and it is precisely the incident an operator most needs to see, because a cell
 * pinned at 1% by repeated breaches still imposes a fresh freeze and still
 * advances the cooldown ladder every time. Keying the notice off `direction`
 * silenced exactly the worst case. What is deliberately NOT notifiable is a
 * ceiling-bound pull-back: nothing failed, there is no gate to name and nothing
 * to act on, and a notice channel that cries wolf stops being read.
 */
export function rampDecisionAdminNotice(
	cell: DeliverabilityCell,
	decision: RampDecision
): string | undefined {
	const isNamed =
		decision.failedGate !== undefined || NOTIFIABLE_RETREAT_REASONS.has(decision.reason);
	return isNamed ? describeRampDecision(cell, decision) : undefined;
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
		case 'evidence_stale':
			return `Held ${where} at ${percent(decision.share)}: the gate measurements behind this decision were not a reading of the present — too old, or stamped ahead of the clock. The controller neither raises nor lowers a share on evidence it cannot date.`;
		case 'awaiting_corroboration':
			return `Held ${where} at ${percent(decision.share)}: the seed-placement tripwire fired alone. Seeds are too small a sample to act on without the deferral or bounce gate agreeing.`;
		case 'capacity_unknown':
			return `Held ${where} at ${percent(decision.share)}: the warming-capacity projection was unusable, so no ceiling could be computed. The controller does not ramp hardest when it understands least.`;
		case 'window_open':
			return `Held ${where} at ${percent(decision.share)}: this evaluation window has already been counted. The controller measures a full day before it steps up again, so the same day of data cannot be spent twice.`;
		case 'building_confidence':
			return `Held ${where} at ${percent(decision.share)}: the window was clean, but the controller requires several consecutive clean windows before it increases.`;
		// A CEILING CAN PULL A CELL DOWN, not only stop it going up — so the verb
		// comes from the DIRECTION, never from the reason. "Held ... at 8%" for a
		// 42-point retreat would make the audit trail actively misleading, and this
		// same sentence is what an operator reads in the notice.
		case 'capacity_ceiling':
			return decision.direction === 'decrease'
				? `Reduced ${where} (${move}): remaining warming capacity now bounds this cell below its current share. No gate failed; capacity grows back with the warming schedule.`
				: `Held ${where} at ${percent(decision.share)}: remaining warming capacity is what bounds this cell, not its gates. Capacity grows with the warming schedule.`;
		case 'phase_ceiling':
			return decision.direction === 'decrease'
				? `Reduced ${where} (${move}): the cell is above its phase ceiling and has been brought back to it. No gate failed — promote the phase to allow more.`
				: `Held ${where} at ${percent(decision.share)}: the cell is at its phase ceiling. Promote the phase to let it go further.`;
		case 'healthy':
			return `Increased ${where} (${move}): every gate is green and the clean streak is long enough.`;
		// A GRADUATED CELL CAN SIT BELOW FULL SHARE — the warming cap bounds a pin
		// without revoking it — so the sentence is built from the DECISION'S SHARE,
		// not from the reason alone. Telling an operator the relay is on standby
		// while it is in fact carrying 60% of the cell is the same defect the two
		// ceiling sentences above were fixed for.
		case 'graduated':
			return decision.share >= OWN_SHARE_CEILING
				? `Graduated ${where}: 100% held for 14 days with every gate green. The cell is pinned and the relay drops to standby.`
				: `Held ${where} at ${percent(decision.share)}: the cell is graduated and pinned, but remaining warming capacity bounds it below full share, so the relay still carries the rest. Capacity grows with the warming schedule.`;
		// A BREACH ON A CELL ALREADY AT THE FLOOR CANNOT LOWER IT — `max(floor, s x
		// 0.5)` is the same 1% it started at — so this verb comes from the
		// DIRECTION too, for the same reason the two ceiling arms above do. "Reduced
		// ... (1% -> 1%)" reads as a no-op sentence for what is actually a fresh
		// breach, a fresh freeze and another rung of the cooldown ladder.
		case 'hard_bounce':
		case 'deferral':
		case 'complaint':
		case 'engagement_ratio':
		case 'seed_placement': {
			const breached = `the ${decision.reason.replace(/_/g, ' ')} gate breached`;
			return decision.direction === 'decrease'
				? `Reduced ${where} (${move}): ${breached}. ${gateRemedy(decision)}`
				: `Held ${where} at the ${percent(decision.share)} floor: ${breached} again, and the share is already as low as a soft failure takes it. ${gateRemedy(decision)}`;
		}
	}
}
