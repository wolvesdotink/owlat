// @vitest-environment happy-dom
/**
 * Accessibility pass on the multi-step form (P2-4).
 *
 * A multi-step form is where keyboard and screen-reader users get stranded: the
 * page does not navigate, so nothing announces that the content changed and
 * focus stays wherever the previous step's button was. The four properties that
 * fix that are asserted here against the real mount:
 *
 *   - focus MOVES to the new step's heading on every transition, forward and
 *     back, and the heading is programmatically focusable;
 *   - the step rail marks the active step with `aria-current="step"`;
 *   - the position ("Step 2 of 4: …") is in a polite live region;
 *   - every credential input is associated with a visible label, and errors are
 *     announced rather than merely coloured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import WizardFindingRow from '../WizardFindingRow.vue';
import {
	buttonByText,
	chooseProvider,
	fillCredentials,
	mountWizard,
	openWizard,
	wizardStubs,
	type WizardWrapper,
} from './wizardHarness';

beforeEach(() => {
	vi.stubGlobal(
		'$fetch',
		vi.fn(async () => ({ ok: true, message: 'Applied.', applied: true, requiresRestart: false }))
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function openAndPassCredentials(): Promise<WizardWrapper> {
	const wrapper = mountWizard({ returnPathCapability: 'supported' });
	await openWizard(wrapper);
	await fillCredentials(wrapper, 'resend', 're_live_secret');
	await buttonByText(wrapper, 'Save credentials').trigger('click');
	await flushPromises();
	return wrapper;
}

describe('transport wizard — accessibility', () => {
	it('marks exactly one step as the current step', async () => {
		const wrapper = mountWizard();
		await openWizard(wrapper);
		const current = wrapper.findAll('[aria-current="step"]');
		expect(current).toHaveLength(1);
		expect(current[0]!.text()).toContain('Credentials');
		wrapper.unmount();
	});

	it('announces the position in a polite live region', async () => {
		const wrapper = mountWizard();
		await openWizard(wrapper);
		const live = wrapper.find('[aria-live="polite"]');
		expect(live.exists()).toBe(true);
		expect(live.text()).toBe('Step 1 of 4: Credentials');
		wrapper.unmount();
	});

	it('moves focus to the new step heading going forward AND going back', async () => {
		const wrapper = await openAndPassCredentials();
		await buttonByText(wrapper, 'Next').trigger('click');
		await flushPromises();
		const heading = wrapper.find('h3');
		expect(heading.attributes('tabindex')).toBe('-1');
		expect(heading.text()).toBe('Live send test');
		expect(document.activeElement).toBe(heading.element);

		await buttonByText(wrapper, 'Back').trigger('click');
		await flushPromises();
		const back = wrapper.find('h3');
		expect(back.text()).toBe('Credentials');
		expect(document.activeElement).toBe(back.element);
		wrapper.unmount();
	});

	it.each(['resend', 'ses', 'smtp'] as const)(
		'labels every credential input on the %s branch',
		async (kind) => {
			const wrapper = mountWizard();
			await openWizard(wrapper);
			await chooseProvider(wrapper, kind);
			const inputs = wrapper.findAll('input[type="password"], input[type="text"]');
			// The assertion that makes the loop mean something: a branch that renders
			// nothing would otherwise "pass" by iterating an empty list.
			expect(inputs.length).toBeGreaterThan(0);
			for (const input of inputs) {
				const id = input.attributes('id');
				expect(id).toBeTruthy();
				expect(wrapper.find(`label[for="${id}"]`).exists()).toBe(true);
			}
			for (const select of wrapper.findAll('select')) {
				const id = select.attributes('id');
				expect(id).toBeTruthy();
				expect(wrapper.find(`label[for="${id}"]`).exists()).toBe(true);
			}
			// The provider radios are wrapped in their own labels.
			expect(wrapper.findAll('input[type="radio"]').length).toBe(3);
			for (const radio of wrapper.findAll('input[type="radio"]')) {
				expect(radio.element.closest('label')).not.toBeNull();
			}
			wrapper.unmount();
		}
	);

	it('moves focus onto the flow when it opens, and back to the entry action when dismissed', async () => {
		const wrapper = mountWizard();
		const entry = buttonByText(wrapper, 'Connect a provider');
		await entry.trigger('click');
		await flushPromises();
		// The button that was activated no longer exists; focus must not fall to
		// <body>, so the first step's heading takes it.
		const heading = wrapper.find('h3');
		expect(heading.text()).toBe('Credentials');
		expect(document.activeElement).toBe(heading.element);

		await buttonByText(wrapper, 'Not now').trigger('click');
		await flushPromises();
		expect(document.activeElement).toBe(buttonByText(wrapper, 'Connect a provider').element);
		wrapper.unmount();
	});

	it.each([
		['fail' as const, 'Needs a change:'],
		['pass' as const, 'Passed:'],
		['unknown' as const, 'Not known:'],
		['info' as const, 'For information:'],
	])('speaks the %s status rather than conveying it by colour alone', (status, spoken) => {
		const row = mount(WizardFindingRow, {
			props: { finding: { id: 'spf', label: 'SPF', status, detail: 'detail', remedy: null } },
			global: { stubs: wizardStubs },
		});
		const hidden = row.find('.sr-only');
		expect(hidden.exists()).toBe(true);
		expect(hidden.text()).toBe(spoken);
		// The glyph is decoration, and a screen reader must not read it as content.
		expect(row.find('i').attributes('aria-hidden')).toBe('true');
		row.unmount();
	});

	it('announces an apply failure instead of only colouring it', async () => {
		vi.stubGlobal(
			'$fetch',
			vi.fn(async () => ({
				ok: false,
				message: 'The provider rejected the key.',
				applied: false,
				requiresRestart: false,
			}))
		);
		const wrapper = await openAndPassCredentials();
		const alert = wrapper.find('[role="alert"]');
		expect(alert.exists()).toBe(true);
		expect(alert.text()).toContain('The provider rejected the key.');
		wrapper.unmount();
	});
});
