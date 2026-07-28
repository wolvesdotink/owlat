// @vitest-environment happy-dom
/**
 * FORCE-ADVANCE CANNOT FIRE FROM A SINGLE CLICK.
 *
 * The property under test is not "there is a warning" — it is that no sequence
 * of clicks alone reaches the mutation. The button opens a dialog; the dialog's
 * confirm stays disabled until the exact consequence-naming phrase has been
 * typed; and the phrase is the SAME constant the server checks, so a client that
 * skipped the dialog meets the identical rule.
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { FORCE_ADVANCE_CONFIRMATION } from '@owlat/shared/deliverabilityIndependence';
import RampCellControls from '../RampCellControls.vue';
import RampConfirmDialog from '../RampConfirmDialog.vue';
import { cellControl } from './rampFixtures';

describe('force-advance control', () => {
	it('emits an INTENT, never a write, and names the consequence beside the button', async () => {
		const wrapper = mount(RampCellControls, { props: { cell: cellControl() } });
		await wrapper.find('[data-testid="ramp-control-force-advance"]').trigger('click');
		// The component asks; it never writes. The page turns this into a dialog.
		expect(wrapper.emitted('forceAdvance')).toHaveLength(1);
		const warning = wrapper.find('[data-testid="ramp-force-advance-warning"]').text();
		expect(warning).toContain(FORCE_ADVANCE_CONFIRMATION);
		expect(warning).toContain('reputation');
		wrapper.unmount();
	});
});

function mountDialog(open = true) {
	return mount(RampConfirmDialog, {
		props: {
			open,
			title: 'Force this cell past the evidence?',
			phrase: FORCE_ADVANCE_CONFIRMATION,
			confirmLabel: 'Force-advance',
		},
		slots: { consequence: '<p>This moves campaign mail to gmail to 80%.</p>' },
	});
}

describe('the consequence-naming confirmation', () => {
	it('keeps confirm disabled until the exact phrase is typed', async () => {
		const wrapper = mountDialog();
		const submit = wrapper.find('[data-testid="ramp-confirm-submit"]');
		expect(submit.attributes('disabled')).toBeDefined();

		await wrapper.find('[data-testid="ramp-confirm-input"]').setValue('yes');
		expect(
			wrapper.find('[data-testid="ramp-confirm-submit"]').attributes('disabled')
		).toBeDefined();
		await submit.trigger('click');
		expect(wrapper.emitted('confirm')).toBeUndefined();

		await wrapper.find('[data-testid="ramp-confirm-input"]').setValue(FORCE_ADVANCE_CONFIRMATION);
		expect(
			wrapper.find('[data-testid="ramp-confirm-submit"]').attributes('disabled')
		).toBeUndefined();
		await wrapper.find('[data-testid="ramp-confirm-submit"]').trigger('click');
		expect(wrapper.emitted('confirm')?.[0]).toEqual([FORCE_ADVANCE_CONFIRMATION]);
		wrapper.unmount();
	});

	it('states the consequence, not a generic caution', () => {
		const wrapper = mountDialog();
		expect(wrapper.text()).toContain('campaign mail to gmail');
		expect(wrapper.text()).not.toMatch(/this action cannot be undone\.?$/i);
		wrapper.unmount();
	});

	it('is a labelled modal dialog with the input tied to its label', () => {
		const wrapper = mountDialog();
		const dialog = wrapper.find('[role="dialog"]');
		expect(dialog.attributes('aria-modal')).toBe('true');
		expect(dialog.attributes('aria-labelledby')).toBeTruthy();
		expect(dialog.attributes('aria-describedby')).toBeTruthy();
		const input = wrapper.find('input');
		const label = wrapper.find(`label[for="${input.attributes('id')}"]`);
		expect(label.exists()).toBe(true);
		wrapper.unmount();
	});

	it('clears a typed phrase when it closes, so the next open is not one click away', async () => {
		const wrapper = mountDialog();
		await wrapper.find('[data-testid="ramp-confirm-input"]').setValue(FORCE_ADVANCE_CONFIRMATION);
		await wrapper.setProps({ open: false });
		await wrapper.setProps({ open: true });
		expect(wrapper.find<HTMLInputElement>('[data-testid="ramp-confirm-input"]').element.value).toBe(
			''
		);
		expect(
			wrapper.find('[data-testid="ramp-confirm-submit"]').attributes('disabled')
		).toBeDefined();
		wrapper.unmount();
	});
});
