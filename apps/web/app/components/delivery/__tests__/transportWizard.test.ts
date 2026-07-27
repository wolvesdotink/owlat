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
	isWizardComplete,
	returnPathStepStatus,
	setStepStatus,
	stepAt,
	stepIndex,
	type TransportWizardState,
} from '~/utils/transportWizard';
import {
	ALIGNED_DNS,
	OWN_ARM,
	buttonByText,
	mountWizard,
	openWizard,
	referenceArm,
	stubDoh,
} from './wizardHarness';

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
		const state = setStepStatus(createTransportWizardState(), 'return_path', 'unknown');
		expect(isWizardComplete(pass(state, 'credentials', 'test_send', 'alignment'))).toBe(true);
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
			alignmentArms: { ownArm: OWN_ARM, reference: referenceArm() },
			returnPathCapability: 'supported',
		});
		await openWizard(wrapper);
		await wrapper.find('#field-resend-api-key').setValue('re_live_secret');
		await buttonByText(wrapper, 'Save credentials').trigger('click');
		await flushPromises();
		await buttonByText(wrapper, 'Next').trigger('click');
		await wrapper.find('.test-pass').trigger('click');
		await buttonByText(wrapper, 'Next').trigger('click');
		return wrapper;
	}

	it('walks credentials → test send → alignment → return path', async () => {
		const wrapper = await walkToAlignment();
		expect(wrapper.text()).toContain('SPF, DKIM & DMARC alignment');
		await buttonByText(wrapper, 'Check alignment').trigger('click');
		await flushPromises();
		expect(wrapper.text()).toContain('indistinguishable to the receiver');
		await buttonByText(wrapper, 'Next').trigger('click');
		expect(wrapper.text()).toContain('Return path');
		// The last step has no Next; it offers Done instead.
		expect(wrapper.findAll('button').some((b) => b.text().trim() === 'Next')).toBe(false);
		expect(buttonByText(wrapper, 'Done').exists()).toBe(true);
		wrapper.unmount();
	});

	it('holds on a failed live send test and releases once it passes', async () => {
		const wrapper = mountWizard({ returnPathCapability: 'unknown' });
		await openWizard(wrapper);
		await wrapper.find('#field-resend-api-key').setValue('re_live_secret');
		await buttonByText(wrapper, 'Save credentials').trigger('click');
		await flushPromises();
		await buttonByText(wrapper, 'Next').trigger('click');
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
		expect(wrapper.text()).toContain('Live send test');
		await buttonByText(wrapper, 'Next').trigger('click');
		// The alignment findings survived the round trip — no re-run required.
		expect(wrapper.text()).toContain('One SPF record authorizes both arms');
		wrapper.unmount();
	});

	it('surfaces a failed credential apply without advancing', async () => {
		vi.stubGlobal(
			'$fetch',
			vi.fn(async () => ({
				ok: false,
				message: 'The provider rejected the key.',
				applied: false,
				requiresRestart: false,
			}))
		);
		const wrapper = mountWizard();
		await openWizard(wrapper);
		await wrapper.find('#field-resend-api-key').setValue('re_live_secret');
		await buttonByText(wrapper, 'Save credentials').trigger('click');
		await flushPromises();
		expect(wrapper.text()).toContain('The provider rejected the key.');
		expect(buttonByText(wrapper, 'Next').attributes('disabled')).toBeDefined();
		wrapper.unmount();
	});
});
