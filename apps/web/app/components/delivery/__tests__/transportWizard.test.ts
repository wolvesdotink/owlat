// @vitest-environment happy-dom
/**
 * The transport connection wizard's four steps, their pass/fail states, and
 * step-to-step navigation INCLUDING going back (P2-4).
 *
 * Two halves: the pure state machine (`~/utils/transportWizard`), exhaustively,
 * and the mounted component walking the same transitions for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import {
	TRANSPORT_WIZARD_STEPS,
	advanceStep,
	alignmentStepStatus,
	canAdvance,
	canGoBack,
	createTransportWizardState,
	goBackStep,
	isLastStep,
	returnPathStepStatus,
	setStepStatus,
	stepAt,
	stepById,
	stepIndex,
	type TransportWizardState,
} from '~/utils/transportWizard';
import { runAlignmentProbe } from '~/utils/transportAlignmentProbe';
import {
	ALIGNED_DNS,
	armsFixture,
	buttonByText,
	fillCredentials,
	mountWizard,
	openWizard,
	stubDoh,
} from './wizardHarness';

// The real probe, wrapped so ONE case can make it throw. Everything else runs
// the shipped gather + evaluator against the DNS fixture.
vi.mock('~/utils/transportAlignmentProbe', async (importOriginal) => {
	const actual = await importOriginal<typeof import('~/utils/transportAlignmentProbe')>();
	return { ...actual, runAlignmentProbe: vi.fn(actual.runAlignmentProbe) };
});

function pass(state: TransportWizardState, ...ids: Parameters<typeof setStepStatus>[1][]) {
	return ids.reduce((acc, id) => setStepStatus(acc, id, 'passed'), state);
}

describe('transport wizard — pure state machine', () => {
	it('is four steps, only the first three of which block progress', () => {
		expect(TRANSPORT_WIZARD_STEPS.map((step) => step.id)).toEqual([
			'credentials',
			'test_send',
			'alignment',
			'return_path',
		]);
		expect(TRANSPORT_WIZARD_STEPS.map((step) => step.blocking)).toEqual([true, true, true, false]);
	});

	it('starts on the credentials step with nothing attempted', () => {
		const state = createTransportWizardState();
		expect(state.current).toBe('credentials');
		expect(Object.values(state.statuses)).toEqual([
			'not_started',
			'not_started',
			'not_started',
			'not_started',
		]);
		expect(canAdvance(state)).toBe(false);
		expect(canGoBack(state)).toBe(false);
	});

	it('holds a blocking step until it passes, and holds on failure and on unknown', () => {
		const state = createTransportWizardState();
		for (const status of ['running', 'failed', 'unknown'] as const) {
			expect(canAdvance(setStepStatus(state, 'credentials', status))).toBe(false);
		}
		expect(canAdvance(setStepStatus(state, 'credentials', 'passed'))).toBe(true);
	});

	it('advances one step at a time and refuses to advance past the last', () => {
		let state = pass(createTransportWizardState(), 'credentials');
		state = advanceStep(state);
		expect(state.current).toBe('test_send');
		state = advanceStep(state);
		// test_send has not passed — the transition is a no-op, not a throw.
		expect(state.current).toBe('test_send');
		state = advanceStep(pass(state, 'test_send'));
		expect(state.current).toBe('alignment');
		state = advanceStep(pass(state, 'alignment'));
		expect(state.current).toBe('return_path');
		expect(isLastStep(state)).toBe(true);
		expect(advanceStep(state)).toBe(state);
	});

	it('goes BACK from any step but the first, preserving every status', () => {
		let state = pass(createTransportWizardState(), 'credentials', 'test_send');
		state = advanceStep(advanceStep(state));
		expect(state.current).toBe('alignment');
		state = goBackStep(state);
		expect(state.current).toBe('test_send');
		expect(state.statuses.test_send).toBe('passed');
		state = goBackStep(state);
		expect(state.current).toBe('credentials');
		expect(state.statuses.credentials).toBe('passed');
		expect(goBackStep(state)).toBe(state);
	});

	it('lets the non-blocking return-path step finish on any resolved posture', () => {
		// It is the LAST step, so "finished" is about the step's own status rather
		// than about advancing: `unknown` on the informational step is a resolved
		// posture, where the same status on a blocking step would hold.
		const walked = pass(createTransportWizardState(), 'credentials');
		expect(canAdvance(setStepStatus(walked, 'credentials', 'unknown'))).toBe(false);
		expect(stepById('return_path').blocking).toBe(false);
		expect(returnPathStepStatus('unknown')).toBe('unknown');
	});

	it('resolves every step id totally, unlike an array index', () => {
		for (const step of TRANSPORT_WIZARD_STEPS) {
			expect(stepById(step.id)).toBe(step);
		}
	});

	it('maps every pre-flight verdict onto a step status', () => {
		const base = { checks: [], isMeasurementDegraded: false, measurementDegradedReason: null };
		const at = { checkedAt: 0, nextCheckDueAt: 0 };
		expect(alignmentStepStatus({ ...base, ...at, verdict: 'aligned' })).toBe('passed');
		// D2: no reference transport is a PASS with plain copy, never a warning.
		expect(alignmentStepStatus({ ...base, ...at, verdict: 'single_arm' })).toBe('passed');
		expect(alignmentStepStatus({ ...base, ...at, verdict: 'blocked' })).toBe('failed');
		expect(alignmentStepStatus({ ...base, ...at, verdict: 'unknown' })).toBe('unknown');
	});

	it('never fails on the return-path probe — the worst posture is "not known"', () => {
		expect(returnPathStepStatus('supported')).toBe('passed');
		expect(returnPathStepStatus('unsupported')).toBe('passed');
		expect(returnPathStepStatus('unknown')).toBe('unknown');
	});

	it('indexes steps without reading past the ends', () => {
		expect(stepIndex('alignment')).toBe(2);
		expect(stepAt(4)).toBeNull();
		expect(stepAt(-1)).toBeNull();
	});
});

describe('transport wizard — mounted flow', () => {
	beforeEach(() => {
		stubDoh(ALIGNED_DNS);
		vi.stubGlobal(
			'$fetch',
			vi.fn(async () => ({
				ok: true,
				message: 'Applied.',
				applied: true,
				requiresRestart: false,
			}))
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function walkToAlignment() {
		const wrapper = mountWizard({
			alignmentArms: armsFixture(),
			returnPathCapability: 'supported',
		});
		await openWizard(wrapper);
		await fillCredentials(wrapper, 'resend', 're_live_secret');
		await buttonByText(wrapper, 'Save credentials').trigger('click');
		await flushPromises();
		await buttonByText(wrapper, 'Next').trigger('click');
		await flushPromises();
		await wrapper.find('.test-pass').trigger('click');
		await buttonByText(wrapper, 'Next').trigger('click');
		await flushPromises();
		return wrapper;
	}

	it('walks credentials → test send → alignment → return path', async () => {
		const wrapper = await walkToAlignment();
		expect(wrapper.text()).toContain('SPF, DKIM & DMARC alignment');
		await buttonByText(wrapper, 'Check alignment').trigger('click');
		await flushPromises();
		expect(wrapper.text()).toContain('indistinguishable to the receiver');
		await buttonByText(wrapper, 'Next').trigger('click');
		await flushPromises();
		expect(wrapper.text()).toContain('Return path');
		// The last step has no Next; it offers Done instead.
		expect(wrapper.findAll('button').some((b) => b.text().trim() === 'Next')).toBe(false);
		expect(buttonByText(wrapper, 'Done').exists()).toBe(true);
		wrapper.unmount();
	});

	it('holds on a failed live send test and releases once it passes', async () => {
		const wrapper = mountWizard({ returnPathCapability: 'unknown' });
		await openWizard(wrapper);
		await fillCredentials(wrapper, 'resend', 're_live_secret');
		await buttonByText(wrapper, 'Save credentials').trigger('click');
		await flushPromises();
		await buttonByText(wrapper, 'Next').trigger('click');
		await flushPromises();
		await wrapper.find('.test-fail').trigger('click');
		expect(buttonByText(wrapper, 'Next').attributes('disabled')).toBeDefined();
		await wrapper.find('.test-pass').trigger('click');
		expect(buttonByText(wrapper, 'Next').attributes('disabled')).toBeUndefined();
		wrapper.unmount();
	});

	it('goes back to an earlier step with its result still on screen', async () => {
		const wrapper = await walkToAlignment();
		await buttonByText(wrapper, 'Check alignment').trigger('click');
		await flushPromises();
		await buttonByText(wrapper, 'Back').trigger('click');
		await flushPromises();
		expect(wrapper.text()).toContain('Live send test');
		await buttonByText(wrapper, 'Next').trigger('click');
		await flushPromises();
		// The alignment findings survived the round trip — no re-run required.
		expect(wrapper.text()).toContain('One SPF record authorizes both arms');
		wrapper.unmount();
	});

	it('surfaces a failed credential apply without advancing', async () => {
		vi.stubGlobal(
			'$fetch',
			vi.fn(async (url: string) =>
				url === '/api/delivery/validate-transport'
					? { ok: true, message: 'Credentials verified.' }
					: {
							ok: false,
							message: 'The provider rejected the key.',
							applied: false,
							requiresRestart: false,
						}
			)
		);
		const wrapper = mountWizard();
		await openWizard(wrapper);
		await fillCredentials(wrapper, 'resend', 're_live_secret');
		await buttonByText(wrapper, 'Save credentials').trigger('click');
		await flushPromises();
		expect(wrapper.text()).toContain('The provider rejected the key.');
		expect(buttonByText(wrapper, 'Next').attributes('disabled')).toBeDefined();
		wrapper.unmount();
	});

	it('stops at the live handshake when the provider rejects the key, before applying', async () => {
		const fetchMock = vi.fn(async (url: string) =>
			url === '/api/delivery/validate-transport'
				? { ok: false, message: 'Resend says: invalid API key.' }
				: { ok: true, message: 'Applied.', applied: true, requiresRestart: false }
		);
		vi.stubGlobal('$fetch', fetchMock);
		const wrapper = mountWizard();
		await openWizard(wrapper);
		await fillCredentials(wrapper, 'resend', 're_live_secret');
		await buttonByText(wrapper, 'Save credentials').trigger('click');
		await flushPromises();
		expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
			'/api/delivery/validate-transport',
		]);
		expect(wrapper.text()).toContain('Resend says: invalid API key.');
		expect(buttonByText(wrapper, 'Next').attributes('disabled')).toBeDefined();
		wrapper.unmount();
	});

	it('applies the SMTP branch through the same two shipped endpoints', async () => {
		const fetchMock = vi.fn(async (url: string) =>
			url === '/api/delivery/validate-transport'
				? { ok: true, message: 'Connected.' }
				: { ok: true, message: 'Applied.', applied: true, requiresRestart: false }
		);
		vi.stubGlobal('$fetch', fetchMock);
		const wrapper = mountWizard();
		await openWizard(wrapper);
		await fillCredentials(wrapper, 'smtp');
		await buttonByText(wrapper, 'Save credentials').trigger('click');
		await flushPromises();
		expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
			'/api/delivery/validate-transport',
			'/api/delivery/apply-transport',
		]);
		expect(buttonByText(wrapper, 'Next').attributes('disabled')).toBeUndefined();
		wrapper.unmount();
	});

	it('applies the SES branch, which has no pre-apply handshake to run', async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			message: 'Applied.',
			applied: true,
			requiresRestart: false,
		}));
		vi.stubGlobal('$fetch', fetchMock);
		const wrapper = mountWizard();
		await openWizard(wrapper);
		await fillCredentials(wrapper, 'ses');
		await buttonByText(wrapper, 'Save credentials').trigger('click');
		await flushPromises();
		expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['/api/delivery/apply-transport']);
		expect(buttonByText(wrapper, 'Next').attributes('disabled')).toBeUndefined();
		wrapper.unmount();
	});

	it('does not strand the operator when the alignment probe throws', async () => {
		vi.mocked(runAlignmentProbe).mockRejectedValueOnce(new Error('malformed arm'));
		const wrapper = await walkToAlignment();
		await buttonByText(wrapper, 'Check alignment').trigger('click');
		await flushPromises();
		// Not pinned at "running": the button is live again, the step says so, and
		// a second attempt runs the real probe through to a verdict.
		expect(wrapper.text()).toContain('The check could not run');
		expect(buttonByText(wrapper, 'Check alignment').attributes('disabled')).toBeUndefined();
		await buttonByText(wrapper, 'Check alignment').trigger('click');
		await flushPromises();
		expect(wrapper.text()).toContain('indistinguishable to the receiver');
		expect(wrapper.text()).not.toContain('The check could not run');
		wrapper.unmount();
	});
});
