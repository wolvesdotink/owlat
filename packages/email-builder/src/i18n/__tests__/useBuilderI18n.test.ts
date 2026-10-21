// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import {
	hasMetaLabel,
	metaKey,
	translate,
	translateLabel,
	useBuilderI18n,
} from '../useBuilderI18n';
import { createHostI18n } from './hostI18n';

let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

/** Renders a keyed message, a plural and a registry label through the composable. */
const Probe = defineComponent({
	setup() {
		const { t, label, locale } = useBuilderI18n();
		return () =>
			h('p', [
				h('span', { class: 'locale' }, locale.value),
				h('span', { class: 'keyed' }, t('builder.header.back')),
				h('span', { class: 'plural' }, t('builder.diff.summary', { count: 2 })),
				h('span', { class: 'label' }, label('Font Size')),
			]);
	},
});

describe('translate', () => {
	it('interpolates named placeholders', () => {
		expect(translate('en', 'builder.subject.define', { key: 'orderId' })).toBe('Define orderId');
		expect(translate('de', 'builder.subject.define', { key: 'orderId' })).toBe('orderId anlegen');
	});

	it('picks the plural form from count', () => {
		expect(translate('en', 'builder.savedBlocks.blockCount', { count: 1 })).toBe('1 block');
		expect(translate('en', 'builder.savedBlocks.blockCount', { count: 3 })).toBe('3 blocks');
		expect(translate('de', 'builder.savedBlocks.blockCount', { count: 1 })).toBe('1 Block');
		expect(translate('de', 'builder.savedBlocks.blockCount', { count: 0 })).toBe('0 Blöcke');
	});

	it('shows an unknown key rather than nothing', () => {
		expect(translate('de', 'builder.does.not.exist')).toBe('builder.does.not.exist');
	});
});

describe('registry labels', () => {
	it('files English copy under its camel-cased words', () => {
		expect(metaKey('Font Size')).toBe('builder.meta.fontSize');
		expect(metaKey('Delete selected block (clears an image)')).toBe(
			'builder.meta.deleteSelectedBlockClearsAnImage'
		);
	});

	it('translates known registry copy and keeps English as written', () => {
		expect(translateLabel('de', 'Font Size')).toBe('Schriftgröße');
		expect(translateLabel('en', 'Font Size')).toBe('Font Size');
	});

	it('shows copy it does not know — a plugin block label — as written', () => {
		expect(hasMetaLabel('Callout')).toBe(false);
		expect(translateLabel('de', 'Callout')).toBe('Callout');
	});

	it('never borrows a translation for a different phrase that shares a slug', () => {
		// `Font-Size!` slugs like `Font Size` but is not the catalog's English text.
		expect(metaKey('Font-Size!')).toBe(metaKey('Font Size'));
		expect(translateLabel('de', 'Font-Size!')).toBe('Font-Size!');
	});
});

describe('useBuilderI18n', () => {
	it('renders English without a host vue-i18n (standalone mount)', () => {
		wrapper = mount(Probe);
		expect(wrapper.find('.locale').text()).toBe('en');
		expect(wrapper.find('.keyed').text()).toBe('Back');
		expect(wrapper.find('.label').text()).toBe('Font Size');
	});

	it('follows the host locale, region tags included', () => {
		wrapper = mount(Probe, { global: { plugins: [createHostI18n('de-DE')] } });
		expect(wrapper.find('.locale').text()).toBe('de');
		expect(wrapper.find('.keyed').text()).toBe('Zurück');
		expect(wrapper.find('.plural').text()).toBe('2 Änderungen erkannt');
		expect(wrapper.find('.label').text()).toBe('Schriftgröße');
	});

	it('falls back to English for a host language the builder does not ship', () => {
		wrapper = mount(Probe, { global: { plugins: [createHostI18n('fr')] } });
		expect(wrapper.find('.keyed').text()).toBe('Back');
	});

	it('re-renders when the host switches locale', async () => {
		const i18n = createHostI18n('en');
		wrapper = mount(Probe, { global: { plugins: [i18n] } });
		expect(wrapper.find('.keyed').text()).toBe('Back');

		i18n.global.locale.value = 'de';
		await nextTick();
		expect(wrapper.find('.keyed').text()).toBe('Zurück');
		expect(wrapper.find('.label').text()).toBe('Schriftgröße');
	});
});
