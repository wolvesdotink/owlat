/**
 * Yahoo CFL guided-enrollment state machine (P4-6).
 *
 * The pure decision core (D15): every state, the DKIM-domain precondition, the
 * re-check, and the guided steps. Exhaustive — the correctness of the guided
 * flow lives here, not in the Convex shell.
 */

import { describe, expect, it } from 'vitest';
import {
	applyYahooCflEvent,
	deriveYahooCflState,
	emptyYahooCflEnrollment,
	isYahooCflEnrollmentState,
	isYahooCflStoredState,
	YAHOO_CFL_ENROLLMENT_STATES,
	YAHOO_CFL_ENROLLMENT_URL,
	YAHOO_CFL_LAPSE_SILENCE_MS,
	YAHOO_CFL_STORED_STATES,
	YAHOO_CFL_SUBMISSION_PATIENCE_MS,
	yahooCflGuidedSteps,
	yahooCflPreconditionMet,
	type YahooCflDkimPrecondition,
	type YahooCflEnrollmentRecord,
} from '../yahooCfl';

const READY: YahooCflDkimPrecondition = {
	domain: 'mail.example.com',
	isVerified: true,
	dkimSelector: 's1711234567',
};
const UNVERIFIED: YahooCflDkimPrecondition = { domain: 'mail.example.com', isVerified: false };
const NO_SELECTOR: YahooCflDkimPrecondition = { domain: 'mail.example.com', isVerified: true };

const T0 = Date.UTC(2026, 6, 1);
const DAY = 24 * 60 * 60 * 1000;

describe('states', () => {
	it('enumerates exactly the four guided-flow states', () => {
		expect(YAHOO_CFL_ENROLLMENT_STATES).toEqual([
			'not_started',
			'awaiting_yahoo',
			'enrolled',
			'lapsed',
		]);
	});

	it('starts every domain at not_started with no timestamps', () => {
		expect(emptyYahooCflEnrollment()).toEqual({ state: 'not_started' });
	});

	it('persists only the three states — lapsed is derived, never stored', () => {
		expect(YAHOO_CFL_STORED_STATES).toEqual(['not_started', 'awaiting_yahoo', 'enrolled']);
		expect(isYahooCflStoredState('lapsed')).toBe(false);
		expect(isYahooCflEnrollmentState('lapsed')).toBe(true);
	});

	it('guards unknown state strings', () => {
		expect(isYahooCflEnrollmentState('enrolled')).toBe(true);
		expect(isYahooCflEnrollmentState('ENROLLED')).toBe(false);
		expect(isYahooCflEnrollmentState(undefined)).toBe(false);
		expect(isYahooCflEnrollmentState(3)).toBe(false);
	});
});

describe('DKIM-domain precondition', () => {
	it('requires both a verified domain and a selector', () => {
		expect(yahooCflPreconditionMet(READY)).toBe(true);
		expect(yahooCflPreconditionMet(UNVERIFIED)).toBe(false);
		expect(yahooCflPreconditionMet(NO_SELECTOR)).toBe(false);
		expect(
			yahooCflPreconditionMet({ domain: 'x.example', isVerified: true, dkimSelector: '   ' })
		).toBe(false);
	});

	it('refuses submission without it — and refusal is a reason, not a throw', () => {
		const result = applyYahooCflEvent(
			emptyYahooCflEnrollment(),
			{ kind: 'submit', at: T0 },
			UNVERIFIED
		);
		expect(result.changed).toBe(false);
		expect(result.reason).toBe('dkim_domain_not_ready');
		expect(result.record.state).toBe('not_started');
	});
});

describe('not_started -> awaiting_yahoo -> enrolled', () => {
	it('submits, snapshotting the DKIM domain', () => {
		const result = applyYahooCflEvent(emptyYahooCflEnrollment(), { kind: 'submit', at: T0 }, READY);
		expect(result.changed).toBe(true);
		expect(result.reason).toBe('submitted');
		expect(result.record).toEqual({
			state: 'awaiting_yahoo',
			dkimDomain: 'mail.example.com',
			submittedAt: T0,
		});
	});

	it('re-submits from awaiting_yahoo, refreshing the submission time', () => {
		const submitted = applyYahooCflEvent(
			emptyYahooCflEnrollment(),
			{ kind: 'submit', at: T0 },
			READY
		).record;
		const again = applyYahooCflEvent(submitted, { kind: 'submit', at: T0 + DAY }, READY);
		expect(again.reason).toBe('resubmitted');
		expect(again.record.submittedAt).toBe(T0 + DAY);
	});

	it('confirms only after a submission', () => {
		const early = applyYahooCflEvent(emptyYahooCflEnrollment(), { kind: 'confirm', at: T0 }, READY);
		expect(early.changed).toBe(false);
		expect(early.reason).toBe('not_submitted');

		const submitted = applyYahooCflEvent(
			emptyYahooCflEnrollment(),
			{ kind: 'submit', at: T0 },
			READY
		).record;
		const confirmed = applyYahooCflEvent(submitted, { kind: 'confirm', at: T0 + DAY }, READY);
		expect(confirmed.record).toMatchObject({ state: 'enrolled', enrolledAt: T0 + DAY });
	});

	it('is idempotent once enrolled', () => {
		const enrolled: YahooCflEnrollmentRecord = { state: 'enrolled', enrolledAt: T0 };
		expect(applyYahooCflEvent(enrolled, { kind: 'confirm', at: T0 + DAY }, READY)).toEqual({
			record: enrolled,
			changed: false,
			reason: 'already_enrolled',
		});
		expect(applyYahooCflEvent(enrolled, { kind: 'submit', at: T0 + DAY }, READY).reason).toBe(
			'already_enrolled'
		);
	});
});

describe('a report is ground truth', () => {
	it('promotes awaiting_yahoo straight to enrolled', () => {
		const awaiting: YahooCflEnrollmentRecord = {
			state: 'awaiting_yahoo',
			submittedAt: T0,
		};
		const result = applyYahooCflEvent(awaiting, { kind: 'report_observed', at: T0 + DAY }, READY);
		expect(result.reason).toBe('report_confirms_enrollment');
		expect(result.record).toMatchObject({
			state: 'enrolled',
			enrolledAt: T0 + DAY,
			lastReportAt: T0 + DAY,
		});
	});

	it('un-lapses a silent enrollment without rewriting enrolledAt', () => {
		const silent: YahooCflEnrollmentRecord = {
			state: 'enrolled',
			enrolledAt: T0,
			lastReportAt: T0 + DAY,
		};
		expect(deriveYahooCflState(silent, T0 + 200 * DAY).state).toBe('lapsed');
		const result = applyYahooCflEvent(
			silent,
			{ kind: 'report_observed', at: T0 + 200 * DAY },
			READY
		);
		expect(result.record).toMatchObject({
			state: 'enrolled',
			enrolledAt: T0,
			lastReportAt: T0 + 200 * DAY,
		});
		expect(deriveYahooCflState(result.record, T0 + 200 * DAY).state).toBe('enrolled');
	});

	it('never rewinds lastReportAt on an out-of-order replay', () => {
		const enrolled: YahooCflEnrollmentRecord = {
			state: 'enrolled',
			enrolledAt: T0,
			lastReportAt: T0 + 10 * DAY,
		};
		const replay = applyYahooCflEvent(
			enrolled,
			{ kind: 'report_observed', at: T0 + 2 * DAY },
			READY
		);
		expect(replay.changed).toBe(false);
		expect(replay.record.lastReportAt).toBe(T0 + 10 * DAY);
	});

	it('records a report even when the DKIM precondition is not met', () => {
		// Yahoo is demonstrably sending us reports; our own view of the DKIM
		// domain is irrelevant to that fact.
		const result = applyYahooCflEvent(
			emptyYahooCflEnrollment(),
			{ kind: 'report_observed', at: T0 },
			UNVERIFIED
		);
		expect(result.record.state).toBe('enrolled');
	});
});

describe('the re-check, derived on read', () => {
	it('lapses an enrolled domain after 90 silent days, counted from the last report', () => {
		const enrolled: YahooCflEnrollmentRecord = {
			state: 'enrolled',
			enrolledAt: T0,
			lastReportAt: T0 + DAY,
		};
		expect(deriveYahooCflState(enrolled, T0 + DAY + YAHOO_CFL_LAPSE_SILENCE_MS - 1)).toEqual({
			state: 'enrolled',
			silentMs: YAHOO_CFL_LAPSE_SILENCE_MS - 1,
		});
		expect(deriveYahooCflState(enrolled, T0 + DAY + YAHOO_CFL_LAPSE_SILENCE_MS)).toEqual({
			state: 'lapsed',
			silentMs: YAHOO_CFL_LAPSE_SILENCE_MS,
		});
	});

	it('counts from enrolledAt when no report has ever arrived', () => {
		const enrolled: YahooCflEnrollmentRecord = { state: 'enrolled', enrolledAt: T0 };
		expect(deriveYahooCflState(enrolled, T0 + YAHOO_CFL_LAPSE_SILENCE_MS).state).toBe('lapsed');
		expect(deriveYahooCflState(enrolled, T0 + DAY).state).toBe('enrolled');
	});

	it('never lapses a state that was never enrolled', () => {
		for (const state of ['not_started', 'awaiting_yahoo'] as const) {
			expect(
				deriveYahooCflState({ state, submittedAt: T0 }, T0 + 10 * YAHOO_CFL_LAPSE_SILENCE_MS)
			).toEqual({ state, silentMs: 0 });
		}
	});

	it('treats a record with no timestamps at all as freshly enrolled, never lapsed', () => {
		expect(deriveYahooCflState({ state: 'enrolled' }, T0).state).toBe('enrolled');
	});

	it('never launders clock skew into a lapse', () => {
		// A clock behind the record yields a negative interval; it must clamp to 0,
		// not wrap into a 90-day silence.
		expect(deriveYahooCflState({ state: 'enrolled', lastReportAt: T0 }, T0 - 100 * DAY)).toEqual({
			state: 'enrolled',
			silentMs: 0,
		});
	});
});

describe('reset', () => {
	it('clears every timestamp', () => {
		const enrolled: YahooCflEnrollmentRecord = {
			state: 'enrolled',
			dkimDomain: 'mail.example.com',
			submittedAt: T0,
			enrolledAt: T0,
			lastReportAt: T0,
		};
		const result = applyYahooCflEvent(enrolled, { kind: 'reset', at: T0 + DAY }, READY);
		expect(result.record).toEqual({ state: 'not_started' });
	});

	it('is a no-op on a record that was never started', () => {
		expect(
			applyYahooCflEvent(emptyYahooCflEnrollment(), { kind: 'reset', at: T0 }, READY).reason
		).toBe('nothing_to_reset');
	});
});

describe('guided steps — actionable at every state', () => {
	it('states what to do and how to tell it worked, for all four steps', () => {
		const steps = yahooCflGuidedSteps(emptyYahooCflEnrollment(), READY, T0);
		expect(steps.map((s) => s.id)).toEqual([
			'verify_dkim_domain',
			'submit_enrollment',
			'confirm_enrollment',
			'watch_reports',
		]);
		for (const step of steps) {
			expect(step.action.length).toBeGreaterThan(0);
			expect(step.verification.length).toBeGreaterThan(0);
			expect(step.title.length).toBeGreaterThan(0);
		}
		expect(steps[1]?.link).toBe(YAHOO_CFL_ENROLLMENT_URL);
	});

	it('blocks submission on the precondition and names the selector when ready', () => {
		const blocked = yahooCflGuidedSteps(emptyYahooCflEnrollment(), UNVERIFIED, T0);
		expect(blocked[0]?.status).toBe('todo');
		expect(blocked[1]?.status).toBe('blocked');

		const ready = yahooCflGuidedSteps(emptyYahooCflEnrollment(), READY, T0);
		expect(ready[0]?.status).toBe('done');
		expect(ready[0]?.verification).toContain('s1711234567');
		expect(ready[1]?.status).toBe('todo');
	});

	it('suggests re-submitting once Yahoo has been silent for two weeks', () => {
		const awaiting: YahooCflEnrollmentRecord = { state: 'awaiting_yahoo', submittedAt: T0 };
		const patient = yahooCflGuidedSteps(awaiting, READY, T0 + DAY);
		expect(patient[2]?.status).toBe('in_progress');
		expect(patient[2]?.action).not.toContain('Re-submit');

		const impatient = yahooCflGuidedSteps(awaiting, READY, T0 + YAHOO_CFL_SUBMISSION_PATIENCE_MS);
		expect(impatient[2]?.action).toContain('Re-submit');
	});

	it('completes the flow once reports arrive', () => {
		const live: YahooCflEnrollmentRecord = {
			state: 'enrolled',
			submittedAt: T0,
			enrolledAt: T0,
			lastReportAt: T0 + DAY,
		};
		const steps = yahooCflGuidedSteps(live, READY, T0 + 2 * DAY);
		expect(steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done']);
	});

	it('tells the operator exactly what a lapse means and what to do', () => {
		const silent: YahooCflEnrollmentRecord = {
			state: 'enrolled',
			submittedAt: T0,
			enrolledAt: T0,
		};
		const steps = yahooCflGuidedSteps(silent, READY, T0 + 200 * DAY);
		expect(steps[3]?.status).toBe('todo');
		expect(steps[3]?.action).toContain('Re-check the enrollment at Yahoo');
		expect(steps[3]?.verification).toContain('90 days');
	});
});

describe('adversarial / degenerate inputs', () => {
	it('tolerates clock skew: a report timestamped in the past still enrolls', () => {
		const result = applyYahooCflEvent(
			{ state: 'awaiting_yahoo', submittedAt: T0 },
			{ kind: 'report_observed', at: T0 - 10 * DAY },
			READY
		);
		expect(result.record.state).toBe('enrolled');
		expect(result.record.lastReportAt).toBe(T0 - 10 * DAY);
	});

	it('tolerates a zero clock without lapsing on the epoch', () => {
		expect(
			deriveYahooCflState({ state: 'enrolled', enrolledAt: 0, lastReportAt: 0 }, 0).state
		).toBe('enrolled');
	});

	it('never mutates its input record', () => {
		const record: YahooCflEnrollmentRecord = { state: 'awaiting_yahoo', submittedAt: T0 };
		const snapshot = JSON.stringify(record);
		applyYahooCflEvent(record, { kind: 'confirm', at: T0 + DAY }, READY);
		applyYahooCflEvent(record, { kind: 'report_observed', at: T0 + DAY }, READY);
		applyYahooCflEvent(record, { kind: 'reset', at: T0 + DAY }, READY);
		expect(JSON.stringify(record)).toBe(snapshot);
	});
});
