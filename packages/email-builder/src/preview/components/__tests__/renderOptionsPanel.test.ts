// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import RenderOptionsPanel from '../RenderOptionsPanel.vue';
import type { PreviewRenderOptions } from '../../types';

/**
 * The render options panel edits one options set across its sections (basic
 * fields, the Advanced and Variable Values accordions) and sends the whole set
 * out on every change.
 */
let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

const mountPanel = (options: Partial<PreviewRenderOptions> = {}) => {
	wrapper = mount(RenderOptionsPanel, { props: { options } });
	return wrapper;
};

const lastOptions = (w: VueWrapper) =>
	w.emitted<[Partial<PreviewRenderOptions>]>('update:options')?.at(-1)?.[0];

const accordion = (w: VueWrapper, title: string) =>
	w.findAll('.ep-settings-accordion-header').find((h) => h.text().startsWith(title))!;

describe('RenderOptionsPanel', () => {
	it('sends the basic fields with the defaults of the rest', async () => {
		const w = mountPanel({ baseWidth: 640 });
		const rtl = w.findAll('.ep-settings-toggle').find((b) => b.text() === 'RTL')!;
		await rtl.trigger('click');
		expect(lastOptions(w)).toEqual({
			baseWidth: 640,
			breakpoint: 480,
			direction: 'rtl',
			minify: false,
			inlineCss: true,
			validationLevel: 'soft',
			lang: 'en',
			customCss: undefined,
			fontUrls: undefined,
			preheaderText: undefined,
			title: undefined,
			variableValues: undefined,
		});
		await w.findAll('.ep-settings-checkbox')[0]!.trigger('click');
		expect(lastOptions(w)).toMatchObject({ minify: true });
	});

	it('opens Advanced on demand and sends its fields and font URLs', async () => {
		const w = mountPanel({ fontUrls: ['https://fonts.example.com/a.css'] });
		expect(w.find('.ep-settings-select').exists()).toBe(false);
		await accordion(w, 'Advanced').trigger('click');

		const select = w.find<HTMLSelectElement>('.ep-settings-select');
		await select.setValue('strict');
		expect(lastOptions(w)).toMatchObject({
			validationLevel: 'strict',
			fontUrls: ['https://fonts.example.com/a.css'],
		});

		await w.find('.ep-settings-list-add').trigger('click');
		const urls = w.findAll<HTMLInputElement>('.ep-settings-list-item input');
		expect(urls).toHaveLength(2);
		await urls[1]!.setValue('https://fonts.example.com/b.css');
		await urls[1]!.trigger('change');
		expect(lastOptions(w)?.fontUrls).toEqual([
			'https://fonts.example.com/a.css',
			'https://fonts.example.com/b.css',
		]);

		await w.findAll('.ep-settings-list-item .ep-settings-list-remove')[0]!.trigger('click');
		expect(lastOptions(w)?.fontUrls).toEqual(['https://fonts.example.com/b.css']);

		await accordion(w, 'Advanced').trigger('click');
		expect(w.find('.ep-settings-select').exists()).toBe(false);
	});

	it('counts and sends variable values, skipping rows without a name', async () => {
		const w = mountPanel({ variableValues: { firstName: 'Alex' } });
		const header = accordion(w, 'Variable Values');
		expect(header.find('.ep-settings-accordion-count').text()).toBe('1');
		await header.trigger('click');

		await w.find('.ep-settings-list-add').trigger('click');
		expect(header.find('.ep-settings-accordion-count').text()).toBe('2');
		const keys = w.findAll<HTMLInputElement>('.ep-settings-kv-key');
		const values = w.findAll<HTMLInputElement>('.ep-settings-kv-value');
		await values[1]!.setValue('unnamed');
		await values[1]!.trigger('change');
		expect(lastOptions(w)?.variableValues).toEqual({ firstName: 'Alex' });

		await keys[1]!.setValue('company');
		await keys[1]!.trigger('change');
		expect(lastOptions(w)?.variableValues).toEqual({ firstName: 'Alex', company: 'unnamed' });

		await w.findAll('.ep-settings-kv-row .ep-settings-list-remove')[0]!.trigger('click');
		expect(lastOptions(w)?.variableValues).toEqual({ company: 'unnamed' });
	});

	it('follows the host for width, direction and minify', async () => {
		const w = mountPanel({ baseWidth: 600 });
		await w.setProps({ options: { baseWidth: 720, direction: 'rtl', minify: true } });
		const width = w.find<HTMLInputElement>('input[type="number"]');
		expect(width.element.value).toBe('720');
		const active = w.find('.ep-settings-toggle-active');
		expect(active.text()).toBe('RTL');
		expect(w.findAll('.ep-settings-checkbox')[0]!.classes()).toContain(
			'ep-settings-checkbox-active'
		);
	});

	it('closes from its header', async () => {
		const w = mountPanel();
		await w.find('.ep-settings-close').trigger('click');
		expect(w.emitted('close')).toHaveLength(1);
	});
});
