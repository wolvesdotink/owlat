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
import { config, mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { FORCE_ADVANCE_CONFIRMATION } from '@owlat/shared/deliverabilityIndependence';
import RampCellControls from '../RampCellControls.vue';
import RampConfirmDialog from '../RampConfirmDialog.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { cellControl } from './rampFixtures';

// The copy on these components flows through vue-i18n now; `useI18n` is a Nuxt
// auto-import, so it has to exist as a bare global for their setup.
beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	config.global.plugins = [...(config.global.plugins ?? []), createTestI18n()];
});

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

	/**
	 * THE DESTRUCTIVE CONTROL MUST NOT CARRY A NUMBER ACROSS CELLS. The page
	 * mounts this component inside a `v-if`, so Vue reuses the instance when the
	 * operator picks a different cell — and a share proposed for the cell they
	 * were looking at a moment ago is exactly the wrong default for this one.
	 */
	it('resyncs its number inputs when the selected cell changes', async () => {
		const wrapper = mount(RampCellControls, {
			props: { cell: cellControl({ ownShare: 0.25, pinnedShare: 0.4 }) },
		});
		expect(
			wrapper.find<HTMLInputElement>('[data-testid="ramp-control-force-input"]').element.value
		).toBe('25');
		await wrapper.setProps({
			cell: cellControl({
				cellKey: 'campaign:yahoo',
				cell: { stream: 'campaign', destinationProvider: 'yahoo' },
				ownShare: 0.8,
				pinnedShare: null,
			}),
		});
		expect(
			wrapper.find<HTMLInputElement>('[data-testid="ramp-control-force-input"]').element.value
		).toBe('80');
		expect(
			wrapper.find<HTMLInputElement>('[data-testid="ramp-control-pin-input"]').element.value
		).toBe('80');
		// And the intent it emits is the NEW cell's share, not the old one's.
		await wrapper.find('[data-testid="ramp-control-force-advance"]').trigger('click');
		expect(wrapper.emitted('forceAdvance')?.[0]).toEqual([0.8]);
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

	/**
	 * `aria-modal` IS A PROMISE ABOUT THE KEYBOARD. A destructive confirmation a
	 * keyboard user can tab out of without noticing is not a confirmation.
	 */
	it('moves focus into the phrase input when it opens', async () => {
		const wrapper = mount(RampConfirmDialog, {
			props: {
				open: false,
				title: 'Force this cell past the evidence?',
				phrase: FORCE_ADVANCE_CONFIRMATION,
				confirmLabel: 'Force-advance',
			},
			slots: { consequence: '<p>Consequence.</p>' },
			attachTo: document.body,
		});
		await wrapper.setProps({ open: true });
		await nextTick();
		expect(document.activeElement).toBe(wrapper.find('[data-testid="ramp-confirm-input"]').element);
		wrapper.unmount();
	});

	it('cancels on Escape', async () => {
		const wrapper = mountDialog();
		await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'Escape' });
		expect(wrapper.emitted('cancel')).toHaveLength(1);
		wrapper.unmount();
	});

	it('keeps Tab inside the dialog', async () => {
		const wrapper = mount(RampConfirmDialog, {
			props: {
				open: true,
				title: 'Force this cell past the evidence?',
				phrase: FORCE_ADVANCE_CONFIRMATION,
				confirmLabel: 'Force-advance',
			},
			slots: { consequence: '<p>Consequence.</p>' },
			attachTo: document.body,
		});
		await nextTick();
		// Enabled nodes only — the confirm button is disabled until the phrase is
		// typed, and a trap that wrapped onto a node the browser will not focus
		// would drop focus on the document instead.
		const nodes = wrapper.findAll('input:not([disabled]), button:not([disabled])');
		const first = nodes[0]?.element as HTMLElement | undefined;
		const last = nodes[nodes.length - 1]?.element as HTMLElement | undefined;
		expect(first).toBeDefined();
		expect(last).toBeDefined();
		// Backwards off the first node wraps to the last, rather than escaping to
		// the page behind the overlay.
		first?.focus();
		await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'Tab', shiftKey: true });
		expect(document.activeElement).toBe(last);
		wrapper.unmount();
	});

	it('gives focus back to whatever opened it', async () => {
		const opener = document.createElement('button');
		document.body.appendChild(opener);
		opener.focus();
		const wrapper = mount(RampConfirmDialog, {
			props: {
				open: false,
				title: 'Force this cell past the evidence?',
				phrase: FORCE_ADVANCE_CONFIRMATION,
				confirmLabel: 'Force-advance',
			},
			slots: { consequence: '<p>Consequence.</p>' },
			attachTo: document.body,
		});
		await wrapper.setProps({ open: true });
		await nextTick();
		await wrapper.setProps({ open: false });
		await nextTick();
		expect(document.activeElement).toBe(opener);
		wrapper.unmount();
		opener.remove();
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
