// @vitest-environment happy-dom
//
// The leave dialog every page with unsaved edits shows: its copy follows the
// app's locale, and while a Save runs, Save shows progress and cannot be
// clicked again, Discard waits for it, and Cancel stays available.
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import UnsavedChangesDialog from '../components/ui/UnsavedChangesDialog.vue';
import { createUiI18n, type UiLocale } from './i18n';

/** The modal's own chrome is not under test; render its title and slots in place. */
const ModalStub = defineComponent({
	props: { open: Boolean, title: { type: String, default: '' } },
	setup:
		(props, { slots }) =>
		() =>
			h('div', [
				h('h2', props.title),
				h('div', slots['default']?.()),
				h('footer', slots['footer']?.()),
			]),
});

const IconStub = defineComponent({ setup: () => () => h('i', { class: 'spinner' }) });

let wrappers: VueWrapper[] = [];
afterEach(() => {
	for (const w of wrappers) w.unmount();
	wrappers = [];
});

function render({ saving, locale = 'en' }: { saving?: boolean; locale?: UiLocale } = {}) {
	const wrapper = mount(UnsavedChangesDialog, {
		props: saving === undefined ? { show: true } : { show: true, saving },
		global: {
			plugins: [createUiI18n(locale)],
			stubs: { UiModal: ModalStub, Icon: IconStub },
		},
	});
	wrappers.push(wrapper);
	const button = (label: string) => {
		const match = wrapper.findAll('button').find((b) => b.text() === label);
		if (!match) throw new Error(`no ${label} button`);
		return match;
	};
	return { wrapper, button };
}

describe('UnsavedChangesDialog', () => {
	it('renders its copy in English', () => {
		const { wrapper } = render();
		expect(wrapper.get('h2').text()).toBe('Unsaved changes');
		expect(wrapper.get('p').text()).toBe(
			'You have unsaved changes. Do you want to save them before leaving?'
		);
		expect(wrapper.findAll('button').map((b) => b.text())).toEqual(['Discard', 'Cancel', 'Save']);
	});

	it('renders its copy in German', () => {
		const { wrapper } = render({ locale: 'de' });
		expect(wrapper.get('h2').text()).toBe('Ungespeicherte Änderungen');
		expect(wrapper.get('p').text()).toBe(
			'Du hast ungespeicherte Änderungen. Möchtest du sie speichern, bevor du gehst?'
		);
		expect(wrapper.findAll('button').map((b) => b.text())).toEqual([
			'Verwerfen',
			'Abbrechen',
			'Speichern',
		]);
	});

	it('offers every choice when no save is running', async () => {
		const { wrapper, button } = render();
		for (const label of ['Discard', 'Cancel', 'Save']) {
			expect(button(label).attributes('disabled')).toBeUndefined();
		}
		await button('Save').trigger('click');
		await button('Discard').trigger('click');
		await button('Cancel').trigger('click');
		expect(wrapper.emitted('save')).toHaveLength(1);
		expect(wrapper.emitted('discard')).toHaveLength(1);
		expect(wrapper.emitted('close')).toHaveLength(1);
	});

	it('locks Save and Discard while saving, and keeps Cancel', async () => {
		const { wrapper, button } = render({ saving: true });
		expect(button('Save').attributes('disabled')).toBeDefined();
		expect(button('Save').find('.spinner').exists()).toBe(true);
		expect(button('Discard').attributes('disabled')).toBeDefined();
		expect(button('Cancel').attributes('disabled')).toBeUndefined();

		await button('Save').trigger('click');
		await button('Discard').trigger('click');
		await button('Cancel').trigger('click');
		expect(wrapper.emitted('save')).toBeUndefined();
		expect(wrapper.emitted('discard')).toBeUndefined();
		expect(wrapper.emitted('close')).toHaveLength(1);
	});
});
