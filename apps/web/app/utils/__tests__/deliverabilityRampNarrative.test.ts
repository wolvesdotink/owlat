/**
 * THE RAMP NARRATIVE — every state a deployment can actually be in.
 *
 * The card's job is to be TRUE on a fresh install, on a paused ramp, on a
 * retreat, and on a deployment that has finished — so each of those is a test
 * rather than an afterthought. The two properties that carry the most weight:
 *
 *   - nothing merely unconfigured is described as a problem (plan D2): a
 *     deployment with no cell on the ramp gets an invitation, not a warning;
 *   - the controller's own sentences are rendered verbatim, never re-worded, so
 *     this card and the audit trail cannot describe one decision two ways.
 */
import { describe, expect, it } from 'vitest';
import {
	rampAdvancedScreens,
	rampNextAction as rampNextActionFor,
	rampPhaseNarrative as rampPhaseNarrativeFor,
	recentRampDecisions,
	type LocalizedText,
	type RampNextAction,
	type RampNarrativePhase,
} from '~/utils/deliverabilityRampNarrative';
import type { RampControls } from '~/utils/deliverabilityRamp';
import { createTestI18n } from '~/__tests__/i18n';
import {
	cellControl,
	controlsView,
	decision,
	NOW,
	DAY_MS,
} from '~/components/delivery/__tests__/rampFixtures';

/**
 * The narrative is module scope, so every sentence arrives as a catalog key —
 * and the two that quote a cell's name take the resolver the card hands them.
 * The suite renders through the real English catalog, because the copy is what
 * these properties are about.
 */
const { t } = createTestI18n().global;
const localized = (value: LocalizedText): string =>
	typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
const rampPhaseNarrative = (controls: RampControls): RampNarrativePhase =>
	rampPhaseNarrativeFor(controls, localized);
const rampNextAction = (controls: RampControls): RampNextAction =>
	rampNextActionFor(controls, localized);

describe('ramp phase narrative', () => {
	it('invites rather than warns when nothing is on the ramp', () => {
		const phase = rampPhaseNarrative(
			controlsView({ cells: [cellControl({ isRampManaged: false, lastDecision: null })] })
		);
		expect(phase.key).toBe('not_started');
		expect(phase.progress).toBeNull();
		expect(localized(phase.detail)).toContain('Nothing is wrong');
		expect(localized(phase.title).toLowerCase()).not.toContain('incomplete');
	});

	it('counts graduations out of the managed cells only', () => {
		const phase = rampPhaseNarrative(
			controlsView({
				cells: [
					cellControl({ cellKey: 'campaign:gmail', graduatedAt: NOW - DAY_MS }),
					cellControl({ cellKey: 'campaign:microsoft' }),
					// Never enrolled: it is not part of the denominator, because it is not
					// a step anybody has left unfinished.
					cellControl({ cellKey: 'automation:gmail', isRampManaged: false }),
				],
			})
		);
		expect(phase.key).toBe('warming');
		expect(phase.progress).toEqual(
			expect.objectContaining({ graduated: 1, managed: 2, fraction: 0.5 })
		);
		expect(localized(phase.progress!.label)).toBe('1 of 2 cells on the ramp graduated so far');
	});

	it('names the leading cell, its ceiling and its clean streak', () => {
		const phase = rampPhaseNarrative(
			controlsView({
				cells: [
					cellControl({ cellKey: 'campaign:gmail', ownShare: 0.25, phaseCeiling: 0.5 }),
					cellControl({ cellKey: 'campaign:microsoft', ownShare: 0.1, cleanStreak: 0 }),
				],
			})
		);
		expect(localized(phase.detail)).toContain('Campaign → Gmail');
		expect(localized(phase.detail)).toContain('25%');
		expect(localized(phase.detail)).toContain('50%');
		expect(localized(phase.detail)).toContain('2 clean windows');
	});

	it('does not credit the ramp with a share it never moved on a pace-path cell', () => {
		// `isShareRamped` false is a cell with no second sender: it already sends
		// everything from the own server, and the dial that climbs is the pace.
		const phase = rampPhaseNarrative(
			controlsView({
				isRelayConfigured: false,
				cells: [cellControl({ isShareRamped: false, ownShare: 1 })],
			})
		);
		expect(localized(phase.detail)).toContain('warm-up pace');
		expect(localized(phase.detail)).not.toContain('ceiling on its current phase');
	});

	it('says a paused ramp is paused, and still counts what is on it', () => {
		const phase = rampPhaseNarrative(controlsView({ isControllerPaused: true }));
		expect(phase.key).toBe('paused');
		expect(localized(phase.detail)).toContain('pinned where it is');
		expect(phase.progress?.managed).toBe(1);
	});

	it('mentions the relay still being paid for once every cell has graduated', () => {
		const graduated = controlsView({ cells: [cellControl({ graduatedAt: NOW - DAY_MS })] });
		expect(rampPhaseNarrative(graduated).key).toBe('graduated');
		expect(localized(rampPhaseNarrative(graduated).detail)).toContain('still being paid for');
		expect(
			localized(rampPhaseNarrative({ ...graduated, isRelayConfigured: false }).detail)
		).not.toContain('still being paid for');
	});
});

describe('recent ramp decisions', () => {
	it('orders the newest decision per cell first and keeps the holds', () => {
		const recent = recentRampDecisions(
			controlsView({
				cells: [
					cellControl({
						cellKey: 'campaign:gmail',
						lastDecision: decision({ at: NOW - 3 * DAY_MS, direction: 'hold' }),
					}),
					cellControl({
						cellKey: 'campaign:microsoft',
						cell: { stream: 'campaign', destinationProvider: 'microsoft' },
						lastDecision: decision({ at: NOW - DAY_MS }),
					}),
				],
			})
		);
		expect(recent.map((entry) => entry.key)).toEqual(['campaign:microsoft', 'campaign:gmail']);
		expect(localized(recent[1]!.directionLabel)).toBe('Held');
	});

	it('renders the controller’s own sentence and notice verbatim', () => {
		const notice = 'Reduced campaign mail to gmail (50% -> 25%): the hard bounce gate breached.';
		const [entry] = recentRampDecisions(
			controlsView({
				cells: [
					cellControl({
						lastDecision: decision({
							direction: 'decrease',
							fromShare: 0.5,
							toShare: 0.25,
							reason: 'hard_bounce',
							message: 'Reduced campaign mail to gmail (50% -> 25%).',
							adminNotice: notice,
						}),
					}),
				],
			})
		);
		expect(entry?.message).toBe('Reduced campaign mail to gmail (50% -> 25%).');
		expect(entry?.notice).toBe(notice);
		expect(entry?.move).toBe('50% → 25%');
		expect(localized(entry!.reason)).toBe('The hard-bounce gate');
		expect(localized(entry!.directionLabel)).toBe('Pulled back');
	});

	it('skips cells the controller has never decided about', () => {
		expect(
			recentRampDecisions(controlsView({ cells: [cellControl({ lastDecision: null })] }))
		).toEqual([]);
	});

	it('never returns more than the caller asked for', () => {
		const cells = [0, 1, 2, 3].map((index) =>
			cellControl({ cellKey: `cell:${index}`, lastDecision: decision({ at: NOW - index }) })
		);
		expect(recentRampDecisions(controlsView({ cells }))).toHaveLength(3);
		expect(recentRampDecisions(controlsView({ cells }), 2)).toHaveLength(2);
	});
});

describe('the single next action', () => {
	it('puts resuming a globally paused ramp above every cell-level state', () => {
		const action = rampNextAction(
			controlsView({
				isControllerPaused: true,
				cells: [cellControl({ isPaused: true, lastDecision: decision({ direction: 'decrease' }) })],
			})
		);
		expect(action.key).toBe('resume_controller');
		expect(action.to).toBe('/dashboard/admin/delivery/advanced/controls');
	});

	it('offers the first enrolment when nothing is on the ramp', () => {
		const action = rampNextAction(
			controlsView({ cells: [cellControl({ isRampManaged: false, lastDecision: null })] })
		);
		expect(action.key).toBe('enroll_cell');
		expect(action.to).toBe('/dashboard/admin/delivery/advanced/controls');
	});

	it('invites the first enrolment even while the controller is paused', () => {
		// The pause flag survives a deployment taking its last cell off the ramp,
		// and the card would then head "No cell is on the ramp yet" over an action
		// telling the operator to resume it. Nothing to move outranks the pause.
		const controls = controlsView({
			isControllerPaused: true,
			cells: [cellControl({ isRampManaged: false, lastDecision: null })],
		});
		expect(rampPhaseNarrative(controls).key).toBe('not_started');
		expect(rampNextAction(controls).key).toBe('enroll_cell');
	});

	it('leads with the newest retreat and quotes its notice', () => {
		const action = rampNextAction(
			controlsView({
				cells: [
					cellControl({
						cellKey: 'campaign:gmail',
						lastDecision: decision({
							at: NOW - 2 * DAY_MS,
							direction: 'decrease',
							adminNotice: 'older retreat',
						}),
					}),
					cellControl({
						cellKey: 'campaign:microsoft',
						cell: { stream: 'campaign', destinationProvider: 'microsoft' },
						lastDecision: decision({
							at: NOW - DAY_MS,
							direction: 'decrease',
							adminNotice: 'newest retreat, and what to do about it',
						}),
					}),
				],
			})
		);
		expect(action.key).toBe('read_pull_back');
		expect(localized(action.title)).toContain('Campaign → Microsoft');
		expect(localized(action.detail)).toBe('newest retreat, and what to do about it');
		expect(action.to).toBe('/dashboard/admin/delivery/advanced/cells');
	});

	it('falls back to the decision sentence when a retreat carried no notice', () => {
		const action = rampNextAction(
			controlsView({
				cells: [
					cellControl({
						lastDecision: decision({
							direction: 'decrease',
							message: 'Reduced campaign mail to gmail (50% -> 25%).',
							adminNotice: null,
						}),
					}),
				],
			})
		);
		expect(localized(action.detail)).toBe('Reduced campaign mail to gmail (50% -> 25%).');
	});

	it('names an operator hold as the operator’s own, not as a fault', () => {
		const paused = rampNextAction(controlsView({ cells: [cellControl({ isPaused: true })] }));
		expect(paused.key).toBe('release_hold');
		expect(localized(paused.detail)).toContain('Nothing is wrong');

		const pinned = rampNextAction(controlsView({ cells: [cellControl({ pinnedShare: 0.25 })] }));
		expect(pinned.key).toBe('release_hold');
		expect(localized(pinned.detail)).toContain('25%');
	});

	it('points a fully graduated deployment at the relay it is still paying for', () => {
		const action = rampNextAction(
			controlsView({ cells: [cellControl({ graduatedAt: NOW - DAY_MS })] })
		);
		expect(action.key).toBe('disconnect_relay');
		expect(action.to).toBe('/dashboard/admin/delivery/advanced/independence');
	});

	it('never invents a task when the controller is simply working', () => {
		const action = rampNextAction(
			controlsView({
				isRelayConfigured: false,
				cells: [cellControl({ graduatedAt: NOW - DAY_MS, isShareRamped: false })],
			})
		);
		expect(action.key).toBe('watch_evidence');
		expect(localized(action.title)).toBe('Nothing needs you right now');
		expect(action.to).toBe('/dashboard/admin/delivery/advanced/measurement');
	});

	it('names what the leading cell is waiting on, in the controller’s own words', () => {
		const action = rampNextAction(
			controlsView({
				cells: [cellControl({ lastDecision: decision({ reason: 'building_confidence' }) })],
			})
		);
		expect(localized(action.detail)).toContain('Building a clean streak.');
	});
});

describe('the four doors into the detail', () => {
	it('follows the D14 rename when there is no relay to become independent of', () => {
		expect(rampAdvancedScreens(true).map((screen) => localized(screen.label))).toEqual([
			'Cells',
			'Controls',
			'Measurement',
			'Independence',
		]);
		expect(localized(rampAdvancedScreens(false).at(-1)!.label)).toBe('Warm-up autopilot');
		expect(rampAdvancedScreens(false).at(-1)?.to).toBe(
			'/dashboard/admin/delivery/advanced/independence'
		);
	});
});
