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
import { rampDecisionChangedState } from './controllerTypes';
import type { RampDecision, RampDecisionReason } from './controllerTypes';
import type { RampGateId } from './gateTypes';
import { RAMP_DEGRADATION_BY_INTEGRATION } from './degradationMatrix';
import type { PaceDecision, PaceDecisionReason } from './paceTypes';

/**
 * The missing integration, NAMED — the table's own operator-facing label, never
 * a second copy of it. `undefined` only when the ceiling rung produced no cap
 * source at all, in which case the sentence stays honest by generalising rather
 * than by guessing.
 */
function cappingIntegration(decision: RampDecision): string {
	const id = decision.cappedBy;
	const entry = id === undefined ? undefined : RAMP_DEGRADATION_BY_INTEGRATION.get(id);
	return entry === undefined ? 'a missing measurement integration' : entry.label;
}

function percent(share: number): string {
	return `${Math.round(share * 1000) / 10}%`;
}

/**
 * What the operator should DO about a breached gate, per gate. EXHAUSTIVE BY
 * CONSTRUCTION: a `Record<RampGateId, string>` rather than a switch with a
 * `default` arm, so a sixth gate fails to compile here instead of quietly
 * rendering a generic sentence. `describeRampDecision` indexes the same table,
 * so the gate list is written once in this file rather than twice.
 */
const RAMP_GATE_REMEDIES: Record<RampGateId, string> = {
	hard_bounce:
		'Clean the list: hard bounces are addresses that do not exist, and they cost reputation on every send.',
	deferral:
		'The receiver is throttling us. Check the pool IPs for a blocklist listing and let the warming schedule catch up.',
	complaint:
		'Recipients are marking this stream as spam. Review the audience, the sending frequency and the unsubscribe path.',
	engagement_ratio:
		'Mail through our own IP is engaging measurably worse than the reference arm — usually placement, sometimes a content change.',
	seed_placement:
		'Seed mailboxes moved from inbox to spam or went missing. Corroborate against the deferral and bounce gates before acting.',
};

/**
 * THE DECISIONS WITH A NAMED CAUSE — ONE SPELLING, one list.
 *
 * Something measured or something infrastructural broke, and the sentence for
 * each names the cause and the remedy: the three hard stops, plus every gate.
 * The gate half is taken from the keys of `RAMP_GATE_REMEDIES` rather than
 * re-typed, so a sixth gate becomes notifiable by existing — the same reason
 * that table is a `Record` instead of a switch.
 *
 * Two reasons are deliberately ABSENT and are absent STRUCTURALLY, not as a
 * consequence of some second half of a predicate. `awaiting_corroboration`
 * carries a `failedGate`, but it is the branch in which the controller has
 * decided NOT to believe the seed tripwire on its own (plan D17): nothing moved,
 * nothing froze, and the remedy sentence would be an alarm asking the operator to
 * go and find out whether there is an alarm. A ceiling-bound pull-back is absent
 * for the plainer reason that nothing failed — no gate to name, nothing to act
 * on, and a notice channel that cries wolf stops being read.
 */
const NOTIFIABLE_REASONS: ReadonlySet<RampDecisionReason> = new Set<RampDecisionReason>([
	'abuse_status',
	'breaker',
	'dnsbl',
	...(Object.keys(RAMP_GATE_REMEDIES) as RampGateId[]),
]);

/**
 * The remedy for THIS decision's breached gate. The single guard is here rather
 * than in the table: a decision can reach a gate arm without a `failedGate`
 * recorded, and a generic sentence is the right answer for that one case only.
 */
function gateRemedy(decision: RampDecision): string {
	const gate = decision.failedGate;
	if (gate === undefined) return 'Review the delivery dashboard for the failing measurement.';
	return RAMP_GATE_REMEDIES[gate];
}

/**
 * THE ADMIN NOTICE for a retreat (plan D12), or `undefined` when there is
 * nothing an operator can act on. The notice IS the decision's sentence: it
 * already names what broke and what to do about it, and a second wording could
 * only drift from the first.
 *
 * THE TRIGGER IS A NAMED CAUSE THAT ALSO CHANGED SOMETHING. Two failure modes
 * bracket this predicate and it has to miss both.
 *
 * Keying purely off `direction` silences the worst case: a cell already sitting
 * on the soft floor cannot fall any further, so a fresh breach there is a HOLD —
 * and it is precisely the incident an operator most needs to see, because a cell
 * pinned at 1% by repeated breaches still imposes a fresh freeze and still
 * advances the cooldown ladder every time.
 *
 * Keying purely off the CAUSE cries wolf: `abuse_status` and `dnsbl` sit above
 * the `frozen` rung and re-enter at share 0 on every hourly tick, so a condition
 * that persists for a day would post twenty-four identical incident notices for
 * one incident, and a notice channel that repeats itself stops being read.
 *
 * The freeze's LADDER POSITION is the exact discriminator between them, and
 * `rampDecisionChangedState` is the one spelling of it that this function and
 * the cron's audit emit share. It is set ONLY by a LADDER freeze
 * (`isLadderFreeze` in `controller.ts`) — a breached gate — which
 * is a fresh freeze and a fresh rung of the cooldown ladder every time it fires,
 * i.e. genuinely new every tick. Hard-stop freezes deliberately leave it
 * undefined, so a persistent hard stop announces itself on the tick that moved
 * the share and then goes quiet until something changes.
 *
 * That holds for all three hard stops, but only because the BREAKER rung was
 * made to hold its own retreat: an open breaker is a condition rather than an
 * event, and a rung that re-halved every hour would post an incident notice
 * every hour for one incident. It charges the retreat once per freeze window
 * (its OWN freeze window — `readActiveFreeze` in `controller.ts` reads the
 * freeze's origin, so an unrelated cooldown cannot stand in for it), and the
 * notice therefore tracks the incident rather than the condition. `abuse_status`
 * and `dnsbl` re-enter at share 0 and are silent after the tick that took the
 * cell there.
 *
 * WHICH CAUSES COUNT AS NAMED is `NOTIFIABLE_REASONS` above, and nothing else:
 * `awaiting_corroboration` and the ceiling pull-backs are excluded by not being
 * in that set rather than by a second clause here. The tripwire becomes
 * notifiable the moment a second gate agrees, at which point
 * `aggregateRampGates` names THAT gate and the retreat is a real one.
 *
 * The PIN arm of `rampDecisionChangedState` cannot widen this: `graduated` is not
 * a named cause, so a graduation is audited without ever posting an incident. A
 * hard stop that REVOKES a pin is named — and that is correct, it is the tick on
 * which a cell lost its independence.
 */
export function rampDecisionAdminNotice(
	cell: DeliverabilityCell,
	decision: RampDecision
): string | undefined {
	return NOTIFIABLE_REASONS.has(decision.reason) && rampDecisionChangedState(decision)
		? describeRampDecision(cell, decision)
		: undefined;
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
		// THE HARD STOPS REPEAT. `abuse_status` and `dnsbl` sit ABOVE the `frozen`
		// rung, so while the condition persists every hourly tick re-enters them with
		// the cell already at 0 and `fromShare === share`. A hard-coded verb would
		// render "Stopped campaign mail to gmail (0% -> 0%)" twenty-four times a day —
		// the same misleading no-op sentence the gate and ceiling arms below take
		// their verb from `direction` to avoid. So these do too.
		case 'abuse_status':
			return decision.direction === 'decrease'
				? `Stopped ${where} (${move}): the organization's abuse status forbids sending. Resolve the account status first; nothing else the controller measures matters until then.`
				: `Held ${where} at ${percent(decision.share)}: the organization's abuse status still forbids sending. Resolve the account status first; nothing else the controller measures matters until then.`;
		case 'breaker':
			return decision.direction === 'decrease'
				? `Halved ${where} (${move}): the MTA circuit breaker is open for this provider. Frozen for at least 6h while the breaker recovers.`
				: `Held ${where} at ${percent(decision.share)}: the MTA circuit breaker is still open for this provider. The retreat for this incident has already been charged, so the share holds until the breaker freeze expires.`;
		case 'dnsbl':
			return decision.direction === 'decrease'
				? `Stopped ${where} (${move}): a pool IP carries a critical blocklist listing. Frozen for at least 24h — start the delisting flow from the Delivery checklist.`
				: `Held ${where} at ${percent(decision.share)}: a pool IP still carries a critical blocklist listing. Frozen for a further 24h at least — start the delisting flow from the Delivery checklist.`;
		case 'frozen':
			return `Held ${where} at ${percent(decision.share)}: an earlier decision froze this cell and the cooldown has not expired.`;
		case 'freeze_unreadable':
			return `Held ${where} at ${percent(decision.share)}: the stored freeze expiry was further out than any cooldown this controller imposes, so it was not believed. The cell holds for this evaluation — an unreadable freeze is not a reason to step up — and the unusable value has been cleared off the cell, so the next evaluation decides on the gates again.`;
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
		// NOT "PROMOTE THE PHASE": the rung is already promoted and the controller
		// is capping it. The remedy is the missing integration, and it applies
		// itself — nothing for the operator to undo afterwards.
		case 'degradation_ceiling': {
			const capper = cappingIntegration(decision);
			return decision.direction === 'decrease'
				? `Reduced ${where} (${move}): ${capper} is not reporting, which caps this cell one phase below its promoted rung, and it was above that cap. No gate failed — the cap lifts by itself once that integration reports again.`
				: `Held ${where} at ${percent(decision.share)}: ${capper} is not reporting, which caps this cell one phase below its promoted rung. The cap lifts by itself once that integration reports again.`;
		}
		case 'healthy':
			return `Increased ${where} (${move}): every gate is green and the clean streak is long enough.`;
		// A GRADUATED CELL CAN SIT BELOW FULL SHARE — the warming cap bounds a pin
		// without revoking it — so the sentence is built from the DECISION'S SHARE,
		// not from the reason alone. Telling an operator the relay is on standby
		// while it is in fact carrying 60% of the cell is the same defect the two
		// ceiling sentences above were fixed for. And `graduated` is the STEADY
		// STATE of a pinned cell, not only the tick it pins, so the TRANSITION
		// wording comes from `pinChange`, never from the reason: a pinned cell whose
		// green clock was restarted by a thin window last tick has not "held 100%
		// for 14 days with every gate green", and saying so would be a false claim
		// on every tick thereafter.
		case 'graduated':
			if (decision.share < OWN_SHARE_CEILING) {
				return `Held ${where} at ${percent(decision.share)}: the cell is graduated and pinned, but remaining warming capacity bounds it below full share, so the relay still carries the rest. Capacity grows with the warming schedule.`;
			}
			return decision.pinChange === 'awarded'
				? `Graduated ${where}: 100% held for 14 days with every gate green. The cell is pinned and the relay drops to standby.`
				: `Held ${where} at 100%: the cell is graduated and pinned, and the relay is on standby.`;
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

/**
 * THE PACE DIAL'S SENTENCE (plan D12), in the SAME vocabulary as the share's.
 *
 * It lives in this file rather than a parallel one for the reason the pace
 * fixtures live with the share fixtures: the two actuators answer the same
 * questions in the same order, and a second narrative module is a second module
 * that can drift into calling the same rung by a different name.
 *
 * The multiplier is rendered as a MULTIPLIER (`1.00x -> 0.50x`) and never as a
 * percentage: a share is a proportion of traffic, a pace is a factor on a cap,
 * and rendering both as "50%" is how an operator ends up reading a halved
 * warming pace as half the mail.
 */
function multiple(multiplier: number): string {
	return `${(Math.round(multiplier * 100) / 100).toFixed(2)}x`;
}

/**
 * The pace decisions with a NAMED CAUSE — the same three hard stops and the same
 * gates as the share's `NOTIFIABLE_REASONS`, and deliberately the same set: a
 * breach that is worth telling an operator about when it moves the share is
 * worth telling them about when it moves the reputation-bearing dial instead.
 */
const NOTIFIABLE_PACE_REASONS: ReadonlySet<PaceDecisionReason> = NOTIFIABLE_REASONS;

/**
 * THE ADMIN NOTICE FOR A PACE RETREAT (plan D12).
 *
 * IT IS ITS OWN NOTICE BECAUSE A PACE-ONLY RETREAT IS REACHABLE. The two dials
 * keep separate freeze columns by design, so a share still inside an earlier
 * gate cooldown returns `frozen` — a hold, and not notifiable — while the pace
 * dial, whose own freeze has expired, halves and freezes on the same breach.
 * Deriving the notice from the share decision alone would write that incident to
 * the audit row and tell nobody. D12: every DECREASE names the gate that broke
 * and what to do about it.
 *
 * The predicate mirrors the share's exactly, and for the same two reasons: a
 * NAMED cause (so ceiling pull-backs and the un-corroborated tripwire stay
 * quiet) that also CHANGED something (so a dial already on the floor still
 * announces a fresh breach, while a persistent hard stop announces itself once).
 */
export function paceDecisionAdminNotice(
	cell: DeliverabilityCell,
	decision: PaceDecision
): string | undefined {
	const isChanged =
		decision.multiplier !== decision.fromMultiplier || decision.freeze?.ladderMs !== undefined;
	return NOTIFIABLE_PACE_REASONS.has(decision.reason) && isChanged
		? describePaceDecision(cell, decision)
		: undefined;
}

/**
 * One sentence for the pace dial, in the operator's terms.
 *
 * Exhaustive over `PaceDecisionReason`, which is the share's union plus the five
 * reasons only this dial can reach — so a new rung cannot ship without a
 * sentence. The share-only rungs (a phase ceiling, a graduation, an unreadable
 * SHARE) are grouped into one arm: the pace ladder cannot produce them, and
 * writing five sentences nobody can trigger would be five sentences nobody
 * maintains.
 */
export function describePaceDecision(cell: DeliverabilityCell, decision: PaceDecision): string {
	const where = `${cell.stream} mail to ${cell.destinationProvider}`;
	const move = `${multiple(decision.fromMultiplier)} -> ${multiple(decision.multiplier)}`;
	const isDown = decision.direction === 'decrease';

	switch (decision.reason) {
		case 'kill_switch':
			return `Warm-up pace paused: ${where} is pinned at ${multiple(decision.multiplier)} by the global kill switch.`;
		case 'clock_unusable':
			return `Held the warm-up pace for ${where} at ${multiple(decision.multiplier)}: the evaluation clock was unusable, and the controller never decides against a broken clock.`;
		case 'abuse_status':
			return isDown
				? `Cut the warm-up pace for ${where} to the minimum (${move}): the organization's abuse status forbids sending. Resolve the account status first.`
				: `Held the warm-up pace for ${where} at the minimum: the organization's abuse status still forbids sending. Resolve the account status first.`;
		case 'breaker':
			return isDown
				? `Halved the warm-up pace for ${where} (${move}): the MTA circuit breaker is open for this provider. Frozen for at least 6h while the breaker recovers.`
				: `Held the warm-up pace for ${where} at ${multiple(decision.multiplier)}: the breaker is still open, and the retreat for this incident has already been charged.`;
		case 'dnsbl':
			return isDown
				? `Cut the warm-up pace for ${where} to the minimum (${move}): a pool IP carries a critical blocklist listing. Frozen for at least 24h — start the delisting flow from the Delivery checklist.`
				: `Held the warm-up pace for ${where} at the minimum: a pool IP still carries a critical blocklist listing. Start the delisting flow from the Delivery checklist.`;
		case 'frozen':
			return `Held the warm-up pace for ${where} at ${multiple(decision.multiplier)}: an earlier pace decision froze this cell and the cooldown has not expired.`;
		case 'freeze_unreadable':
			return `Held the warm-up pace for ${where} at ${multiple(decision.multiplier)}: the stored freeze expiry was further out than any cooldown this controller imposes, so it was not believed — and an unreadable freeze is not a reason to step up.`;
		case 'multiplier_unreadable':
			return `Held the warm-up pace for ${where} at ${multiple(decision.multiplier)}: the stored pace multiplier was not a usable value and has been read back inside its bounds. The controller does not add to a number it cannot read.`;
		case 'holding':
			return `Held the warm-up pace for ${where} at ${multiple(decision.multiplier)}: not enough fresh evidence to decide. The controller never increases on thin data, and never decreases on it either.`;
		case 'evidence_stale':
			return `Held the warm-up pace for ${where} at ${multiple(decision.multiplier)}: the measurements behind this decision were not a reading of the present. The dial neither rises nor falls on evidence it cannot date.`;
		case 'awaiting_corroboration':
			return `Held the warm-up pace for ${where} at ${multiple(decision.multiplier)}: the seed-placement tripwire fired alone. Seeds are too small a sample to act on without the deferral or bounce gate agreeing.`;
		case 'day_already_advanced':
			return `Held the warm-up pace for ${where} at ${multiple(decision.multiplier)}: today's schedule advance has already been taken. A warming schedule advances at most once per UTC day, however often the controller ticks.`;
		case 'share_moved_first':
			return `Held the warm-up pace for ${where} at ${multiple(decision.multiplier)}: the transport share moved first this window. A cell never increases both dials in one window — the pace step is owed and will be taken once the window closes.`;
		case 'low_utilisation':
			return `Held the warm-up pace for ${where} at ${multiple(decision.multiplier)}: the current daily cap was not exercised enough for this window to say anything. An unexercised cap is not evidence, so the dial waits for the volume rather than growing a cap nothing is filling.`;
		case 'building_confidence':
			return `Held the warm-up pace for ${where} at ${multiple(decision.multiplier)}: the window was clean, but the controller requires several consecutive clean windows before it speeds up.`;
		case 'schedule_ceiling':
			return `Held the warm-up pace for ${where} at its maximum: what limits the daily cap from here is the published warming schedule, which the controller may never exceed for the current day.`;
		case 'healthy':
			return `Increased the warm-up pace for ${where} (${move}): every gate is green, the clean streak is long enough and the current cap is genuinely being used.`;
		case 'hard_bounce':
		case 'deferral':
		case 'complaint':
		case 'engagement_ratio':
		case 'seed_placement': {
			const breached = `the ${decision.reason.replace(/_/g, ' ')} gate breached`;
			return isDown
				? `Reduced the warm-up pace for ${where} (${move}): ${breached}. ${paceGateRemedy(decision)}`
				: `Held the warm-up pace for ${where} at its ${multiple(decision.multiplier)} minimum: ${breached} again, and the dial is already as low as it goes. ${paceGateRemedy(decision)}`;
		}
		// SHARE-ONLY RUNGS. The pace ladder has no share to read, no phase ceiling
		// and no graduation, so none of these is reachable here — they are in the
		// union only because the two actuators share one reason vocabulary.
		case 'share_unreadable':
		case 'capacity_unknown':
		case 'capacity_ceiling':
		case 'phase_ceiling':
		// The substitution table's phase cap is a SHARE ceiling too — it caps the
		// phase ladder, which the pace dial does not climb. It was missing from
		// this group and fell through to an undefined sentence; the reason union
		// is exhaustive at compile time but a missing arm returns nothing at
		// runtime, which is exactly what `__tests__/paceNarrative.test.ts` is for.
		case 'degradation_ceiling':
		case 'window_open':
		case 'graduated':
			return `Held the warm-up pace for ${where} at ${multiple(decision.multiplier)}.`;
	}
}

/** The pace dial's gate remedy — the SAME table the share's sentences index. */
function paceGateRemedy(decision: PaceDecision): string {
	const gate = decision.failedGate;
	if (gate === undefined) return 'Review the delivery dashboard for the failing measurement.';
	return RAMP_GATE_REMEDIES[gate];
}
