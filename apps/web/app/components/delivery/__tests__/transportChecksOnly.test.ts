// @vitest-environment happy-dom
/**
 * The transport page has ONE "Change provider" door (the editor). The guided
 * wizard is mounted there in checks-only mode: the provider is already
 * connected, so it walks the live send test, alignment and return path and
 * never offers a second way to enter credentials.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { armsFixture, buttonByText, mountWizard, type WizardWrapper } from './wizardHarness';

let wrapper: WizardWrapper | null = null;

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

async function openChecks(): Promise<WizardWrapper> {
	wrapper = mountWizard({
		checksOnly: true,
		alignmentArms: armsFixture(),
		returnPathTransportId: 'ses',
		returnPathCapability: 'unknown',
	});
	await buttonByText(wrapper, 'Run the checks').trigger('click');
	await flushPromises();
	return wrapper;
}

describe('the connection checks on the transport page', () => {
	it('offers checks, not a second way to connect a provider', () => {
		wrapper = mountWizard({ checksOnly: true });
		expect(wrapper.text()).toContain('Check the connection');
		expect(wrapper.text()).not.toContain('Connect an email provider');
		expect(wrapper.findAll('button').some((b) => b.text().trim() === 'Connect a provider')).toBe(
			false
		);
		// Collapsed, it adds nothing below the header — no skip note, no nag.
		expect(wrapper.text()).not.toContain('Sending through your own server only');
	});

	it('starts at the live send test and never shows a credentials step', async () => {
		const opened = await openChecks();
		expect(opened.find('h3').text()).toBe('Live send test');
		const rail = opened.find('ol').text();
		expect(rail).not.toContain('Credentials');
		expect(opened.findAll('ol li')).toHaveLength(3);
		expect(opened.find('input[type="password"]').exists()).toBe(false);
	});

	it('cannot step back into the credentials it skipped', async () => {
		const opened = await openChecks();
		expect(buttonByText(opened, 'Back').attributes('disabled')).toBeDefined();
		await opened.find('.test-pass').trigger('click');
		await buttonByText(opened, 'Next').trigger('click');
		expect(opened.find('h3').text()).toBe('SPF, DKIM & DMARC alignment');
		await buttonByText(opened, 'Back').trigger('click');
		expect(opened.find('h3').text()).toBe('Live send test');
		expect(buttonByText(opened, 'Back').attributes('disabled')).toBeDefined();
	});

	it('announces its position among the three checks', async () => {
		const opened = await openChecks();
		expect(opened.find('[aria-live="polite"]').text()).toBe('Step 1 of 3: Live send test');
	});
});
