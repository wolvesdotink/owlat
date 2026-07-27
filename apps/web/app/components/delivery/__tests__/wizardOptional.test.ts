// @vitest-environment happy-dom
/**
 * D2 — THE ADDITIVE-ONLY THIRD-PARTY RULE, as a test.
 *
 * Never connecting a transport must leave the deployment fully functional and
 * every delivery screen CLEAN: no warning, no error, no "setup incomplete"
 * state, no unresolvable nag. The entry point has to read as a choice.
 *
 * This is the piece's highest-value regression guard, so it is asserted three
 * ways: on the contract value the UI is built from, on the wizard's own rendered
 * entry card, and on the delivery readiness vocabulary that decides whether a
 * screen shows a gate at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	TRANSPORT_WIZARD_ENTRY,
	returnPathFinding,
	skippingWizardImpact,
} from '~/utils/transportWizard';
import { buttonByText, mountWizard } from './wizardHarness';

/** Words that would turn an offer into a chore. None may appear on the card. */
const NAG_VOCABULARY = [
	'incomplete',
	'required',
	'must ',
	'missing',
	'error',
	'warning',
	'action needed',
	'finish setup',
	'not configured',
];

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('connecting a transport is optional (D2)', () => {
	it('states, in one place, that skipping changes nothing', () => {
		const impact = skippingWizardImpact();
		expect(impact.blocksSend).toBe(false);
		expect(impact.blocksPhasePromotion).toBe(false);
		expect(impact.rendersError).toBe(false);
		expect(impact.rendersWarning).toBe(false);
		expect(impact.marksSetupIncomplete).toBe(false);
	});

	it('offers the flow rather than demanding it', () => {
		expect(TRANSPORT_WIZARD_ENTRY.tone).toBe('offer');
		expect(TRANSPORT_WIZARD_ENTRY.isOptional).toBe(true);
		expect(TRANSPORT_WIZARD_ENTRY.dismissLabel).toBe('Not now');
	});

	it('renders the collapsed entry point with no warning, error or nag vocabulary', () => {
		const wrapper = mountWizard({ alignmentArms: null, returnPathCapability: null });
		const text = wrapper.text().toLowerCase();
		for (const word of NAG_VOCABULARY) {
			expect(text).not.toContain(word);
		}
		expect(wrapper.find('[role="alert"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('(optional)');
		expect(wrapper.text()).toContain('Sending through your own server only');
		wrapper.unmount();
	});

	it('keeps the entry point dismissible and re-openable, leaving no residue', async () => {
		const wrapper = mountWizard();
		await buttonByText(wrapper, 'Connect a provider').trigger('click');
		expect(wrapper.text()).toContain('Provider');
		await buttonByText(wrapper, 'Not now').trigger('click');
		const text = wrapper.text().toLowerCase();
		for (const word of NAG_VOCABULARY) {
			expect(text).not.toContain(word);
		}
		expect(buttonByText(wrapper, 'Connect a provider').exists()).toBe(true);
		wrapper.unmount();
	});

	it('describes an unprobed return path as "not established", never as a problem', () => {
		const row = returnPathFinding('unknown');
		expect(row.status).toBe('info');
		expect(row.remedy).toBeNull();
		expect(row.detail).toContain('Nothing is blocked');
	});

	it('describes a relay that rewrites the bounce address as lower confidence only', () => {
		const row = returnPathFinding('unsupported');
		expect(row.status).toBe('info');
		expect(row.remedy).toBeNull();
		expect(row.detail).toContain('Sending is unaffected');
	});
});
