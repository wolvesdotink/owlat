// @vitest-environment happy-dom
/**
 * The step inspector's placements (#1046): a column at `lg`, a sheet below.
 * As a sheet it follows UiRailDrawer: Escape and the scrim close it (through
 * the page's `close`, which waits for the step's save), the phone's tab bar
 * steps aside, and focus moves into it when it opens.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import StepEditorPanel from '../StepEditorPanel.vue';

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });

const STEP = { _id: 'st_2', stepType: 'delay', config: '{}' };
const OTHER = { _id: 'st_1', stepType: 'email', config: '{}' };

let setOpen: ReturnType<typeof vi.fn>;

function mountPanel({ wide, saveStatus = 'saved' }: { wide: boolean; saveStatus?: string }) {
	setOpen = vi.fn();
	vi.stubGlobal('useMediaQuery', () => ref(wide));
	vi.stubGlobal('useRailDrawer', () => ({ isOpen: ref(false), setOpen }));
	return mount(StepEditorPanel as never, {
		attachTo: document.body,
		props: {
			selectedStep: STEP,
			saveStatus,
			emailTemplates: [],
			currentConfig: { kind: 'delay', config: { duration: 2, unit: 'days' } },
			mutableSteps: [OTHER, STEP],
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				UiButton: { template: '<button type="button"><slot /></button>' },
				AutomationsStepSaveStatus: {
					props: ['status', 'live'],
					template: '<div data-testid="save-line" :data-status="status" />',
				},
			},
		},
	});
}

describe('step inspector placement', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	it('titles the sheet with the step number and kind', () => {
		const wrapper = mountPanel({ wide: false });
		const header = wrapper.get('header');
		expect(header.text()).toContain('Step 2');
		expect(header.text()).toContain('Wait/delay');
		wrapper.unmount();
	});

	it('pins the save line to the bottom of the inspector', () => {
		const wrapper = mountPanel({ wide: false, saveStatus: 'error' });
		expect(wrapper.get('footer [data-testid="save-line"]').attributes('data-status')).toBe('error');
		wrapper.unmount();
	});

	it('as a sheet: Back, Escape and the scrim all ask the page to close it', async () => {
		const wrapper = mountPanel({ wide: false });
		await wrapper.get('button[aria-label="Back"]').trigger('click');
		await wrapper.get('[data-testid="step-panel"]').trigger('keydown', { key: 'Escape' });
		await wrapper.get('[data-testid="step-panel-scrim"]').trigger('click');
		expect(wrapper.emitted('close')).toHaveLength(3);
		wrapper.unmount();
	});

	it('leaves an Escape a menu inside the sheet already claimed', async () => {
		const wrapper = mountPanel({ wide: false });
		const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		event.preventDefault();
		wrapper.get('[data-testid="step-panel"]').element.dispatchEvent(event);
		expect(wrapper.emitted('close')).toBeUndefined();
		wrapper.unmount();
	});

	it('as a sheet: hides the tab bar while open and moves focus into it', async () => {
		const wrapper = mountPanel({ wide: false });
		await flushPromises();
		expect(setOpen).toHaveBeenCalledWith(true);
		expect(wrapper.get('[data-testid="step-panel"]').element.contains(document.activeElement)).toBe(
			true
		);
		wrapper.unmount();
		expect(setOpen).toHaveBeenLastCalledWith(false);
	});

	it('as a column: no scrim, Escape stays with the page, focus stays put', async () => {
		const wrapper = mountPanel({ wide: true });
		await flushPromises();
		expect(wrapper.find('[data-testid="step-panel-scrim"]').exists()).toBe(false);
		await wrapper.get('[data-testid="step-panel"]').trigger('keydown', { key: 'Escape' });
		expect(wrapper.emitted('close')).toBeUndefined();
		expect(setOpen).not.toHaveBeenCalledWith(true);
		expect(wrapper.get('[data-testid="step-panel"]').element.contains(document.activeElement)).toBe(
			false
		);
		wrapper.unmount();
	});
});
